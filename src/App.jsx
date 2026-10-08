import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import {
  Skull, Stethoscope, Search, Wheat, Lock, Shuffle, Copy, Users, Check, AlertCircle, LogOut,
  Shield, Sparkles, Eye, Crown, Trash2, UserPlus, Clock, X, ChevronRight, RefreshCw, UserMinus,
} from 'lucide-react';

const STORAGE_KEY = 'traitors_session_v2';
const TOKEN_KEY = 'traitors_client_token_v2';

const ROLE_INFO = {
  Traitor:   { name: 'Traitor',   icon: Skull,       cardClass: 'role-card-traitor',   tip: 'Blend in, orchestrate murders at night, and eliminate all loyal villagers.' },
  Doctor:    { name: 'Doctor',    icon: Stethoscope, cardClass: 'role-card-doctor',    tip: 'Save one player from elimination each round. Protect the innocent.' },
  Detective: { name: 'Detective', icon: Search,      cardClass: 'role-card-detective', tip: "Investigate one player's identity each night to uncover traitors." },
  Villager:  { name: 'Villager',  icon: Wheat,       cardClass: 'role-card-villager',  tip: 'Spot deceit in discussions, root out the traitors, and vote wisely.' },
};
const SLOT_ROLES = ['Traitor', 'Doctor', 'Detective', 'Villager'];

// One token per browser tab. The server uses it to make joining idempotent (no duplicate players on slow networks).
function getClientToken() {
  try {
    let t = sessionStorage.getItem(TOKEN_KEY);
    if (!t) { t = crypto.randomUUID(); sessionStorage.setItem(TOKEN_KEY, t); }
    return t;
  } catch { return 'tok-' + Math.random().toString(36).slice(2) + Date.now(); }
}

// Never throws, so buttons can't get stuck in a loading state.
async function api(body) {
  try {
    const res = await fetch('/api/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: `Server error (HTTP ${res.status}). Check Vercel logs.` }; }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error. Check your connection.' } };
  }
}

class Boundary extends React.Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 24 }}>
        <h2>Something broke</h2>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.err)}</pre>
        <button className="brutalist-btn" onClick={() => { try { sessionStorage.removeItem(STORAGE_KEY); } catch {} location.reload(); }}>Reset</button>
      </div>
    );
  }
}

export default function App() { return <Boundary><AppInner /></Boundary>; }

function AppInner() {
  const [session, setSession] = useState(() => {
    try { const s = sessionStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [inputCode, setInputCode] = useState('');
  const [inputName, setInputName] = useState('');
  const [gameState, setGameState] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [ongoingGames, setOngoingGames] = useState([]);
  const [loadingGames, setLoadingGames] = useState(false);
  const [pendingRequest, setPendingRequest] = useState(null);
  const [requestStatus, setRequestStatus] = useState('pending');
  const [myRole, setMyRole] = useState(null);            // only held in memory while the role is on screen
  const [revealState, setRevealState] = useState('IDLE'); // IDLE | REVEALING | REVEALED
  const [slotRole, setSlotRole] = useState('Villager');
  const [transferTarget, setTransferTarget] = useState(null);

  const busyRef = useRef(false);
  const lastSigRef = useRef('');
  const roundRef = useRef(0);
  const slotTimerRef = useRef(null);

  useEffect(() => {
    try {
      if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, [session]);

  const clearSlot = () => { if (slotTimerRef.current) { clearInterval(slotTimerRef.current); slotTimerRef.current = null; } };
  useEffect(() => clearSlot, []);

  const endSession = useCallback((msg = '') => {
    clearSlot();
    setSession(null); setGameState(null); setMyRole(null); setRevealState('IDLE');
    setTransferTarget(null); lastSigRef.current = ''; roundRef.current = 0;
    setErrorMsg(msg);
  }, []);

  // ---------- lobby list (landing only) ----------
  const fetchOngoingGames = useCallback(async (manual = false) => {
    if (manual) setLoadingGames(true);
    const { ok, data } = await api({ action: 'list_games' });
    if (ok) setOngoingGames((prev) => (JSON.stringify(prev) === JSON.stringify(data.games || []) ? prev : data.games || []));
    if (manual) setLoadingGames(false);
  }, []);

  useEffect(() => {
    if (session || pendingRequest) return;
    fetchOngoingGames();
    const id = setInterval(fetchOngoingGames, 4000);
    return () => clearInterval(id);
  }, [session, pendingRequest, fetchOngoingGames]);

  // ---------- join request polling ----------
  useEffect(() => {
    if (!pendingRequest) return;
    let alive = true, timer, fails = 0;
    const tick = async () => {
      const { ok, data } = await api({ action: 'poll_request', code: pendingRequest.code, requestId: pendingRequest.requestId });
      if (!alive) return;
      if (ok) {
        fails = 0; setRequestStatus(data.status);
        if (data.status === 'approved' && data.playerId) {
          setSession({ code: pendingRequest.code, playerId: data.playerId, name: pendingRequest.name });
          setPendingRequest(null); return;
        }
        if (data.status === 'denied') { setErrorMsg('Your join request was declined by the host.'); setPendingRequest(null); return; }
      } else if (++fails >= 3) {
        setErrorMsg(data.error || 'Join request expired or game ended.'); setPendingRequest(null); return;
      }
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [pendingRequest]);

  // ---------- main game polling (self-scheduling: no overlapping or out-of-order responses) ----------
  useEffect(() => {
    if (!session?.code) { setGameState(null); return; }
    let alive = true, timer, fails = 0;

    const applyState = (data) => {
      const sig = JSON.stringify(data);
      if (sig === lastSigRef.current) return;            // nothing changed -> no re-render, no scroll jump
      lastSigRef.current = sig;
      const y = window.scrollY;
      setGameState(data);
      if (!data.isHost && data.round !== roundRef.current) { // new deal: roles always start hidden
        roundRef.current = data.round; clearSlot(); setMyRole(null); setRevealState('IDLE');
      }
      requestAnimationFrame(() => { if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y); });
    };

    const tick = async () => {
      const { ok, status, data } = await api({ action: 'state', code: session.code, hostKey: session.hostKey, playerId: session.playerId });
      if (!alive) return;
      if (ok) {
        fails = 0;
        if (session.hostKey && !data.isHost) return endSession('You are no longer the host of this game.');
        if (!session.hostKey && data.isHost && data.hostKey) { // host control was passed to this player
          setSession({ code: session.code, hostKey: data.hostKey, name: session.name }); return;
        }
        if (!data.isHost && data.joined === false) return endSession('You are no longer in this game (removed by the host).');
        applyState(data);
      } else if (status === 404 && ++fails >= 3) {
        return endSession(data.error || 'Game session ended or host left.');
      }
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [session, endSession]);

  // ---------- reveal ----------
  function triggerSlotReveal() {
    clearSlot(); setRevealState('REVEALING');
    let cycles = 0;
    slotTimerRef.current = setInterval(() => {
      setSlotRole(SLOT_ROLES[cycles % SLOT_ROLES.length]); cycles++;
      if (cycles >= 10) {
        clearSlot(); setRevealState('REVEALED');
        try { confetti({ particleCount: 40, spread: 60, origin: { y: 0.6 } }); } catch {}
      }
    }, 100);
  }

  const handleReveal = async () => {
    if (busyRef.current) return; busyRef.current = true;
    const { ok, data } = await api({ action: 'reveal', code: session.code, playerId: session.playerId });
    busyRef.current = false;
    if (!ok) return setErrorMsg(data.error || 'Could not reveal your role.');
    setMyRole(data.role); triggerSlotReveal();
  };

  const handleHide = async () => {
    clearSlot(); setMyRole(null); setRevealState('IDLE');
    const { ok } = await api({ action: 'ack', code: session.code, playerId: session.playerId });
    if (ok) setGameState((prev) => (prev ? { ...prev, acked: true } : prev));
  };

  // ---------- actions ----------
  const guarded = (fn) => async (...a) => {
    if (busyRef.current) return; busyRef.current = true; setLoading(true); setErrorMsg('');
    try { await fn(...a); } finally { busyRef.current = false; setLoading(false); }
  };

  const handleCreateGame = guarded(async () => {
    const name = inputName.trim();
    if (!name) return setErrorMsg('Please enter your name above before creating a game.');
    const { ok, data } = await api({ action: 'create', name });
    if (ok) setSession({ code: data.code, hostKey: data.hostKey, name: data.hostName || name });
    else setErrorMsg(data.error || 'Failed to create game.');
  });

  const handleJoinGame = guarded(async (e) => {
    e?.preventDefault();
    const code = inputCode.trim().toUpperCase(), name = inputName.trim();
    if (code.length !== 4) return setErrorMsg('Please enter a 4-character game code.');
    if (!name) return setErrorMsg('Please enter your player name above.');
    const { ok, data } = await api({ action: 'join', code, name, clientToken: getClientToken() });
    if (ok) setSession({ code: data.code, playerId: data.playerId, name: data.name });
    else setErrorMsg(data.error || 'Could not join game.');
  });

  const handleRequestJoin = guarded(async (gameId, hostName) => {
    const name = inputName.trim();
    if (!name) return setErrorMsg('Please enter your name above before requesting to join.');
    const { ok, data } = await api({ action: 'request_join', code: gameId, name, clientToken: getClientToken() });
    if (ok) { setPendingRequest({ code: gameId, requestId: data.requestId, name: data.name, hostName }); setRequestStatus('pending'); }
    else setErrorMsg(data.error || 'Could not send join request.');
  });

  const cancelRequest = async () => {
    const p = pendingRequest; setPendingRequest(null); setRequestStatus('pending');
    if (p) api({ action: 'cancel_request', code: p.code, requestId: p.requestId });
  };

  const handleUpdateCounts = async (newCounts) => {
    setGameState((prev) => (prev ? { ...prev, counts: newCounts } : prev));
    lastSigRef.current = '';
    const { ok, data } = await api({ action: 'counts', code: session.code, hostKey: session.hostKey, counts: newCounts });
    if (!ok) setErrorMsg(data.error || 'Could not update roles.');
  };

  const handleShuffle = guarded(async () => {
    const { ok, data } = await api({ action: 'shuffle', code: session.code, hostKey: session.hostKey });
    if (!ok) setErrorMsg(data.error || 'Could not shuffle roles.');
  });

  const handleHandleRequest = async (rid, decision) => {
    setGameState((prev) => (prev ? { ...prev, pendingRequests: (prev.pendingRequests || []).filter((r) => r.requestId !== rid) } : prev));
    const { ok, data } = await api({ action: 'handle_request', code: session.code, hostKey: session.hostKey, requestId: rid, decision });
    if (!ok) setErrorMsg(data.error || 'Could not handle request.');
  };

  const handleKick = async (p) => {
    if (!window.confirm(`Remove ${p.name} from the game?`)) return;
    const { ok, data } = await api({ action: 'kick', code: session.code, hostKey: session.hostKey, target: p.pid });
    if (!ok) setErrorMsg(data.error || 'Could not remove player.');
    else setGameState((prev) => (prev ? { ...prev, players: prev.players.filter((x) => x.pid !== p.pid), totalPlayers: prev.totalPlayers - 1 } : prev));
  };

  const handleTransferHost = guarded(async (stay) => {
    const t = transferTarget; if (!t) return;
    const { ok, data } = await api({ action: 'transfer', code: session.code, hostKey: session.hostKey, target: t.pid, stay });
    if (!ok) return setErrorMsg(data.error || 'Failed to transfer host.');
    setTransferTarget(null); lastSigRef.current = ''; roundRef.current = 0; setGameState(null);
    if (stay && data.stayedAs) setSession({ code: session.code, playerId: data.stayedAs.playerId, name: data.stayedAs.name });
    else endSession('');
  });

  const handleDestroyGame = async () => {
    if (!window.confirm('End and delete this game? All players will be removed.')) return;
    await api({ action: 'leave', code: session.code, hostKey: session.hostKey });
    endSession('');
  };

  const handleLeavePlayer = async () => {
    if (session?.code) await api({ action: 'leave', code: session.code, playerId: session.playerId });
    endSession('');
  };

  const copyCode = () => {
    try { navigator.clipboard.writeText(session.code); } catch {}
    setCopiedCode(true); setTimeout(() => setCopiedCode(false), 2000);
  };

  const isHost = !!gameState?.isHost;
  const isPlayer = !!session?.playerId && !!gameState && !isHost;

  // ---------- small shared UI ----------
  const AckBadge = ({ p }) => gameState?.round > 0 && (p.acked
    ? <span className="player-ack-badge confirmed"><Check size={14} /> Hidden</span>
    : <span className="player-ack-badge waiting">Viewing</span>);

  return (
    <>
      <div className="marquee-container">
        <div className="marquee-track">
          TRAITORS ROLE DEALER &bull; TRUST NO ONE &bull; DO NOT SHOW YOUR SCREEN &bull; SHUFFLE &amp; DEAL &bull; KEEP YOUR SECRET &bull;&nbsp;
          TRAITORS ROLE DEALER &bull; TRUST NO ONE &bull; DO NOT SHOW YOUR SCREEN &bull; SHUFFLE &amp; DEAL &bull; KEEP YOUR SECRET &bull;&nbsp;
        </div>
      </div>

      <motion.header className="app-header" initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 15 }}>
        <h1 className="wordmark">TRAITORS</h1>
        <div className="subhead">ROLE DEALER</div>
      </motion.header>

      <AnimatePresence>
        {errorMsg && (
          <motion.div className="error-banner" role="alert" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }}>
            <AlertCircle size={20} />
            <span style={{ flex: 1 }}>{errorMsg}</span>
            <button onClick={() => setErrorMsg('')} aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== LANDING ===== */}
      {!session && !pendingRequest && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <div className="brutalist-card">
            <div className="card-title"><Users size={22} /><span>Join or Host Game</span></div>
            <label className="field-label">Your Name (Required for Host &amp; Player)</label>
            <input type="text" className="brutalist-input" placeholder="Enter your name (e.g. Alex)" value={inputName} onChange={(e) => setInputName(e.target.value)} maxLength={20} />
            <label className="field-label" style={{ marginTop: 14 }}>Have a 4-letter game code?</label>
            <input type="text" className="brutalist-input" placeholder="e.g. K9X4" value={inputCode} onChange={(e) => setInputCode(e.target.value.toUpperCase())} maxLength={4} style={{ letterSpacing: 4, textTransform: 'uppercase' }} />
            <button className="brutalist-btn" onClick={handleJoinGame} disabled={loading}><Users size={20} /><span>Join Game by Code</span></button>
            <div style={{ borderTop: '3px solid #000', marginTop: 20, paddingTop: 20, textAlign: 'center' }}>
              <p style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 8, textTransform: 'uppercase' }}>Want to host a new game table?</p>
              <button className="brutalist-btn brutalist-btn-dark" onClick={handleCreateGame} disabled={loading}>
                <Sparkles size={20} /><span>Create Game (Host as {inputName.trim() || '…'})</span>
              </button>
            </div>
          </div>

          <div className="brutalist-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div className="card-title" style={{ margin: 0 }}><ChevronRight size={22} /><span>Ongoing Games</span></div>
              <button onClick={() => fetchOngoingGames(true)} style={{ background: 'none', border: 'var(--border-thick)', padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 700, fontSize: '0.8rem' }}>
                <RefreshCw size={14} />{loadingGames ? '...' : 'Refresh'}
              </button>
            </div>
            {ongoingGames.length === 0 ? (
              <p style={{ fontWeight: 500, color: '#64748B', fontStyle: 'italic', textAlign: 'center', padding: '16px 0' }}>No active games right now. Enter your name and create one above!</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ongoingGames.map((g) => (
                  <div key={g.gameId} className="lobby-game-row">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem' }}>Hosted by {g.hostName}</span>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#475569' }}>{g.playerCount} player{g.playerCount !== 1 ? 's' : ''} &bull; Round {g.round}</span>
                    </div>
                    <button className="brutalist-btn" style={{ width: 'auto', padding: '8px 14px', fontSize: '0.85rem' }} onClick={() => handleRequestJoin(g.gameId, g.hostName)} disabled={loading}>
                      <UserPlus size={16} /><span>Request to Join</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* ===== WAITING FOR APPROVAL ===== */}
      {pendingRequest && !session && (
        <div className="brutalist-card" style={{ textAlign: 'center', padding: '36px 20px' }}>
          <Clock size={40} style={{ marginBottom: 16 }} />
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', marginBottom: 8 }}>WAITING FOR HOST</h2>
          <p style={{ fontWeight: 500, color: '#475569', marginBottom: 20 }}>
            Your request to join the game hosted by <strong>{pendingRequest.hostName || 'Host'}</strong> as <strong>{pendingRequest.name}</strong> is pending.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20 }}>
            {['pending', 'approved', 'denied'].map((s) => (
              <div key={s} style={{ padding: '4px 12px', border: 'var(--border-thick)', fontWeight: 700, fontSize: '0.8rem', background: requestStatus === s ? 'var(--neon-mint)' : 'var(--white)', textTransform: 'uppercase' }}>{s}</div>
            ))}
          </div>
          <button className="brutalist-btn brutalist-btn-secondary" onClick={cancelRequest}><X size={16} /><span>Cancel Request</span></button>
        </div>
      )}

      {session && !gameState && <div className="brutalist-card" style={{ textAlign: 'center' }}><p style={{ fontWeight: 700 }}>Connecting…</p></div>}

      {/* ===== HOST ===== */}
      {session && isHost && gameState && (
        <div>
          <div className="code-display-box">
            <div className="code-label">GAME CODE &bull; HOST ROOM</div>
            <div className="code-letters">
              {session.code.split('').map((c, i) => <div key={i} className="code-char">{c}</div>)}
            </div>
            <button className="brutalist-btn brutalist-btn-secondary" onClick={copyCode} style={{ fontSize: '0.85rem', padding: '8px 12px' }}>
              {copiedCode ? <Check size={16} /> : <Copy size={16} />}<span>{copiedCode ? 'Copied!' : 'Copy Code'}</span>
            </button>
          </div>

          {gameState.pendingRequests?.length > 0 && (
            <div className="brutalist-card request-card">
              <div className="card-title"><UserPlus size={22} /><span>Join Requests ({gameState.pendingRequests.length})</span></div>
              {gameState.pendingRequests.map((r) => (
                <div key={r.requestId} className="request-row">
                  <span style={{ fontWeight: 700 }}>{r.name}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="brutalist-btn" style={{ width: 'auto', padding: '6px 12px', fontSize: '0.85rem' }} onClick={() => handleHandleRequest(r.requestId, 'approve')}><Check size={14} /><span>Approve</span></button>
                    <button className="brutalist-btn brutalist-btn-dark" style={{ width: 'auto', padding: '6px 12px', fontSize: '0.85rem' }} onClick={() => handleHandleRequest(r.requestId, 'deny')}><X size={14} /><span>Deny</span></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="brutalist-card">
            <div className="card-title"><Shield size={22} /><span>Configure Roles</span></div>
            {[
              { label: 'Traitors', icon: Skull, key: 'traitors', min: 1 },
              { label: 'Doctors', icon: Stethoscope, key: 'doctors', min: 0 },
              { label: 'Detectives', icon: Search, key: 'detectives', min: 0 },
            ].map(({ label, icon: Icon, key, min }) => {
              const val = gameState.counts?.[key] ?? 0;
              return (
                <div key={key} className="stepper-row">
                  <div className="stepper-label"><Icon size={18} /><span>{label}</span></div>
                  <div className="stepper-controls">
                    <button className="stepper-btn" onClick={() => handleUpdateCounts({ ...gameState.counts, [key]: Math.max(min, val - 1) })}>-</button>
                    <span className="stepper-val">{val}</span>
                    <button className="stepper-btn" onClick={() => handleUpdateCounts({ ...gameState.counts, [key]: val + 1 })}>+</button>
                  </div>
                </div>
              );
            })}
            {(() => {
              const total = gameState.totalPlayers || 0;
              const c = gameState.counts || {};
              const spec = (c.traitors || 0) + (c.doctors || 0) + (c.detectives || 0);
              const villagers = total - spec;
              const invalid = total < 2 || villagers < 0;
              return (
                <>
                  <div style={{ marginTop: 12, padding: 12, border: 'var(--border-thick)', background: invalid ? '#FFD1D1' : 'var(--neon-mint)', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Wheat size={18} /><span>Villagers (Auto)</span></div>
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem' }}>{villagers >= 0 ? villagers : 'Invalid'}</span>
                  </div>
                  <button className="brutalist-btn" onClick={handleShuffle} disabled={invalid || loading} style={{ marginTop: 20 }}>
                    <Shuffle size={20} /><span>{gameState.round === 0 ? 'Shuffle and Deal' : 'Reshuffle New Round'}</span>
                  </button>
                </>
              );
            })()}
          </div>

          <div className="brutalist-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div className="card-title" style={{ margin: 0 }}><Users size={22} /><span>Players ({gameState.totalPlayers})</span></div>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', background: '#000', color: '#39FFB4', padding: '4px 8px' }}>{gameState.confirmedCount || 0}/{gameState.totalPlayers || 0} confirmed</div>
            </div>
            {gameState.players.length === 0 ? (
              <p style={{ fontWeight: 500, color: '#64748B', fontStyle: 'italic' }}>Waiting for players to join using code <strong>{session.code}</strong>...</p>
            ) : (
              <div className="player-list">
                {gameState.players.map((p) => (
                  <div key={p.pid} className="player-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                      <AckBadge p={p} />
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button title={`Make ${p.name} the host`} onClick={() => setTransferTarget(p)} style={{ padding: '4px 8px', fontSize: '0.75rem', fontWeight: 700, border: 'var(--border-thick)', background: 'var(--white)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Crown size={14} /><span>Host</span>
                      </button>
                      <button title={`Remove ${p.name}`} aria-label={`Remove ${p.name}`} onClick={() => handleKick(p)} style={{ padding: '4px 8px', border: 'var(--border-thick)', background: '#FFD1D1', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                        <UserMinus size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p style={{ fontSize: '0.75rem', color: '#64748B', marginTop: 10 }}>You are the host and don't receive a role.</p>
          </div>

          <button className="brutalist-btn brutalist-btn-dark" onClick={handleDestroyGame} style={{ marginTop: 8 }}>
            <Trash2 size={18} /><span>End &amp; Delete Game</span>
          </button>

          <AnimatePresence>
            {transferTarget && (
              <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="brutalist-card" style={{ maxWidth: 380, width: '90%' }}>
                  <div className="card-title"><Crown size={22} /><span>Pass host to {transferTarget.name}?</span></div>
                  <p style={{ fontWeight: 500, marginBottom: 16 }}>{transferTarget.name} becomes the host and stops being a player. What do you want to do?</p>
                  <button className="brutalist-btn" onClick={() => handleTransferHost(true)} disabled={loading}><Users size={18} /><span>Pass host &amp; stay as a player</span></button>
                  <button className="brutalist-btn brutalist-btn-dark" onClick={() => handleTransferHost(false)} disabled={loading} style={{ marginTop: 8 }}><LogOut size={18} /><span>Pass host &amp; leave game</span></button>
                  <button className="brutalist-btn brutalist-btn-secondary" onClick={() => setTransferTarget(null)} style={{ marginTop: 8 }}>Cancel</button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ===== PLAYER ===== */}
      {session && isPlayer && (
        <div>
          <div style={{ background: '#000', color: '#FFF', padding: '12px 16px', border: 'var(--border-thick)', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#39FFB4', textTransform: 'uppercase', fontFamily: 'var(--font-heading)' }}>PLAYER &bull; {session.code} &bull; HOST: {gameState.hostName}</div>
              <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{gameState.name || session.name}</div>
            </div>
            <button onClick={handleLeavePlayer} style={{ background: 'none', border: 'none', color: '#FFF', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', fontWeight: 700 }}><LogOut size={16} /> Exit</button>
          </div>

          {gameState.players?.length > 0 && (
            <div className="brutalist-card" style={{ marginBottom: 16 }}>
              <div className="card-title" style={{ marginBottom: 10 }}><Users size={20} /><span>Players in this room ({gameState.totalPlayers})</span></div>
              <div className="player-list">
                {gameState.players.map((p) => (
                  <div key={p.pid} className="player-item" style={{ boxShadow: 'none' }}>
                    <span style={{ fontWeight: p.you ? 800 : 600 }}>{p.name}{p.you ? ' (you)' : ''}</span>
                    <AckBadge p={p} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {!gameState.dealStarted && (
            <div className="brutalist-card" style={{ textAlign: 'center', padding: '36px 20px' }}>
              <Users size={40} style={{ marginBottom: 12 }} />
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', marginBottom: 8 }}>YOU ARE IN THE ROOM</h2>
              <p style={{ fontWeight: 500, color: '#475569' }}>Waiting for the host to tap <strong>Shuffle and deal</strong>…</p>
            </div>
          )}

          {gameState.dealStarted && !gameState.hasRole && (
            <div className="brutalist-card" style={{ textAlign: 'center', padding: '28px 20px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.3rem', marginBottom: 8 }}>YOU JOINED AFTER THE DEAL</h2>
              <p style={{ fontWeight: 500 }}>You'll get a role in the next round. Wait for the host to reshuffle.</p>
            </div>
          )}

          {gameState.hasRole && myRole && (
            revealState === 'REVEALING' ? (
              <div className="role-card-display role-card-doctor">
                <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-heading)', textTransform: 'uppercase', marginBottom: 12 }}>DEAL IN PROGRESS…</div>
                {React.createElement(ROLE_INFO[slotRole].icon, { size: 64 })}
                <div className="role-title-huge">{slotRole}</div>
              </div>
            ) : (() => {
              const info = ROLE_INFO[myRole] || ROLE_INFO.Villager; const RoleIcon = info.icon;
              return (
                <motion.div className={`role-card-display ${info.cardClass}`} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }}>
                  <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-heading)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>YOUR SECRET ROLE</div>
                  <RoleIcon size={64} style={{ margin: '0 auto' }} />
                  <div className="role-title-huge">{info.name}</div>
                  <div className="role-tip-box">{info.tip}</div>
                  <button className="brutalist-btn brutalist-btn-dark" onClick={handleHide} style={{ marginTop: 24 }}><Lock size={20} /><span>I've seen it. Hide</span></button>
                </motion.div>
              );
            })()
          )}

          {gameState.hasRole && !myRole && (
            <div className="locked-box">
              <div className="lock-pulse-ring"><Lock size={48} color="#39FFB4" /></div>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.6rem', marginBottom: 8, color: '#39FFB4' }}>{gameState.acked ? 'ROLE HIDDEN' : 'ROLE DEALT'}</h2>
              <p style={{ fontWeight: 500, color: '#E2E8F0', maxWidth: 300, margin: '0 auto 20px auto' }}>
                {gameState.acked ? 'Your secret role is locked. Keep your phone concealed.' : 'Make sure nobody can see your screen, then reveal your role.'}
              </p>
              <button className="brutalist-btn" onClick={handleReveal} style={{ fontSize: '0.95rem', marginBottom: 12 }}>
                <Eye size={18} /><span>{gameState.acked ? 'See Secret Role Again' : 'Reveal My Role'}</span>
              </button>
              {gameState.acked && <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#94A3B8' }}>Waiting for host to reshuffle…</div>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
