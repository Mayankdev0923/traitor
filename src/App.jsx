import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import {
  Skull, Stethoscope, Search, Wheat, Lock, Shuffle, Copy,
  Users, Check, AlertCircle, LogOut, Shield, Sparkles,
  Eye, Crown, Trash2, UserPlus, Clock, X, ChevronRight,
  RefreshCw, UserCheck
} from 'lucide-react';

const STORAGE_KEY = 'traitors_session_v1';

const ROLE_INFO = {
  Traitor:   { name: 'Traitor',   icon: Skull,        cardClass: 'role-card-traitor',   tip: 'Blend in, orchestrate murders at night, and eliminate all loyal villagers.' },
  Doctor:    { name: 'Doctor',    icon: Stethoscope,  cardClass: 'role-card-doctor',    tip: 'Save one player from elimination each round. Protect the innocent.' },
  Detective: { name: 'Detective', icon: Search,        cardClass: 'role-card-detective', tip: "Investigate one player's identity each night to uncover traitors." },
  Villager:  { name: 'Villager',  icon: Wheat,         cardClass: 'role-card-villager',  tip: 'Spot deceit in discussions, root out the traitors, and vote wisely.' },
};

const SLOT_ROLES = ['Traitor', 'Doctor', 'Detective', 'Villager'];

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api(body) {
  const res = await fetch('/api/game', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  /* ---------- session ---------- */
  const [session, setSession] = useState(() => {
    try {
      const s = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  });

  /* ---------- landing form ---------- */
  const [inputCode, setInputCode] = useState('');
  const [inputName, setInputName] = useState('');

  /* ---------- game state from server ---------- */
  const [gameState, setGameState] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  /* ---------- ongoing games list on landing ---------- */
  const [ongoingGames, setOngoingGames] = useState([]);
  const [loadingGames, setLoadingGames] = useState(false);

  /* ---------- join-request flow ---------- */
  // User may arrive via "Request to Join" from the lobby list
  // pendingRequest = { code, requestId, name } while waiting for host approval
  const [pendingRequest, setPendingRequest] = useState(null);
  const [requestStatus, setRequestStatus] = useState('pending'); // 'pending' | 'approved' | 'denied'

  /* ---------- player UI ---------- */
  const [isPeekingRole, setIsPeekingRole] = useState(false);
  const [revealState, setRevealState] = useState('IDLE'); // IDLE | REVEALING | REVEALED
  const [slotRole, setSlotRole] = useState('Villager');
  const lastRoundRef = useRef(0);

  /* ---------- host UI ---------- */
  const [selectedTransferPlayer, setSelectedTransferPlayer] = useState(null);

  /* ---------- polling resilience ---------- */
  const stateErrorCountRef = useRef(0);
  const reqErrorCountRef = useRef(0);

  // ---------------------------------------------------------------------------
  // Persist session
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (session) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [session]);

  // ---------------------------------------------------------------------------
  // Fetch ongoing games (landing screen only)
  // ---------------------------------------------------------------------------
  const fetchOngoingGames = useCallback(async () => {
    setLoadingGames(true);
    try {
      const { ok, data } = await api({ action: 'list_games' });
      if (ok) setOngoingGames(data.games || []);
    } catch {}
    finally { setLoadingGames(false); }
  }, []);

  useEffect(() => {
    if (!session && !pendingRequest) {
      fetchOngoingGames();
      const id = setInterval(fetchOngoingGames, 4000);
      return () => clearInterval(id);
    }
  }, [session, pendingRequest, fetchOngoingGames]);

  // ---------------------------------------------------------------------------
  // Poll join-request status (while waiting for host)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!pendingRequest) { reqErrorCountRef.current = 0; return; }

    let alive = true;
    const poll = async () => {
      const { ok, data } = await api({ action: 'poll_request', code: pendingRequest.code, requestId: pendingRequest.requestId });
      if (!alive) return;

      if (ok) {
        reqErrorCountRef.current = 0;
        setRequestStatus(data.status);

        if (data.status === 'approved' && data.playerId) {
          // Transition into the game as a player
          setSession({ code: pendingRequest.code, playerId: data.playerId, name: pendingRequest.name });
          setPendingRequest(null);
        } else if (data.status === 'denied') {
          setErrorMsg('Your join request was declined by the host.');
          setPendingRequest(null);
        }
      } else {
        reqErrorCountRef.current += 1;
        if (reqErrorCountRef.current >= 3) {
          setErrorMsg('Join request expired or game ended.');
          setPendingRequest(null);
          reqErrorCountRef.current = 0;
        }
      }
    };

    poll();
    const id = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [pendingRequest]);

  // ---------------------------------------------------------------------------
  // Main game state polling loop (once in a session)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!session?.code) { setGameState(null); stateErrorCountRef.current = 0; return; }

    let alive = true;
    const poll = async () => {
      const payload = { action: 'state', code: session.code };
      if (session.hostKey) payload.hostKey = session.hostKey;
      if (session.playerId) payload.playerId = session.playerId;

      const { ok, status, data } = await api(payload);
      if (!alive) return;

      if (ok) {
        stateErrorCountRef.current = 0;
        setErrorMsg('');
        setGameState(data);

        // Automatic host-promotion after transfer
        if (data.isHost && data.hostKey && session.playerId && !session.hostKey) {
          setSession({ code: session.code, hostKey: data.hostKey });
        }

        // Trigger reveal animation on new round
        if (!data.isHost && data.role && !data.acked) {
          if (data.round !== lastRoundRef.current) {
            lastRoundRef.current = data.round;
            setIsPeekingRole(false);
            triggerSlotReveal();
          }
        }
      } else if (status === 404 || status === 401) {
        stateErrorCountRef.current += 1;
        if (stateErrorCountRef.current >= 3) {
          setErrorMsg(data.error || 'Game session ended or host left.');
          setSession(null);
          stateErrorCountRef.current = 0;
        }
      }
    };

    poll();
    const id = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [session]);

  // ---------------------------------------------------------------------------
  // Slot-machine reveal
  // ---------------------------------------------------------------------------
  function triggerSlotReveal() {
    setRevealState('REVEALING');
    let cycles = 0;
    const id = setInterval(() => {
      setSlotRole(SLOT_ROLES[cycles % SLOT_ROLES.length]);
      cycles++;
      if (cycles >= 10) {
        clearInterval(id);
        setRevealState('REVEALED');
        try { confetti({ particleCount: 40, spread: 60, origin: { y: 0.6 } }); } catch {}
      }
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const handleCreateGame = async () => {
    const name = inputName.trim();
    if (!name) { setErrorMsg('Please enter your name in "Your Name" above before creating a game.'); return; }
    setLoading(true); setErrorMsg('');
    const { ok, data } = await api({ action: 'create', name, hostName: name });
    setLoading(false);
    if (ok) setSession({ code: data.code, hostKey: data.hostKey, hostName: data.hostName || name });
    else setErrorMsg(data.error || 'Failed to create game.');
  };

  const handleJoinGame = async (e) => {
    e?.preventDefault();
    const code = inputCode.trim().toUpperCase();
    const name = inputName.trim();
    if (!code || code.length !== 4) { setErrorMsg('Please enter a 4-character game code.'); return; }
    if (!name) { setErrorMsg('Please enter your player name in "Your Name" above.'); return; }
    setLoading(true); setErrorMsg('');
    const { ok, data } = await api({ action: 'join', code, name });
    setLoading(false);
    if (ok) setSession({ code: data.code, playerId: data.playerId, name: data.name });
    else setErrorMsg(data.error || 'Could not join game.');
  };

  const handleRequestJoin = async (targetGameId, hostName) => {
    const name = inputName.trim();
    if (!name) { setErrorMsg('Please enter your name in "Your Name" above before requesting to join.'); return; }
    setLoading(true); setErrorMsg('');
    const { ok, data } = await api({ action: 'request_join', code: targetGameId, name });
    setLoading(false);
    if (ok) {
      setPendingRequest({ code: targetGameId, requestId: data.requestId, name: data.name, hostName });
      setRequestStatus('pending');
    } else {
      setErrorMsg(data.error || 'Could not send join request.');
    }
  };

  const handleUpdateCounts = async (newCounts) => {
    if (!session?.hostKey) return;
    const { ok, data } = await api({ action: 'counts', code: session.code, hostKey: session.hostKey, counts: newCounts });
    if (ok) setGameState(prev => ({ ...prev, counts: data.counts }));
  };

  const handleShuffle = async () => {
    setLoading(true); setErrorMsg('');
    const { ok, data } = await api({ action: 'shuffle', code: session.code, hostKey: session.hostKey });
    setLoading(false);
    if (!ok) setErrorMsg(data.error || 'Could not shuffle roles.');
  };

  const handleAckRole = async () => {
    const { ok } = await api({ action: 'ack', code: session.code, playerId: session.playerId });
    if (ok) { setGameState(prev => ({ ...prev, acked: true })); setIsPeekingRole(false); setRevealState('IDLE'); }
  };

  const handleHandleRequest = async (reqId, decision) => {
    await api({ action: 'handle_request', code: session.code, hostKey: session.hostKey, requestId: reqId, decision });
    // Optimistic update — will refresh on next poll
    setGameState(prev => prev ? {
      ...prev,
      pendingRequests: (prev.pendingRequests || []).filter(r => r.requestId !== reqId),
    } : prev);
  };

  const handleTransferHost = async (targetPlayerId) => {
    setLoading(true);
    const { ok } = await api({ action: 'leave', code: session.code, hostKey: session.hostKey, newHostPlayerId: targetPlayerId });
    setLoading(false);
    if (ok) { setSession(null); setGameState(null); setSelectedTransferPlayer(null); }
    else setErrorMsg('Failed to transfer host.');
  };

  const handleDestroyGame = async () => {
    if (!window.confirm('End and delete this game instance? All players will be kicked.')) return;
    await api({ action: 'leave', code: session.code, hostKey: session.hostKey });
    setSession(null); setGameState(null);
  };

  const handleLeavePlayer = async () => {
    if (session?.code) await api({ action: 'leave', code: session.code, playerId: session.playerId });
    setSession(null); setGameState(null); setErrorMsg('');
  };

  const copyCode = () => {
    navigator.clipboard.writeText(session.code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const isHost = gameState?.isHost || !!session?.hostKey;
  const isPlayer = !!session?.playerId;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <>
      {/* ── Scrolling marquee ── */}
      <div className="marquee-container">
        <div className="marquee-track">
          TRAITORS ROLE DEALER &bull; TRUST NO ONE &bull; DO NOT SHOW YOUR SCREEN &bull; SHUFFLE &amp; DEAL &bull; KEEP YOUR SECRET &bull;&nbsp;
          TRAITORS ROLE DEALER &bull; TRUST NO ONE &bull; DO NOT SHOW YOUR SCREEN &bull; SHUFFLE &amp; DEAL &bull; KEEP YOUR SECRET &bull;&nbsp;
        </div>
      </div>

      {/* ── Wordmark ── */}
      <motion.header className="app-header" initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 15 }}>
        <h1 className="wordmark">TRAITORS</h1>
        <div className="subhead">ROLE DEALER</div>
      </motion.header>

      {/* ── Error banner ── */}
      <AnimatePresence>
        {errorMsg && (
          <motion.div className="error-banner" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }}>
            <AlertCircle size={20} />
            <span style={{ flex: 1 }}>{errorMsg}</span>
            <button onClick={() => setErrorMsg('')} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══════════════════════════════════════════════════
          VIEW 1 — LANDING SCREEN
      ═══════════════════════════════════════════════════ */}
      {!session && !pendingRequest && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>

          {/* Name field (shared between join-by-code, request-join, and create-game) */}
          <div className="brutalist-card">
            <div className="card-title"><Users size={22} /><span>Join or Host Game</span></div>

            <label className="field-label">Your Name (Required for Host &amp; Player)</label>
            <input
              type="text" className="brutalist-input" placeholder="Enter your name (e.g. Alex)"
              value={inputName} onChange={e => setInputName(e.target.value)} maxLength={20}
            />

            <label className="field-label" style={{ marginTop: '14px' }}>Have a 4-letter game code?</label>
            <input
              type="text" className="brutalist-input" placeholder="e.g. K9X4"
              value={inputCode} onChange={e => setInputCode(e.target.value.toUpperCase())}
              maxLength={4} style={{ letterSpacing: '4px', textTransform: 'uppercase' }}
            />

            <button className="brutalist-btn" onClick={handleJoinGame} disabled={loading}>
              <Users size={20} /><span>Join Game by Code</span>
            </button>

            <div style={{ borderTop: '3px solid #000', marginTop: '20px', paddingTop: '20px', textAlign: 'center' }}>
              <p style={{ fontWeight: '700', fontSize: '0.9rem', marginBottom: '8px', textTransform: 'uppercase' }}>Want to host a new game table?</p>
              {inputName.trim() && (
                <p style={{ fontSize: '0.8rem', fontWeight: '600', color: '#16A34A', marginBottom: '8px' }}>
                  Hosting as: <strong>{inputName.trim()}</strong>
                </p>
              )}
              <button className="brutalist-btn brutalist-btn-dark" onClick={handleCreateGame} disabled={loading}>
                <Sparkles size={20} /><span>Create Game (Host as {inputName.trim() || '…'})</span>
              </button>
            </div>
          </div>

          {/* ── Ongoing games lobby ── */}
          <div className="brutalist-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div className="card-title" style={{ margin: 0 }}><ChevronRight size={22} /><span>Ongoing Games</span></div>
              <button
                onClick={fetchOngoingGames}
                style={{ background: 'none', border: 'var(--border-thick)', padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: '700', fontSize: '0.8rem' }}
              >
                <RefreshCw size={14} />{loadingGames ? '...' : 'Refresh'}
              </button>
            </div>

            {ongoingGames.length === 0 ? (
              <p style={{ fontWeight: '500', color: '#64748B', fontStyle: 'italic', textAlign: 'center', padding: '16px 0' }}>
                No active games right now. Enter your name and create one above!
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <AnimatePresence>
                  {ongoingGames.map(g => (
                    <motion.div
                      key={g.gameId}
                      className="lobby-game-row"
                      initial={{ scale: 0.95, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.95, opacity: 0 }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem' }}>Hosted by {g.hostName}</span>
                        <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#475569' }}>
                          {g.playerCount} player{g.playerCount !== 1 ? 's' : ''} &bull; Round {g.round}
                        </span>
                      </div>
                      <button
                        className="brutalist-btn"
                        style={{ width: 'auto', padding: '8px 14px', fontSize: '0.85rem' }}
                        onClick={() => handleRequestJoin(g.gameId, g.hostName)}
                        disabled={loading}
                      >
                        <UserPlus size={16} /><span>Request to Join</span>
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* ═══════════════════════════════════════════════════
          VIEW 1b — WAITING FOR HOST TO APPROVE REQUEST
      ═══════════════════════════════════════════════════ */}
      {pendingRequest && !session && (
        <motion.div className="brutalist-card" style={{ textAlign: 'center', padding: '36px 20px' }} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <Clock size={40} style={{ marginBottom: '16px' }} />
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', marginBottom: '8px' }}>WAITING FOR HOST</h2>
          <p style={{ fontWeight: '500', color: '#475569', marginBottom: '20px' }}>
            Your request to join game hosted by <strong>{pendingRequest.hostName || 'Host'}</strong> as <strong>{pendingRequest.name}</strong> is pending.<br />
            The host needs to approve you.
          </p>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginBottom: '20px' }}>
            {['pending', 'approved', 'denied'].map(s => (
              <div key={s} style={{ padding: '4px 12px', border: 'var(--border-thick)', fontWeight: '700', fontSize: '0.8rem', background: requestStatus === s ? 'var(--neon-mint)' : 'var(--white)', textTransform: 'uppercase' }}>
                {s}
              </div>
            ))}
          </div>
          <button className="brutalist-btn brutalist-btn-secondary" onClick={() => { setPendingRequest(null); setRequestStatus('pending'); }}>
            <X size={16} /><span>Cancel Request</span>
          </button>
        </motion.div>
      )}

      {/* ═══════════════════════════════════════════════════
          VIEW 2 — HOST LOBBY
      ═══════════════════════════════════════════════════ */}
      {session && isHost && (
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>

          {/* Game code */}
          <div className="code-display-box">
            <div className="code-label">GAME CODE &bull; HOST ROOM</div>
            <div className="code-letters">
              {session.code.split('').map((char, i) => (
                <motion.div key={i} className="code-char" initial={{ rotateY: 90 }} animate={{ rotateY: 0 }} transition={{ delay: i * 0.1, duration: 0.4 }}>
                  {char}
                </motion.div>
              ))}
            </div>
            <button className="brutalist-btn brutalist-btn-secondary" onClick={copyCode} style={{ fontSize: '0.85rem', padding: '8px 12px' }}>
              {copiedCode ? <Check size={16} /> : <Copy size={16} />}
              <span>{copiedCode ? 'Copied!' : 'Copy Code'}</span>
            </button>
          </div>

          {/* Pending join requests */}
          {gameState?.pendingRequests?.length > 0 && (
            <motion.div className="brutalist-card request-card" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
              <div className="card-title"><UserPlus size={22} /><span>Join Requests ({gameState.pendingRequests.length})</span></div>
              {gameState.pendingRequests.map(r => (
                <div key={r.requestId} className="request-row">
                  <span style={{ fontWeight: '700' }}>{r.name}</span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="brutalist-btn" style={{ width: 'auto', padding: '6px 12px', fontSize: '0.85rem' }} onClick={() => handleHandleRequest(r.requestId, 'approve')}>
                      <Check size={14} /><span>Approve</span>
                    </button>
                    <button className="brutalist-btn brutalist-btn-dark" style={{ width: 'auto', padding: '6px 12px', fontSize: '0.85rem' }} onClick={() => handleHandleRequest(r.requestId, 'deny')}>
                      <X size={14} /><span>Deny</span>
                    </button>
                  </div>
                </div>
              ))}
            </motion.div>
          )}

          {/* Role counts */}
          {gameState && (
            <div className="brutalist-card">
              <div className="card-title"><Shield size={22} /><span>Configure Roles</span></div>

              {[
                { label: 'Traitors', icon: Skull, key: 'traitors', min: 1 },
                { label: 'Doctors', icon: Stethoscope, key: 'doctors', min: 0 },
                { label: 'Detectives', icon: Search, key: 'detectives', min: 0 },
              ].map(({ label, icon: Icon, key, min }) => (
                <div key={key} className="stepper-row">
                  <div className="stepper-label"><Icon size={18} /><span>{label}</span></div>
                  <div className="stepper-controls">
                    <button className="stepper-btn" onClick={() => handleUpdateCounts({ ...gameState.counts, [key]: Math.max(min, (gameState.counts[key] || 0) - 1) })}>-</button>
                    <span className="stepper-val">{gameState.counts[key] || 0}</span>
                    <button className="stepper-btn" onClick={() => handleUpdateCounts({ ...gameState.counts, [key]: (gameState.counts[key] || 0) + 1 })}>+</button>
                  </div>
                </div>
              ))}

              {(() => {
                const totalP = gameState.totalPlayers || 0;
                const spec = (gameState.counts?.traitors || 0) + (gameState.counts?.doctors || 0) + (gameState.counts?.detectives || 0);
                const villagers = totalP - spec;
                const isInvalid = totalP < 2 || villagers < 0;
                const canShuffle = totalP >= 2 && spec <= totalP;
                return (
                  <>
                    <div style={{ marginTop: '12px', padding: '12px', border: 'var(--border-thick)', background: isInvalid ? '#FFD1D1' : 'var(--neon-mint)', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Wheat size={18} /><span>Villagers (Auto)</span></div>
                      <span style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem' }}>{villagers >= 0 ? villagers : 'Invalid'}</span>
                    </div>
                    <button className="brutalist-btn" onClick={handleShuffle} disabled={!canShuffle || loading} style={{ marginTop: '20px' }}>
                      <Shuffle size={20} /><span>{gameState.round === 0 ? 'Shuffle and Deal' : 'Reshuffle New Round'}</span>
                    </button>
                  </>
                );
              })()}
            </div>
          )}

          {/* Player roster */}
          {gameState && (
            <div className="brutalist-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <div className="card-title" style={{ margin: 0 }}><Users size={22} /><span>Players ({gameState.totalPlayers})</span></div>
                <div style={{ fontWeight: '700', fontSize: '0.9rem', background: '#000', color: '#39FFB4', padding: '4px 8px' }}>
                  {gameState.confirmedCount || 0}/{gameState.totalPlayers || 0} confirmed
                </div>
              </div>

              {gameState.players?.length === 0 ? (
                <p style={{ fontWeight: '500', color: '#64748B', fontStyle: 'italic' }}>
                  Waiting for players to join using code <strong>{session.code}</strong>...
                </p>
              ) : (
                <div className="player-list">
                  <AnimatePresence>
                    {gameState.players.map(p => (
                      <motion.div key={p.id} className="player-item" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                          <span>{p.name}</span>
                          {gameState.round > 0 && (
                            p.acked
                              ? <span className="player-ack-badge confirmed"><Check size={14} /> Hidden</span>
                              : <span className="player-ack-badge waiting">Viewing</span>
                          )}
                        </div>
                        <button
                          title={`Make ${p.name} the new host`}
                          onClick={() => setSelectedTransferPlayer(p)}
                          style={{ padding: '4px 8px', fontSize: '0.75rem', fontWeight: '700', border: 'var(--border-thick)', background: 'var(--white)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                        >
                          <Crown size={14} /><span>Pass Host</span>
                        </button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          )}

          {/* Transfer host modal */}
          <AnimatePresence>
            {selectedTransferPlayer && (
              <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <motion.div className="brutalist-card" style={{ maxWidth: '380px', width: '90%' }} initial={{ scale: 0.85 }} animate={{ scale: 1 }}>
                  <div className="card-title"><Crown size={22} /><span>Transfer Host Duty?</span></div>
                  <p style={{ fontWeight: '500', marginBottom: '16px' }}>
                    Make <strong>{selectedTransferPlayer.name}</strong> the new host? You will step down and leave the room.
                  </p>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button className="brutalist-btn" onClick={() => handleTransferHost(selectedTransferPlayer.id)} disabled={loading}>Confirm Transfer</button>
                    <button className="brutalist-btn brutalist-btn-secondary" onClick={() => setSelectedTransferPlayer(null)}>Cancel</button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Danger zone */}
          <button className="brutalist-btn brutalist-btn-dark" onClick={handleDestroyGame} style={{ marginTop: '8px' }}>
            <Trash2 size={18} /><span>End &amp; Delete Game Instance</span>
          </button>
        </motion.div>
      )}

      {/* ═══════════════════════════════════════════════════
          VIEW 3 — PLAYER SCREEN
      ═══════════════════════════════════════════════════ */}
      {session && isPlayer && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>

          {/* Player header */}
          <div style={{ background: '#000', color: '#FFF', padding: '12px 16px', border: 'var(--border-thick)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#39FFB4', textTransform: 'uppercase', fontFamily: 'var(--font-heading)' }}>PLAYER &bull; {session.code}</div>
              <div style={{ fontWeight: '700', fontSize: '1.1rem' }}>{session.name}</div>
            </div>
            <button onClick={handleLeavePlayer} style={{ background: 'none', border: 'none', color: '#FFF', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', fontWeight: '700' }}>
              <LogOut size={16} /> Exit
            </button>
          </div>

          {/* Players in this room (always visible) */}
          {gameState?.players?.length > 0 && (
            <div className="brutalist-card" style={{ marginBottom: '16px' }}>
              <div className="card-title" style={{ marginBottom: '10px' }}><Users size={20} /><span>Players in this room ({gameState.totalPlayers})</span></div>
              <div className="player-list">
                {gameState.players.map(p => (
                  <div key={p.id} className="player-item" style={{ boxShadow: 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: p.id === session.playerId ? '800' : '600' }}>
                        {p.name}{p.id === session.playerId ? ' (you)' : ''}
                      </span>
                    </div>
                    {gameState.round > 0 && (
                      p.acked
                        ? <span className="player-ack-badge confirmed"><Check size={14} /> Hidden</span>
                        : <span className="player-ack-badge waiting">Viewing</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STATE A — Waiting for deal */}
          {(!gameState?.dealStarted || gameState?.round === 0) && (
            <div className="brutalist-card" style={{ textAlign: 'center', padding: '36px 20px' }}>
              <Users size={40} style={{ marginBottom: '12px' }} />
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', marginBottom: '8px' }}>YOU ARE IN THE ROOM</h2>
              <p style={{ fontWeight: '500', color: '#475569' }}>
                Waiting for the host to set roles and tap <strong>Shuffle and deal</strong>…
              </p>
            </div>
          )}

          {/* STATE B — Role reveal */}
          {gameState?.dealStarted && gameState?.round > 0 && gameState?.role && (!gameState?.acked || isPeekingRole) && (
            <div>
              {revealState === 'REVEALING' && (
                <div className="role-card-display role-card-doctor">
                  <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-heading)', textTransform: 'uppercase', marginBottom: '12px' }}>DEAL IN PROGRESS…</div>
                  <motion.div key={slotRole} initial={{ scale: 0.8, rotate: -5 }} animate={{ scale: 1.1, rotate: 0 }} transition={{ duration: 0.08 }}>
                    {React.createElement(ROLE_INFO[slotRole]?.icon || Wheat, { size: 64 })}
                    <div className="role-title-huge">{slotRole}</div>
                  </motion.div>
                </div>
              )}

              {(revealState === 'REVEALED' || isPeekingRole) && (() => {
                const info = ROLE_INFO[gameState.role] || ROLE_INFO.Villager;
                const RoleIcon = info.icon;
                return (
                  <motion.div className={`role-card-display ${info.cardClass}`} initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }}>
                    <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-heading)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px' }}>YOUR SECRET ROLE</div>
                    {gameState.role === 'Detective' ? (
                      <div className="detective-inner">
                        <RoleIcon size={64} style={{ margin: '0 auto' }} />
                        <div className="role-title-huge">{info.name}</div>
                        <div className="role-tip-box">{info.tip}</div>
                      </div>
                    ) : (
                      <><RoleIcon size={64} style={{ margin: '0 auto' }} /><div className="role-title-huge">{info.name}</div><div className="role-tip-box">{info.tip}</div></>
                    )}
                    <button className="brutalist-btn brutalist-btn-dark" onClick={handleAckRole} style={{ marginTop: '24px' }}>
                      <Lock size={20} /><span>{isPeekingRole ? 'Hide Role Again' : "I've seen it. Hide"}</span>
                    </button>
                  </motion.div>
                );
              })()}
            </div>
          )}

          {/* STATE C — Role hidden with peek option */}
          {gameState?.dealStarted && gameState?.acked && !isPeekingRole && (
            <motion.div className="locked-box" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
              <div className="lock-pulse-ring"><Lock size={48} color="#39FFB4" /></div>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.6rem', marginBottom: '8px', color: '#39FFB4' }}>ROLE HIDDEN</h2>
              <p style={{ fontWeight: '500', color: '#E2E8F0', maxWidth: '300px', margin: '0 auto 20px auto' }}>
                Your secret role is locked. Keep your phone concealed.
              </p>
              <button className="brutalist-btn" onClick={() => setIsPeekingRole(true)} style={{ fontSize: '0.95rem', marginBottom: '12px' }}>
                <Eye size={18} /><span>See Secret Role Again</span>
              </button>
              <div style={{ fontSize: '0.8rem', fontWeight: '700', color: '#94A3B8' }}>Waiting for host to reshuffle…</div>
            </motion.div>
          )}
        </motion.div>
      )}
    </>
  );
}
