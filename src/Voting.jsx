import React, { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { Vote, Timer, Volume2, VolumeX, Skull, Trophy, Frown, X, Check, SkipForward, Ban, Flag } from 'lucide-react';

// ---------------------------------------------------------------------------
// Sound + vibration
// ---------------------------------------------------------------------------
let audioCtx;
function ctx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}
function beep(freq = 880, dur = 0.12, vol = 0.2) {
  const c = ctx(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'square'; o.frequency.value = freq; g.gain.value = vol;
  o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + dur);
}
const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

// Browsers only allow sound after a tap, so unlock audio on the first touch anywhere.
export function useSound() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem('traitors_sound') !== 'off'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('traitors_sound', on ? 'on' : 'off'); } catch {} }, [on]);
  useEffect(() => {
    const unlock = () => ctx();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);
  return { on, setOn };
}

function SoundToggle({ sound }) {
  return (
    <button className="sound-toggle" onClick={() => { sound.setOn(!sound.on); if (!sound.on) beep(660, 0.08, 0.15); }} aria-pressed={sound.on} aria-label={sound.on ? 'Turn sound off' : 'Turn sound on'}>
      {sound.on ? <Volume2 size={16} /> : <VolumeX size={16} />}<span>Sound {sound.on ? 'on' : 'off'}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Countdown: red alert + vibration + beeps for the last 10 seconds
// ---------------------------------------------------------------------------
function VoteTimer({ vote, skewRef, sound }) {
  const calc = () => vote.endsAt - (Date.now() + skewRef.current);
  const [left, setLeft] = useState(calc);
  const prevSec = useRef(null);
  useEffect(() => { setLeft(calc()); const id = setInterval(() => setLeft(calc()), 200); return () => clearInterval(id); }, [vote.id, vote.endsAt]);

  const sec = Math.max(0, Math.ceil(left / 1000));
  const alert = sec <= 10;
  useEffect(() => {
    const prev = prevSec.current; prevSec.current = sec;
    if (prev === sec) return;
    if (sec > 0 && sec <= 10) {
      buzz(sec <= 3 ? [250, 80, 250] : 120);
      if (sound.on) beep(sec <= 3 ? 1200 : 880, 0.12);
    } else if (sec === 0 && prev !== null) {
      buzz([600, 120, 600, 120, 600]);
      if (sound.on) { beep(300, 0.7, 0.3); }
    }
  }, [sec, sound.on]);

  const pct = Math.max(0, Math.min(100, (left / (vote.duration * 1000)) * 100));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0'), ss = String(sec % 60).padStart(2, '0');
  return (
    <>
      {alert && sec > 0 && <div className="alert-flash" aria-hidden="true" />}
      <div className={'vote-timer' + (alert ? ' alert' : '')} role="timer">
        <div className="vote-time"><Timer size={26} /> {mm}:{ss}</div>
        <div className="vote-bar"><i style={{ width: pct + '%' }} /></div>
        {alert && <div className="vote-hurry">{sec > 0 ? 'HURRY, VOTE NOW' : 'TIME IS UP'}</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Host controls
// ---------------------------------------------------------------------------
const PRESETS = [30, 60, 90, 120];
export function HostVotePanel({ gameState, onStart, onEnd, onCancel, skewRef, sound }) {
  const [secs, setSecs] = useState(60);
  const [busy, setBusy] = useState(false);
  const v = gameState.vote;
  const run = async (fn) => { if (busy) return; setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const over = !!gameState.winner;

  return (
    <div className="brutalist-card vote-card">
      <div className="card-title"><Vote size={22} /><span>Voting</span></div>
      {gameState.round === 0 ? (
        <p className="vote-note">Deal roles first, then start a vote.</p>
      ) : v ? (
        <>
          <VoteTimer vote={v} skewRef={skewRef} sound={sound} />
          <p className="vote-note"><strong>{v.voted}/{v.eligible}</strong> alive players have voted.</p>
          <div className="vote-row">
            <button className="brutalist-btn" disabled={busy} onClick={() => run(onEnd)}><Check size={16} /><span>End vote now</span></button>
            <button className="brutalist-btn brutalist-btn-dark" disabled={busy} onClick={() => run(onCancel)}><Ban size={16} /><span>Cancel</span></button>
          </div>
        </>
      ) : over ? (
        <p className="vote-note">The game is over. Shuffle to start a new one, or revive a player if you marked someone dead by mistake.</p>
      ) : (
        <>
          <label className="field-label">Voting time</label>
          <div className="vote-presets">
            {PRESETS.map((p) => (
              <button key={p} className={'chip-btn' + (secs === p ? ' on' : '')} onClick={() => setSecs(p)}>{p < 60 ? `${p}s` : `${p / 60}m${p % 60 ? ' 30s' : ''}`}</button>
            ))}
          </div>
          <div className="vote-custom">
            <input type="number" className="brutalist-input" min={10} max={600} value={secs} inputMode="numeric"
              onChange={(e) => setSecs(Math.max(0, Math.min(600, parseInt(e.target.value, 10) || 0)))} aria-label="Custom seconds" />
            <span>seconds (10 to 600)</span>
          </div>
          <button className="brutalist-btn" disabled={busy || secs < 10} onClick={() => run(() => onStart(secs))}><Vote size={18} /><span>Start voting</span></button>
        </>
      )}
      <SoundToggle sound={sound} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Player voting
// ---------------------------------------------------------------------------
export function PlayerVotePanel({ gameState, onVote, skewRef, sound }) {
  const v = gameState.vote;
  if (gameState.youDead && !v) {
    return <div className="brutalist-card dead-banner"><Skull size={22} /><span>You have been eliminated. You can still watch, but you can't vote.</span></div>;
  }
  if (!v) return null;
  const targets = (gameState.players || []).filter((p) => !p.you && !p.dead);
  const canVote = gameState.hasRole && !gameState.youDead;
  return (
    <div className="brutalist-card vote-card">
      <div className="card-title"><Vote size={22} /><span>Vote now</span></div>
      <VoteTimer vote={v} skewRef={skewRef} sound={sound} />
      <p className="vote-note"><strong>{v.voted}/{v.eligible}</strong> have voted.</p>
      {!gameState.hasRole ? (
        <p className="vote-note">You joined after the deal, so you can't vote this round.</p>
      ) : gameState.youDead ? (
        <p className="vote-note dead-note"><Skull size={16} /> You're eliminated and can't vote.</p>
      ) : (
        <>
          <p className="vote-note">Tap a player to vote. You can change your vote until time runs out.</p>
          <div className="vote-targets">
            {targets.map((p) => (
              <button key={p.pid} className={'vote-target' + (gameState.myVote === p.pid ? ' picked' : '')} onClick={() => onVote(p.pid)}>
                <span>{p.name}</span>{gameState.myVote === p.pid && <Check size={18} />}
              </button>
            ))}
            <button className={'vote-target skip' + (gameState.myVote === 'skip' ? ' picked' : '')} onClick={() => onVote('skip')}>
              <span><SkipForward size={16} /> Skip (vote for nobody)</span>{gameState.myVote === 'skip' && <Check size={18} />}
            </button>
          </div>
        </>
      )}
      <SoundToggle sound={sound} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results (visible to everyone, host included)
// ---------------------------------------------------------------------------
export function VoteResults({ lastVote }) {
  if (!lastVote) return null;
  const { outcome, tally, skipped, notVoted } = lastVote;
  const top = Math.max(1, ...tally.map((t) => t.count));
  return (
    <div className="brutalist-card vote-card results">
      <div className="card-title"><Vote size={22} /><span>Vote results</span></div>
      <div className={'outcome ' + outcome.type}>
        {outcome.type === 'out' && <><Skull size={20} /> <strong>{outcome.name}</strong> was voted out.</>}
        {outcome.type === 'tie' && <>Tie between <strong>{outcome.names.join(' and ')}</strong>. Nobody is eliminated.</>}
        {outcome.type === 'none' && <>No votes were cast. Nobody is eliminated.</>}
      </div>
      {tally.map((t) => (
        <div key={t.pid} className="tally-row">
          <div className="tally-head"><span>{t.name}</span><b>{t.count}</b></div>
          <div className="tally-bar"><i style={{ width: (t.count / top) * 100 + '%' }} /></div>
          {t.voters.length > 0 && <div className="tally-voters">Voted by {t.voters.join(', ')}</div>}
        </div>
      ))}
      <div className="tally-foot">{skipped} skipped &bull; {notVoted} did not vote</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game over: win / lose popup for every member + a banner to reopen it
// ---------------------------------------------------------------------------
export function ResultGate({ gameState, isHost }) {
  const result = gameState?.result;
  const key = result ? `${gameState.round}-${result.winner}` : '';
  const [closedKey, setClosedKey] = useState('');
  const shown = useRef('');
  const open = !!result && closedKey !== key;

  useEffect(() => {
    if (!result || shown.current === key) return;
    shown.current = key;
    if (result.youWon) {
      buzz([200, 80, 200, 80, 400]);
      try { confetti({ particleCount: 140, spread: 90, origin: { y: 0.55 } }); } catch {}
    } else if (result.youWon === false) buzz([400, 150, 400]);
  }, [key]);

  if (!result) return null;
  const tWin = result.winner === 'traitors';
  const won = result.youWon;
  const title = isHost || won === null
    ? (tWin ? 'THE TRAITORS WIN' : 'THE VILLAGE WINS')
    : won ? (tWin ? 'CONGRATS, TRAITOR' : 'YOU WON') : 'YOU LOST';
  const sub = isHost || won === null
    ? (tWin ? 'The traitors now equal or outnumber everyone else.' : 'Every traitor has been eliminated.')
    : won ? (tWin ? 'You deceived them all. The traitors take the game.' : 'The village found every traitor. Villagers, doctors and detectives win.')
      : (tWin ? 'The traitors took over the village. Better luck next round.' : 'Your side was exposed. Every traitor is eliminated.');

  return (
    <>
      <button className={'result-banner ' + (won === false ? 'lose' : 'win')} onClick={() => setClosedKey('')}>
        <Flag size={16} /> Game over: {tWin ? 'Traitors' : 'Village'} won. Tap to view result
      </button>
      {open && (
        <div className="result-overlay" role="dialog" aria-modal="true" aria-label="Game result">
          <div className={'result-card ' + (won === false ? 'lose' : 'win')}>
            <button className="result-close" onClick={() => setClosedKey(key)} aria-label="Close"><X size={18} /></button>
            {won === false ? <Frown size={64} /> : <Trophy size={64} />}
            <h2>{title}</h2>
            <p>{sub}</p>
            {result.yourRole && <p className="yourrole">Your role was <strong>{result.yourRole}</strong></p>}
            {gameState.finalRoles && (
              <div className="final-roles">
                {gameState.finalRoles.map((r, i) => (
                  <div key={i} className={'final-row' + (r.dead ? ' is-dead' : '') + (r.role === 'Traitor' ? ' traitor' : '')}>
                    <span>{r.name}</span><b>{r.role}</b>
                  </div>
                ))}
              </div>
            )}
            <button className="brutalist-btn" onClick={() => setClosedKey(key)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
