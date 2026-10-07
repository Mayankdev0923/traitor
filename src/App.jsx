import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import {
  Skull,
  Stethoscope,
  Search,
  Wheat,
  Lock,
  Shuffle,
  Copy,
  Users,
  Check,
  Plus,
  Minus,
  AlertCircle,
  LogOut,
  Shield,
  Sparkles,
  Eye,
  Crown,
  Trash2
} from 'lucide-react';

const STORAGE_KEY = 'traitors_session_v1';

const ROLE_INFO = {
  Traitor: {
    name: 'Traitor',
    icon: Skull,
    cardClass: 'role-card-traitor',
    tip: 'Blend in, orchestrate murders at night, and eliminate all loyal villagers.',
  },
  Doctor: {
    name: 'Doctor',
    icon: Stethoscope,
    cardClass: 'role-card-doctor',
    tip: 'Save one player from elimination each round. Protect the innocent.',
  },
  Detective: {
    name: 'Detective',
    icon: Search,
    cardClass: 'role-card-detective',
    tip: 'Investigate one player\'s identity each night to uncover traitors.',
  },
  Villager: {
    name: 'Villager',
    icon: Wheat,
    cardClass: 'role-card-villager',
    tip: 'Spot deceit in discussions, root out the traitors, and vote wisely.',
  },
};

const SLOT_ROLES = ['Traitor', 'Doctor', 'Detective', 'Villager'];

export default function App() {
  const [session, setSession] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  });

  const [inputCode, setInputCode] = useState('');
  const [inputName, setInputName] = useState('');

  const [gameState, setGameState] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [loading, setLoading] = useState(false);

  // Peek role state for player
  const [isPeekingRole, setIsPeekingRole] = useState(false);

  // Transfer host modal state
  const [selectedTransferPlayer, setSelectedTransferPlayer] = useState(null);

  // Reveal animation states
  const [revealState, setRevealState] = useState('IDLE');
  const [slotRole, setSlotRole] = useState('Villager');
  const lastRoundRef = useRef(0);

  useEffect(() => {
    if (session) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [session]);

  // Polling loop
  useEffect(() => {
    if (!session?.code) {
      setGameState(null);
      return;
    }

    let isMounted = true;
    const fetchState = async () => {
      try {
        const payload = {
          action: 'state',
          code: session.code,
        };
        if (session.hostKey) payload.hostKey = session.hostKey;
        if (session.playerId) payload.playerId = session.playerId;

        const res = await fetch('/api/game', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (!isMounted) return;

        if (res.ok) {
          setErrorMsg('');
          setGameState(data);

          // Handle automatic promotion to host if host transferred to this player
          if (data.isHost && data.hostKey && session.playerId && !session.hostKey) {
            setSession({
              code: session.code,
              hostKey: data.hostKey,
            });
          }

          // Trigger slot machine reveal when a new round starts and role is un-acked
          if (!data.isHost && data.role && !data.acked) {
            if (data.round !== lastRoundRef.current) {
              lastRoundRef.current = data.round;
              setIsPeekingRole(false);
              triggerSlotReveal();
            }
          }
        } else {
          if (res.status === 404 || res.status === 401) {
            setErrorMsg(data.error || 'Game session ended or host left.');
            setSession(null);
          }
        }
      } catch (err) {
        if (isMounted) console.error('Poll error:', err);
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 1500);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [session]);

  const triggerSlotReveal = () => {
    setRevealState('REVEALING');
    let cycles = 0;
    const interval = setInterval(() => {
      setSlotRole(SLOT_ROLES[cycles % SLOT_ROLES.length]);
      cycles++;
      if (cycles >= 10) {
        clearInterval(interval);
        setRevealState('REVEALED');
        try {
          confetti({ particleCount: 40, spread: 60, origin: { y: 0.6 } });
        } catch (e) {}
      }
    }, 100);
  };

  const handleCreateGame = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create' }),
      });
      const data = await res.json();
      if (res.ok) {
        setSession({
          code: data.code,
          hostKey: data.hostKey,
        });
      } else {
        setErrorMsg(data.error || 'Failed to create game.');
      }
    } catch (err) {
      setErrorMsg('Network error. Check connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinGame = async (e) => {
    e?.preventDefault();
    const code = inputCode.trim().toUpperCase();
    const name = inputName.trim();
    if (!code || code.length !== 4) {
      setErrorMsg('Please enter a 4-character game code.');
      return;
    }
    if (!name) {
      setErrorMsg('Please enter your player name.');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'join', code, name }),
      });
      const data = await res.json();
      if (res.ok) {
        setSession({
          code: data.code,
          playerId: data.playerId,
          name: data.name,
        });
      } else {
        setErrorMsg(data.error || 'Could not join game.');
      }
    } catch (err) {
      setErrorMsg('Network error. Check connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateCounts = async (newCounts) => {
    if (!session?.hostKey) return;
    try {
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'counts',
          code: session.code,
          hostKey: session.hostKey,
          counts: newCounts,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setGameState((prev) => ({ ...prev, counts: data.counts }));
      }
    } catch (err) {
      console.error('Count update error:', err);
    }
  };

  const handleShuffle = async () => {
    if (!session?.hostKey) return;
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'shuffle',
          code: session.code,
          hostKey: session.hostKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Could not shuffle roles.');
      }
    } catch (err) {
      setErrorMsg('Failed to shuffle roles. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleAckRole = async () => {
    if (!session?.playerId) return;
    try {
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'ack',
          code: session.code,
          playerId: session.playerId,
        }),
      });
      if (res.ok) {
        setGameState((prev) => ({
          ...prev,
          acked: true,
        }));
        setIsPeekingRole(false);
        setRevealState('IDLE');
      }
    } catch (err) {
      console.error('Ack error:', err);
    }
  };

  const handleTransferHost = async (targetPlayerId) => {
    if (!session?.hostKey || !targetPlayerId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'leave',
          code: session.code,
          hostKey: session.hostKey,
          newHostPlayerId: targetPlayerId,
        }),
      });
      if (res.ok) {
        setSession(null);
        setGameState(null);
        setSelectedTransferPlayer(null);
      }
    } catch (err) {
      setErrorMsg('Failed to transfer host.');
    } finally {
      setLoading(false);
    }
  };

  const handleDestroyGame = async () => {
    if (!session?.hostKey) return;
    if (!window.confirm('Are you sure you want to end and remove this game instance?')) return;
    try {
      await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'leave',
          code: session.code,
          hostKey: session.hostKey,
        }),
      });
    } catch (e) {}
    setSession(null);
    setGameState(null);
  };

  const handleLeavePlayer = async () => {
    if (session?.code) {
      try {
        await fetch('/api/game', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'leave',
            code: session.code,
            playerId: session.playerId,
          }),
        });
      } catch (e) {}
    }
    setSession(null);
    setGameState(null);
    setErrorMsg('');
  };

  const copyCodeToClipboard = () => {
    if (!session?.code) return;
    navigator.clipboard.writeText(session.code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const isHost = gameState?.isHost || !!session?.hostKey;
  const isPlayer = !!session?.playerId;

  return (
    <>
      {/* Top Scrolling Marquee Banner */}
      <div className="marquee-container">
        <div className="marquee-track">
          TRAITORS ROLE DEALER &bull; TRUST NO ONE &bull; DO NOT SHOW YOUR SCREEN &bull; SHUFFLE &amp; DEAL &bull; KEEP YOUR SECRET &bull;&nbsp;
          TRAITORS ROLE DEALER &bull; TRUST NO ONE &bull; DO NOT SHOW YOUR SCREEN &bull; SHUFFLE &amp; DEAL &bull; KEEP YOUR SECRET &bull;&nbsp;
        </div>
      </div>

      {/* Header Wordmark */}
      <motion.header
        className="app-header"
        initial={{ y: -40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 15 }}
      >
        <h1 className="wordmark">TRAITORS</h1>
        <div className="subhead">ROLE DEALER</div>
      </motion.header>

      {/* Global Error Banner */}
      {errorMsg && (
        <motion.div
          className="error-banner"
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
        >
          <AlertCircle size={20} />
          <span>{errorMsg}</span>
        </motion.div>
      )}

      {/* VIEW 1: LANDING SCREEN */}
      {!session && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="brutalist-card"
        >
          <div className="card-title">
            <Users size={22} />
            <span>Join or Create</span>
          </div>

          <form onSubmit={handleJoinGame} style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', fontWeight: '700', fontSize: '0.85rem', marginBottom: '6px', textTransform: 'uppercase' }}>
              Your Name
            </label>
            <input
              type="text"
              className="brutalist-input"
              placeholder="e.g. Alex"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              maxLength={20}
            />

            <label style={{ display: 'block', fontWeight: '700', fontSize: '0.85rem', marginBottom: '6px', textTransform: 'uppercase' }}>
              4-Letter Game Code
            </label>
            <input
              type="text"
              className="brutalist-input"
              placeholder="e.g. K9X4"
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.toUpperCase())}
              maxLength={4}
              style={{ letterSpacing: '4px', textTransform: 'uppercase' }}
            />

            <button
              type="submit"
              className="brutalist-btn"
              disabled={loading}
            >
              <Users size={20} />
              <span>Join Game</span>
            </button>
          </form>

          <div style={{ borderTop: '3px solid #000', paddingTop: '20px', textAlign: 'center' }}>
            <p style={{ fontWeight: '700', fontSize: '0.9rem', marginBottom: '12px', textTransform: 'uppercase' }}>
              Hosting a new table?
            </p>
            <button
              type="button"
              className="brutalist-btn brutalist-btn-dark"
              onClick={handleCreateGame}
              disabled={loading}
            >
              <Sparkles size={20} />
              <span>Create Game (Host)</span>
            </button>
          </div>
        </motion.div>
      )}

      {/* VIEW 2: HOST LOBBY */}
      {session && isHost && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          {/* Game Code Display */}
          <div className="code-display-box">
            <div className="code-label">GAME CODE &bull; HOST ROOM</div>
            <div className="code-letters">
              {session.code.split('').map((char, index) => (
                <motion.div
                  key={index}
                  className="code-char"
                  initial={{ rotateY: 90 }}
                  animate={{ rotateY: 0 }}
                  transition={{ delay: index * 0.1, duration: 0.4 }}
                >
                  {char}
                </motion.div>
              ))}
            </div>
            <button
              className="brutalist-btn brutalist-btn-secondary"
              onClick={copyCodeToClipboard}
              style={{ fontSize: '0.85rem', padding: '8px 12px' }}
            >
              {copiedCode ? <Check size={16} /> : <Copy size={16} />}
              <span>{copiedCode ? 'Code Copied!' : 'Copy Code'}</span>
            </button>
          </div>

          {/* Role Counts Controls */}
          {gameState && (
            <div className="brutalist-card">
              <div className="card-title">
                <Shield size={22} />
                <span>Configure Roles</span>
              </div>

              {/* Traitors Stepper */}
              <div className="stepper-row">
                <div className="stepper-label">
                  <Skull size={18} />
                  <span>Traitors</span>
                </div>
                <div className="stepper-controls">
                  <button
                    className="stepper-btn"
                    onClick={() =>
                      handleUpdateCounts({
                        ...gameState.counts,
                        traitors: Math.max(1, (gameState.counts.traitors || 1) - 1),
                      })
                    }
                  >
                    -
                  </button>
                  <span className="stepper-val">{gameState.counts.traitors || 0}</span>
                  <button
                    className="stepper-btn"
                    onClick={() =>
                      handleUpdateCounts({
                        ...gameState.counts,
                        traitors: (gameState.counts.traitors || 0) + 1,
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Doctors Stepper */}
              <div className="stepper-row">
                <div className="stepper-label">
                  <Stethoscope size={18} />
                  <span>Doctors</span>
                </div>
                <div className="stepper-controls">
                  <button
                    className="stepper-btn"
                    onClick={() =>
                      handleUpdateCounts({
                        ...gameState.counts,
                        doctors: Math.max(0, (gameState.counts.doctors || 0) - 1),
                      })
                    }
                  >
                    -
                  </button>
                  <span className="stepper-val">{gameState.counts.doctors || 0}</span>
                  <button
                    className="stepper-btn"
                    onClick={() =>
                      handleUpdateCounts({
                        ...gameState.counts,
                        doctors: (gameState.counts.doctors || 0) + 1,
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Detectives Stepper */}
              <div className="stepper-row">
                <div className="stepper-label">
                  <Search size={18} />
                  <span>Detectives</span>
                </div>
                <div className="stepper-controls">
                  <button
                    className="stepper-btn"
                    onClick={() =>
                      handleUpdateCounts({
                        ...gameState.counts,
                        detectives: Math.max(0, (gameState.counts.detectives || 0) - 1),
                      })
                    }
                  >
                    -
                  </button>
                  <span className="stepper-val">{gameState.counts.detectives || 0}</span>
                  <button
                    className="stepper-btn"
                    onClick={() =>
                      handleUpdateCounts({
                        ...gameState.counts,
                        detectives: (gameState.counts.detectives || 0) + 1,
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Villagers Auto Calculated */}
              {(() => {
                const totalP = gameState.totalPlayers || 0;
                const spec = (gameState.counts?.traitors || 0) + (gameState.counts?.doctors || 0) + (gameState.counts?.detectives || 0);
                const villagers = totalP - spec;
                const isInvalid = totalP < 2 || villagers < 0;

                return (
                  <div
                    style={{
                      marginTop: '12px',
                      padding: '12px',
                      border: 'var(--border-thick)',
                      background: isInvalid ? '#FFD1D1' : 'var(--neon-mint)',
                      fontWeight: '700',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Wheat size={18} />
                      <span>Villagers (Auto)</span>
                    </div>
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem' }}>
                      {villagers >= 0 ? villagers : 'Invalid'}
                    </span>
                  </div>
                );
              })()}

              {/* Shuffle Action Button */}
              {(() => {
                const totalP = gameState.totalPlayers || 0;
                const spec = (gameState.counts?.traitors || 0) + (gameState.counts?.doctors || 0) + (gameState.counts?.detectives || 0);
                const canShuffle = totalP >= 2 && spec <= totalP;

                return (
                  <button
                    className="brutalist-btn"
                    onClick={handleShuffle}
                    disabled={!canShuffle || loading}
                    style={{ marginTop: '20px' }}
                  >
                    <Shuffle size={20} />
                    <span>
                      {gameState.round === 0 ? 'Shuffle and Deal' : 'Reshuffle New Round'}
                    </span>
                  </button>
                );
              })()}
            </div>
          )}

          {/* Player Roster & Confirmed Status */}
          {gameState && (
            <div className="brutalist-card">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '14px',
                }}
              >
                <div className="card-title" style={{ margin: 0 }}>
                  <Users size={22} />
                  <span>Players ({gameState.totalPlayers})</span>
                </div>
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
                    {gameState.players?.map((p) => (
                      <motion.div
                        key={p.id}
                        className="player-item"
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span>{p.name}</span>
                          {gameState.round > 0 && (
                            p.acked ? (
                              <span className="player-ack-badge confirmed">
                                <Check size={14} /> Hidden
                              </span>
                            ) : (
                              <span className="player-ack-badge waiting">Viewing</span>
                            )
                          )}
                        </div>

                        {/* Host Transfer Action */}
                        <button
                          className="brutalist-btn-icon"
                          title={`Make ${p.name} the new Host`}
                          onClick={() => setSelectedTransferPlayer(p)}
                          style={{
                            padding: '4px 8px',
                            fontSize: '0.75rem',
                            fontWeight: '700',
                            border: 'var(--border-thick)',
                            background: 'var(--white)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                        >
                          <Crown size={14} color="#000" />
                          <span>Pass Host</span>
                        </button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          )}

          {/* Transfer Host Modal */}
          {selectedTransferPlayer && (
            <div className="modal-overlay">
              <div className="brutalist-card" style={{ maxWidth: '380px', width: '90%' }}>
                <div className="card-title">
                  <Crown size={22} />
                  <span>Transfer Host Duty?</span>
                </div>
                <p style={{ fontWeight: '500', marginBottom: '16px' }}>
                  Make <strong>{selectedTransferPlayer.name}</strong> the new host? You will step down as host and leave the room.
                </p>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    className="brutalist-btn"
                    onClick={() => handleTransferHost(selectedTransferPlayer.id)}
                    disabled={loading}
                  >
                    Confirm Transfer
                  </button>
                  <button
                    className="brutalist-btn brutalist-btn-secondary"
                    onClick={() => setSelectedTransferPlayer(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Host Room Management Controls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '16px' }}>
            <button
              className="brutalist-btn brutalist-btn-dark"
              onClick={handleDestroyGame}
            >
              <Trash2 size={18} />
              <span>End &amp; Delete Game Instance</span>
            </button>
          </div>
        </motion.div>
      )}

      {/* VIEW 3: PLAYER SCREEN */}
      {session && isPlayer && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {/* Header Banner for Player */}
          <div style={{ background: '#000', color: '#FFF', padding: '12px 16px', border: 'var(--border-thick)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#39FFB4', textTransform: 'uppercase', fontFamily: 'var(--font-heading)' }}>
                PLAYER &bull; {session.code}
              </div>
              <div style={{ fontWeight: '700', fontSize: '1.1rem' }}>{session.name}</div>
            </div>
            <button
              onClick={handleLeavePlayer}
              style={{ background: 'none', border: 'none', color: '#FFF', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', fontWeight: '700' }}
            >
              <LogOut size={16} /> Exit
            </button>
          </div>

          {/* STATE A: WAITING FOR HOST DEAL */}
          {(!gameState?.dealStarted || gameState?.round === 0) && (
            <div className="brutalist-card" style={{ textAlign: 'center', padding: '36px 20px' }}>
              <Users size={40} style={{ marginBottom: '12px' }} />
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', marginBottom: '8px' }}>
                YOU ARE IN THE ROOM
              </h2>
              <p style={{ fontWeight: '500', color: '#475569' }}>
                Waiting for the host to set roles and tap <strong>Shuffle and deal</strong>...
              </p>
            </div>
          )}

          {/* STATE B: ROLE DEALT OR PEEKING ROLE */}
          {gameState?.dealStarted && gameState?.round > 0 && gameState?.role && (!gameState?.acked || isPeekingRole) && (
            <div>
              {revealState === 'REVEALING' && (
                <div className="role-card-display role-card-doctor">
                  <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-heading)', textTransform: 'uppercase', marginBottom: '12px' }}>
                    DEAL IN PROGRESS...
                  </div>
                  <motion.div
                    key={slotRole}
                    initial={{ scale: 0.8, rotate: -5 }}
                    animate={{ scale: 1.1, rotate: 0 }}
                    transition={{ duration: 0.08 }}
                  >
                    {React.createElement(ROLE_INFO[slotRole]?.icon || Wheat, { size: 64 })}
                    <div className="role-title-huge">{slotRole}</div>
                  </motion.div>
                </div>
              )}

              {(revealState === 'REVEALED' || isPeekingRole) && (() => {
                const info = ROLE_INFO[gameState.role] || ROLE_INFO.Villager;
                const RoleIcon = info.icon;

                return (
                  <motion.div
                    className={`role-card-display ${info.cardClass}`}
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                  >
                    <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-heading)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px' }}>
                      YOUR SECRET ROLE
                    </div>

                    {gameState.role === 'Detective' ? (
                      <div className="detective-inner">
                        <RoleIcon size={64} style={{ margin: '0 auto' }} />
                        <div className="role-title-huge">{info.name}</div>
                        <div className="role-tip-box">{info.tip}</div>
                      </div>
                    ) : (
                      <>
                        <RoleIcon size={64} style={{ margin: '0 auto' }} />
                        <div className="role-title-huge">{info.name}</div>
                        <div className="role-tip-box">{info.tip}</div>
                      </>
                    )}

                    <button
                      className="brutalist-btn brutalist-btn-dark"
                      onClick={handleAckRole}
                      style={{ marginTop: '24px' }}
                    >
                      <Lock size={20} />
                      <span>{isPeekingRole ? 'Hide Role Again' : "I've seen it. Hide"}</span>
                    </button>
                  </motion.div>
                );
              })()}
            </div>
          )}

          {/* STATE C: LOCKED / HIDDEN STATE (WITH PEEK OPTION) */}
          {gameState?.dealStarted && gameState?.acked && !isPeekingRole && (
            <motion.div
              className="locked-box"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
            >
              <div className="lock-pulse-ring">
                <Lock size={48} color="#39FFB4" />
              </div>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.6rem', marginBottom: '8px', color: '#39FFB4' }}>
                ROLE HIDDEN
              </h2>
              <p style={{ fontWeight: '500', color: '#E2E8F0', maxWidth: '300px', margin: '0 auto 16px auto' }}>
                Your secret role is locked and hidden from view. Keep your phone concealed.
              </p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
                <button
                  className="brutalist-btn"
                  onClick={() => setIsPeekingRole(true)}
                  style={{ fontSize: '0.95rem' }}
                >
                  <Eye size={18} />
                  <span>See Secret Role Again</span>
                </button>

                <div style={{ fontSize: '0.8rem', fontWeight: '700', color: '#94A3B8' }}>
                  Waiting for host to reshuffle...
                </div>
              </div>
            </motion.div>
          )}
        </motion.div>
      )}
    </>
  );
}
