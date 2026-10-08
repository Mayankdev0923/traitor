import crypto from 'node:crypto';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REST_API_URL || process.env.REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REST_API_TOKEN || process.env.REDIS_REST_TOKEN;
const isRedisConfigured = !!(REDIS_URL && REDIS_TOKEN);
const TTL = 86400;
const MAX_PLAYERS = 40;
const MAX_PENDING = 30;

// ---- in-memory fallback (local dev only) ----
const memory = new Map();
function memCmd(cmd) {
  const op = String(cmd[0]).toUpperCase(), k = cmd[1];
  const get = (t) => { const it = memory.get(k); return it && it.type === t ? it.value : null; };
  const ensure = (t, mk) => { let it = memory.get(k); if (!it || it.type !== t) { it = { type: t, value: mk() }; memory.set(k, it); } return it.value; };
  switch (op) {
    case 'SET': if (cmd.includes('NX') && memory.has(k)) return null; memory.set(k, { type: 'string', value: cmd[2] }); return 'OK';
    case 'GET': return get('string');
    case 'HSET': { const h = ensure('hash', () => new Map()); for (let i = 2; i < cmd.length; i += 2) h.set(cmd[i], cmd[i + 1]); return 1; }
    case 'HGET': { const h = get('hash'); return h ? (h.get(cmd[2]) ?? null) : null; }
    case 'HGETALL': { const h = get('hash'); const f = []; if (h) for (const [a, b] of h) f.push(a, b); return f; }
    case 'HDEL': { const h = get('hash'); if (h) for (let i = 2; i < cmd.length; i++) h.delete(cmd[i]); return 1; }
    case 'DEL': for (let i = 1; i < cmd.length; i++) memory.delete(cmd[i]); return 1;
    case 'SADD': { const s = ensure('set', () => new Set()); for (let i = 2; i < cmd.length; i++) s.add(cmd[i]); return 1; }
    case 'SREM': { const s = get('set'); if (s) s.delete(cmd[2]); return 1; }
    case 'SMEMBERS': { const s = get('set'); return s ? [...s] : []; }
    case 'PING': return 'PONG';
    default: return 1; // EXPIRE etc.
  }
}

async function redis(cmds) {
  if (!isRedisConfigured) return cmds.map(memCmd);
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  const data = await r.json();
  for (const it of data) if (it && it.error) throw new Error('Redis command error: ' + it.error);
  return data.map((x) => x.result);
}

// ---- helpers ----
const parseHash = (a) => { const o = {}; if (Array.isArray(a)) for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pub = (id) => sha(id).slice(0, 10); // public handle; the real playerId stays secret
const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cleanName = (n) => String(n ?? '').replace(/\s+/g, ' ').trim();
const nameErr = (n) => (!n ? 'Please enter a valid name.' : n.length > 20 ? 'Name is too long (max 20 characters).' : null);
const taken = (n, list) => list.some((x) => String(x).toLowerCase() === n.toLowerCase());
const nOf = (v) => Math.min(50, Math.max(0, parseInt(v, 10) || 0));
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const genCode = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
const genSecret = () => crypto.randomBytes(16).toString('hex');
function cryptoShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Traitors win when they equal/outnumber the other living players; everyone else wins when no traitor is left.
function winnerOf(players, roles, dead) {
  const ids = Object.keys(roles).filter((id) => players[id]);
  if (!ids.some((id) => roles[id] === 'Traitor')) return null;
  const alive = ids.filter((id) => !dead[id]);
  const t = alive.filter((id) => roles[id] === 'Traitor').length;
  if (t === 0) return 'villagers';
  if (t >= alive.length - t) return 'traitors';
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try { const [p] = await redis([['PING']]); return res.status(200).json({ redisConfigured: isRedisConfigured, ping: p }); }
    catch (e) { return res.status(200).json({ redisConfigured: isRedisConfigured, error: e.message }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (!isRedisConfigured && process.env.VERCEL) return res.status(500).json({ error: 'Redis is not configured on this deployment.' });

  const fail = (s, m) => res.status(s).json({ error: m });

  try {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { action, hostKey, playerId, name, counts, requestId, clientToken, target, decision, stay } = body;
    const code = typeof body.code === 'string' ? body.code.toUpperCase().trim() : '';
    const K = (s) => `game:${code}:${s}`;

    // ---------- no code needed ----------
    if (action === 'list_games') {
      const [codes] = await redis([['SMEMBERS', 'games:index']]);
      if (!codes?.length) return res.status(200).json({ games: [] });
      const out = await redis([...codes.map((c) => ['GET', `game:${c}:meta`]), ...codes.map((c) => ['HGETALL', `game:${c}:players`])]);
      const games = [];
      for (let i = 0; i < codes.length; i++) {
        const meta = safeParse(out[i]);
        if (!meta) { await redis([['SREM', 'games:index', codes[i]]]); continue; }
        games.push({
          gameId: codes[i],
          hostName: meta.hostName || 'Host',
          playerCount: Object.keys(parseHash(out[codes.length + i])).length,
          round: meta.round,
          createdAt: meta.createdAt,
        });
      }
      return res.status(200).json({ games });
    }

    if (action === 'create') {
      const hn = cleanName(name);
      const e = nameErr(hn);
      if (e) return fail(400, e);
      const hostSecret = genSecret();
      const meta = { hostKey: hostSecret, hostPlayerId: null, hostName: hn, round: 0, counts: { traitors: 1, doctors: 1, detectives: 1 }, createdAt: Date.now() };
      let gameCode = null;
      for (let i = 0; i < 8 && !gameCode; i++) {
        const c = genCode();
        const [r] = await redis([['SET', `game:${c}:meta`, JSON.stringify(meta), 'NX', 'EX', TTL]]);
        if (r === 'OK') gameCode = c;
      }
      if (!gameCode) return fail(503, 'Could not create a game. Try again.');
      await redis([['SADD', 'games:index', gameCode], ['EXPIRE', 'games:index', TTL]]);
      return res.status(200).json({ success: true, code: gameCode, hostKey: hostSecret, hostName: hn });
    }

    // ---------- everything below needs a valid game ----------
    if (!/^[2-9A-HJ-NP-Z]{4}$/.test(code)) return fail(400, 'Invalid game code.');
    const [metaRaw] = await redis([
      ['GET', K('meta')], ['EXPIRE', K('meta'), TTL], ['EXPIRE', K('players'), TTL],
      ['EXPIRE', K('roles'), TTL], ['EXPIRE', K('acks'), TTL], ['EXPIRE', K('requests'), TTL],
      ['EXPIRE', K('dead'), TTL], ['EXPIRE', K('votes'), TTL],
    ]);
    const meta = safeParse(metaRaw);
    if (!meta) return fail(404, 'Game not found or host has left.');
    const saveMeta = () => ['SET', K('meta'), JSON.stringify(meta), 'EX', TTL];
    const removePlayerCmds = (id) => [['HDEL', K('players'), id], ['HDEL', K('roles'), id], ['HDEL', K('acks'), id], ['HDEL', K('dead'), id], ['HDEL', K('votes'), id]];
    const dropRequestsFor = async (id) => {
      const [rq] = await redis([['HGETALL', K('requests')]]);
      const del = Object.entries(parseHash(rq)).filter(([, v]) => safeParse(v)?.playerId === id).map(([rid]) => rid);
      if (del.length) await redis([['HDEL', K('requests'), ...del]]);
    };
    const isHostKey = safeEq(hostKey, meta.hostKey);
    const aliveEligible = (players, roles, dead) => Object.keys(roles).filter((id) => players[id] && !dead[id]);
    const loadAll = async () => {
      const [pl, rl, dd, vt] = await redis([['HGETALL', K('players')], ['HGETALL', K('roles')], ['HGETALL', K('dead')], ['HGETALL', K('votes')]]);
      return { players: parseHash(pl), roles: parseHash(rl), dead: parseHash(dd), votes: parseHash(vt) };
    };
    // Closes the open vote: highest count is eliminated; a tie or no votes eliminates nobody.
    const finalizeVote = async ({ players, roles, dead, votes }) => {
      const v = meta.vote;
      if (!v || v.status !== 'open') return;
      const eligible = aliveEligible(players, roles, dead);
      const count = {}, voters = {}; let skipped = 0, cast = 0;
      for (const id of eligible) {
        const t = votes[id];
        if (!t) continue;
        if (t === 'skip') { skipped++; cast++; continue; }
        if (!players[t] || dead[t]) continue;
        cast++; count[t] = (count[t] || 0) + 1; (voters[t] ||= []).push(players[id]);
      }
      const entries = Object.entries(count).sort((a, b) => b[1] - a[1]);
      let outcome = { type: 'none' }; const cmds = [];
      if (entries.length) {
        const tops = entries.filter((e) => e[1] === entries[0][1]);
        if (tops.length === 1) {
          const id = tops[0][0];
          outcome = { type: 'out', pid: pub(id), name: players[id] };
          dead[id] = '1'; cmds.push(['HSET', K('dead'), id, '1'], ['EXPIRE', K('dead'), TTL]);
        } else outcome = { type: 'tie', names: tops.map((e) => players[e[0]]) };
      }
      meta.lastVote = {
        id: v.id, at: Date.now(), skipped, notVoted: eligible.length - cast, outcome,
        tally: entries.map(([id, c]) => ({ pid: pub(id), name: players[id], count: c, voters: voters[id] || [] })),
      };
      meta.vote = null;
      await redis([...cmds, saveMeta()]);
    };

    // ---------- join flow (idempotent, so slow connections can't create duplicates) ----------
    if (action === 'request_join') {
      const n = cleanName(name); const e = nameErr(n);
      if (e) return fail(400, e);
      if (typeof clientToken !== 'string' || clientToken.length < 8) return fail(400, 'Missing client token.');
      const rid = 'r_' + sha(code + ':' + clientToken).slice(0, 16);
      const [existing, pl, rq] = await redis([['HGET', K('requests'), rid], ['HGETALL', K('players')], ['HGETALL', K('requests')]]);
      const ex = safeParse(existing);
      if (ex && ex.status !== 'denied') return res.status(200).json({ success: true, requestId: rid, name: ex.name });
      const others = Object.entries(parseHash(rq)).filter(([id]) => id !== rid).map(([, v]) => safeParse(v)).filter((r) => r && r.status === 'pending');
      if (others.length >= MAX_PENDING) return fail(429, 'Too many pending requests. Try again shortly.');
      if (taken(n, [...Object.values(parseHash(pl)), meta.hostName, ...others.map((r) => r.name)])) return fail(409, 'That name is already taken in this game.');
      await redis([['HSET', K('requests'), rid, JSON.stringify({ name: n, status: 'pending', playerId: null })], ['EXPIRE', K('requests'), TTL]]);
      return res.status(200).json({ success: true, requestId: rid, name: n });
    }

    if (action === 'poll_request') {
      if (!requestId) return fail(400, 'Request ID is required.');
      const [raw] = await redis([['HGET', K('requests'), String(requestId)]]);
      const r = safeParse(raw);
      if (!r) return fail(404, 'Join request not found or expired.');
      return res.status(200).json({ status: r.status, playerId: r.status === 'approved' ? r.playerId : null, name: r.name, code });
    }

    if (action === 'cancel_request') {
      const [raw] = await redis([['HGET', K('requests'), String(requestId || '')]]);
      if (safeParse(raw)?.status === 'pending') await redis([['HDEL', K('requests'), String(requestId)]]);
      return res.status(200).json({ success: true });
    }

    if (action === 'join') {
      const n = cleanName(name); const e = nameErr(n);
      if (e) return fail(400, e);
      if (typeof clientToken !== 'string' || clientToken.length < 8) return fail(400, 'Missing client token.');
      const pId = 'p_' + sha(code + ':join:' + clientToken).slice(0, 16);
      const [pl, rq] = await redis([['HGETALL', K('players')], ['HGETALL', K('requests')]]);
      const players = parseHash(pl);
      if (players[pId]) return res.status(200).json({ success: true, code, playerId: pId, name: players[pId] });
      if (Object.keys(players).length >= MAX_PLAYERS) return fail(400, 'This game is full.');
      const pending = Object.values(parseHash(rq)).map(safeParse).filter((r) => r && r.status === 'pending').map((r) => r.name);
      if (taken(n, [...Object.values(players), meta.hostName, ...pending])) return fail(409, 'That name is already taken in this game.');
      await redis([['HSET', K('players'), pId, n], ['EXPIRE', K('players'), TTL]]);
      return res.status(200).json({ success: true, code, playerId: pId, name: n });
    }

    // ---------- player actions ----------
    if (action === 'state') {
      const pid = typeof playerId === 'string' ? playerId : '';
      const [pl, ak, rl, dd, vt] = await redis([['HGETALL', K('players')], ['HGETALL', K('acks')], ['HGETALL', K('roles')], ['HGETALL', K('dead')], ['HGETALL', K('votes')]]);
      const all = { players: parseHash(pl), roles: parseHash(rl), dead: parseHash(dd), votes: parseHash(vt) };
      const { players, roles, dead, votes } = all;
      const acks = parseHash(ak);
      if (meta.vote?.status === 'open' && Date.now() >= meta.vote.endsAt) await finalizeVote(all); // timer ran out
      const winner = meta.round > 0 ? winnerOf(players, roles, dead) : null;
      const list = Object.keys(players)
        .map((id) => ({ id, pid: pub(id), name: players[id], acked: acks[id] === String(meta.round), dead: !!dead[id], voted: !!votes[id] && !dead[id] }))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.pid.localeCompare(b.pid));
      const eligible = aliveEligible(players, roles, dead);
      const vote = meta.vote ? { id: meta.vote.id, endsAt: meta.vote.endsAt, duration: meta.vote.duration, voted: eligible.filter((id) => votes[id]).length, eligible: eligible.length } : null;
      const finalRoles = winner ? Object.keys(roles).filter((id) => players[id]).map((id) => ({ name: players[id], role: roles[id], dead: !!dead[id] })) : undefined;
      const common = { code, round: meta.round, vote, lastVote: meta.lastVote || null, serverNow: Date.now(), winner, finalRoles };
      const promoted = !isHostKey && pid && meta.hostPlayerId && safeEq(pid, meta.hostPlayerId);

      if (isHostKey || promoted) {
        const [rq] = await redis([['HGETALL', K('requests')]]);
        const pendingRequests = Object.entries(parseHash(rq))
          .map(([rid, v]) => ({ rid, r: safeParse(v) }))
          .filter((x) => x.r && x.r.status === 'pending')
          .map((x) => ({ requestId: x.rid, name: x.r.name }));
        return res.status(200).json({
          ...common, isHost: true, hostKey: promoted ? meta.hostKey : undefined, counts: meta.counts,
          players: list.map(({ pid: h, name: n, acked, dead: d, voted }) => ({ pid: h, name: n, acked, dead: d, voted })),
          totalPlayers: list.length, confirmedCount: list.filter((p) => p.acked).length, pendingRequests,
          result: winner ? { winner, yourRole: null, youWon: null } : null,
        });
      }
      const joined = !!(pid && players[pid]);
      const mine = joined ? roles[pid] : null;
      const tv = joined ? votes[pid] : null;
      return res.status(200).json({
        ...common, isHost: false, joined, name: joined ? players[pid] : null, hostName: meta.hostName,
        dealStarted: meta.round > 0, hasRole: joined && meta.round > 0 && !!mine,
        acked: joined && acks[pid] === String(meta.round), totalPlayers: list.length,
        youDead: joined && !!dead[pid],
        myVote: tv === 'skip' ? 'skip' : tv && players[tv] ? pub(tv) : null,
        result: winner ? { winner, yourRole: mine || null, youWon: mine ? (mine === 'Traitor') === (winner === 'traitors') : null } : null,
        players: list.map(({ id, pid: h, name: n, acked, dead: d }) => ({ pid: h, name: n, acked, dead: d, you: id === pid })),
      });
    }

    if (action === 'reveal') {
      const pid = typeof playerId === 'string' ? playerId : '';
      const [member, role] = await redis([['HGET', K('players'), pid || 'none'], ['HGET', K('roles'), pid || 'none']]);
      if (!member) return fail(403, 'You are not in this game.');
      if (meta.round < 1 || !role) return fail(400, 'No role dealt to you yet.');
      return res.status(200).json({ role, round: meta.round });
    }

    if (action === 'ack') {
      const pid = typeof playerId === 'string' ? playerId : '';
      const [member] = await redis([['HGET', K('players'), pid || 'none']]);
      if (!member) return fail(403, 'You are not in this game.');
      await redis([['HSET', K('acks'), pid, String(meta.round)], ['EXPIRE', K('acks'), TTL]]);
      return res.status(200).json({ success: true, acked: true });
    }

    if (action === 'vote_cast') {
      const pid = typeof playerId === 'string' ? playerId : '';
      const { players, roles, dead } = await loadAll();
      if (!players[pid]) return fail(403, 'You are not in this game.');
      if (!roles[pid]) return fail(400, 'You have no role this round, so you cannot vote.');
      if (dead[pid]) return fail(403, 'Eliminated players cannot vote.');
      const v = meta.vote;
      if (!v || v.status !== 'open' || Date.now() >= v.endsAt) return fail(400, 'Voting is not open.');
      let choice = 'skip';
      if (target !== 'skip') {
        choice = Object.keys(players).find((id) => pub(id) === target);
        if (!choice || choice === pid || dead[choice] || !roles[choice]) return fail(400, 'Invalid vote target.');
      }
      await redis([['HSET', K('votes'), pid, choice], ['EXPIRE', K('votes'), TTL]]);
      return res.status(200).json({ success: true });
    }

    if (action === 'leave') {
      if (isHostKey) {
        await redis([['DEL', K('meta')], ['DEL', K('players')], ['DEL', K('roles')], ['DEL', K('acks')], ['DEL', K('dead')], ['DEL', K('votes')], ['DEL', K('requests')], ['SREM', 'games:index', code]]);
        return res.status(200).json({ success: true, destroyed: true });
      }
      if (typeof playerId === 'string' && playerId) {
        await redis(removePlayerCmds(playerId));
        await dropRequestsFor(playerId);
        return res.status(200).json({ success: true });
      }
      return fail(400, 'Missing playerId or hostKey.');
    }

    // ---------- host-only actions ----------
    if (!isHostKey) return fail(403, 'Unauthorized: invalid host key.');

    if (action === 'handle_request') {
      if (!requestId) return fail(400, 'requestId is required.');
      if (!['approve', 'deny'].includes(decision)) return fail(400, 'Decision must be approve or deny.');
      const rid = String(requestId);
      const [raw, pl] = await redis([['HGET', K('requests'), rid], ['HGETALL', K('players')]]);
      const r = safeParse(raw);
      if (!r) return fail(404, 'Request not found.');
      if (decision === 'deny') {
        r.status = 'denied';
        await redis([['HSET', K('requests'), rid, JSON.stringify(r)]]);
        return res.status(200).json({ success: true, denied: true });
      }
      if (r.status === 'approved') return res.status(200).json({ success: true, approved: true, playerId: r.playerId }); // double-tap safe
      const players = parseHash(pl);
      if (Object.keys(players).length >= MAX_PLAYERS) return fail(400, 'This game is full.');
      if (taken(r.name, Object.values(players))) return fail(409, `"${r.name}" is already in the game.`);
      const pId = 'p_' + crypto.randomBytes(8).toString('hex');
      r.status = 'approved'; r.playerId = pId;
      await redis([['HSET', K('players'), pId, r.name], ['HSET', K('requests'), rid, JSON.stringify(r)], ['EXPIRE', K('players'), TTL]]);
      return res.status(200).json({ success: true, approved: true, playerId: pId });
    }

    if (action === 'counts') {
      if (!counts || typeof counts !== 'object') return fail(400, 'Invalid counts payload.');
      meta.counts = { traitors: nOf(counts.traitors), doctors: nOf(counts.doctors), detectives: nOf(counts.detectives) };
      await redis([saveMeta()]);
      return res.status(200).json({ success: true, counts: meta.counts });
    }

    if (action === 'kick' || action === 'transfer') {
      const [pl] = await redis([['HGETALL', K('players')]]);
      const players = parseHash(pl);
      const tid = Object.keys(players).find((id) => pub(id) === target);
      if (!tid) return fail(404, 'Player not found (they may have already left).');

      if (action === 'kick') {
        await redis(removePlayerCmds(tid));
        await dropRequestsFor(tid);
        return res.status(200).json({ success: true });
      }

      // transfer: the new host stops being a player; the old host either stays as a player or leaves
      const oldName = meta.hostName;
      meta.hostKey = genSecret();
      meta.hostPlayerId = tid;
      meta.hostName = players[tid];
      const cmds = [...removePlayerCmds(tid)];
      let stayedAs = null;
      if (stay) {
        const oldId = 'p_' + crypto.randomBytes(8).toString('hex');
        const uniqueName = taken(oldName, Object.values(players).filter((n) => n !== players[tid])) ? `${oldName} (ex-host)`.slice(0, 20) : oldName;
        cmds.push(['HSET', K('players'), oldId, uniqueName]);
        stayedAs = { playerId: oldId, name: uniqueName };
      }
      cmds.push(saveMeta());
      await redis(cmds);
      await dropRequestsFor(tid);
      return res.status(200).json({ success: true, stayedAs });
    }

    if (action === 'vote_start') {
      if (meta.round < 1) return fail(400, 'Deal roles before voting.');
      if (meta.vote?.status === 'open') return fail(400, 'A vote is already open.');
      const { players, roles, dead } = await loadAll();
      if (winnerOf(players, roles, dead)) return fail(400, 'The game is over. Shuffle to start a new game.');
      const duration = Math.min(600, Math.max(10, parseInt(body.duration, 10) || 60));
      meta.voteSeq = (meta.voteSeq || 0) + 1;
      meta.vote = { id: meta.voteSeq, status: 'open', duration, endsAt: Date.now() + duration * 1000 };
      meta.lastVote = null;
      await redis([['DEL', K('votes')], saveMeta()]);
      return res.status(200).json({ success: true });
    }
    if (action === 'vote_end') {
      if (meta.vote?.status !== 'open') return fail(400, 'No vote is open.');
      await finalizeVote(await loadAll());
      return res.status(200).json({ success: true });
    }
    if (action === 'vote_cancel') {
      meta.vote = null;
      await redis([['DEL', K('votes')], saveMeta()]);
      return res.status(200).json({ success: true });
    }
    if (action === 'mark_dead' || action === 'revive') {
      const { players, roles } = await loadAll();
      const tid = Object.keys(players).find((id) => pub(id) === target);
      if (!tid) return fail(404, 'Player not found.');
      if (!roles[tid]) return fail(400, 'That player has no role this round.');
      await redis([action === 'mark_dead' ? ['HSET', K('dead'), tid, '1'] : ['HDEL', K('dead'), tid], ['EXPIRE', K('dead'), TTL]]);
      return res.status(200).json({ success: true });
    }

    if (action === 'shuffle') {
      const [pl] = await redis([['HGETALL', K('players')]]);
      const ids = Object.keys(parseHash(pl)); // host is never in this list, so the host never gets a role
      const { traitors = 1, doctors = 1, detectives = 1 } = meta.counts;
      const special = traitors + doctors + detectives;
      if (ids.length < 2) return fail(400, 'Need at least 2 players to start a game.');
      if (special > ids.length) return fail(400, `Special roles (${special}) exceed total players (${ids.length}). Reduce counts.`);
      const deck = [
        ...Array(traitors).fill('Traitor'), ...Array(doctors).fill('Doctor'),
        ...Array(detectives).fill('Detective'), ...Array(ids.length - special).fill('Villager'),
      ];
      const shuffled = cryptoShuffle(deck);
      const flat = ids.flatMap((id, i) => [id, shuffled[i]]);
      meta.round = (meta.round || 0) + 1;
      meta.vote = null; meta.lastVote = null; // fresh game: nobody is dead, no vote running
      // meta is written last so nobody sees a new round before roles exist
      await redis([['DEL', K('roles')], ['DEL', K('acks')], ['DEL', K('dead')], ['DEL', K('votes')], ['HSET', K('roles'), ...flat], ['EXPIRE', K('roles'), TTL], saveMeta()]);
      return res.status(200).json({ success: true, round: meta.round, totalPlayers: ids.length });
    }

    return fail(400, `Unknown action '${action}'.`);
  } catch (err) {
    console.error('API Error:', err.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
