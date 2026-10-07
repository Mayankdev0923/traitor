import crypto from 'node:crypto';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REST_API_URL || process.env.REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REST_API_TOKEN || process.env.REDIS_REST_TOKEN;
const isRedisConfigured = !!(REDIS_URL && REDIS_TOKEN);

// ---------------------------------------------------------------------------
// In-memory store (fallback for local dev / test)
// ---------------------------------------------------------------------------
const memoryStore = new Map();

function runInMemoryCommand(cmd) {
  const op = cmd[0].toUpperCase();

  if (op === 'SET') {
    memoryStore.set(cmd[1], { type: 'string', value: cmd[2] });
    return { result: 'OK' };
  }
  if (op === 'GET') {
    const item = memoryStore.get(cmd[1]);
    return { result: item && item.type === 'string' ? item.value : null };
  }
  if (op === 'HSET') {
    const key = cmd[1];
    let item = memoryStore.get(key);
    if (!item || item.type !== 'hash') {
      item = { type: 'hash', value: new Map() };
      memoryStore.set(key, item);
    }
    for (let i = 2; i < cmd.length; i += 2) item.value.set(cmd[i], cmd[i + 1]);
    return { result: 'OK' };
  }
  if (op === 'HGET') {
    const item = memoryStore.get(cmd[1]);
    return { result: item && item.type === 'hash' ? (item.value.get(cmd[2]) || null) : null };
  }
  if (op === 'HGETALL') {
    const item = memoryStore.get(cmd[1]);
    if (item && item.type === 'hash') {
      const flat = [];
      for (const [k, v] of item.value.entries()) flat.push(k, v);
      return { result: flat };
    }
    return { result: [] };
  }
  if (op === 'HDEL') {
    const item = memoryStore.get(cmd[1]);
    if (item && item.type === 'hash') item.value.delete(cmd[2]);
    return { result: 1 };
  }
  if (op === 'DEL') {
    for (let i = 1; i < cmd.length; i++) memoryStore.delete(cmd[i]);
    return { result: 1 };
  }
  if (op === 'EXPIRE') return { result: 1 };
  if (op === 'SADD') {
    const key = cmd[1];
    let item = memoryStore.get(key);
    if (!item || item.type !== 'set') {
      item = { type: 'set', value: new Set() };
      memoryStore.set(key, item);
    }
    for (let i = 2; i < cmd.length; i++) item.value.add(cmd[i]);
    return { result: 1 };
  }
  if (op === 'SREM') {
    const item = memoryStore.get(cmd[1]);
    if (item && item.type === 'set') item.value.delete(cmd[2]);
    return { result: 1 };
  }
  if (op === 'SMEMBERS') {
    const item = memoryStore.get(cmd[1]);
    return { result: item && item.type === 'set' ? [...item.value] : [] };
  }
  return { result: null };
}

async function redisPipeline(commands) {
  if (!isRedisConfigured) return commands.map(cmd => runInMemoryCommand(cmd));

  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upstash Redis REST HTTP error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && item.error) {
        console.error('Upstash Redis Pipeline Item Error:', item.error, 'Commands:', commands);
        throw new Error(`Redis Command Error: ${item.error}`);
      }
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseHash(flatArray) {
  const obj = {};
  if (!Array.isArray(flatArray)) return obj;
  for (let i = 0; i < flatArray.length; i += 2) obj[flatArray[i]] = flatArray[i + 1];
  return obj;
}

function cryptoShuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateGameCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return code;
}
function generateSecretKey() { return crypto.randomBytes(16).toString('hex'); }

const TTL = 86400; // 24 hours

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  try {
    const { action, code: rawCode, hostKey, playerId, name, counts, newHostPlayerId, requestId } = req.body || {};
    const code = rawCode ? rawCode.toUpperCase().trim() : '';

    // ------------------------------------------------------------------
    // PUBLIC: LIST ONGOING GAMES
    // ------------------------------------------------------------------
    if (action === 'list_games') {
      const [membersRes] = await redisPipeline([['SMEMBERS', 'games:index']]);
      const codes = membersRes?.result || [];

      if (codes.length === 0) return res.status(200).json({ games: [] });

      // Fetch meta for each game in parallel (pipeline)
      const metaCommands = codes.map(c => ['GET', `game:${c}:meta`]);
      const playerCountCommands = codes.map(c => ['HGETALL', `game:${c}:players`]);
      const metaResults = await redisPipeline([...metaCommands, ...playerCountCommands]);

      const games = [];
      for (let i = 0; i < codes.length; i++) {
        const metaRaw = metaResults[i]?.result;
        if (!metaRaw) {
          // Stale index entry — clean up lazily
          await redisPipeline([['SREM', 'games:index', codes[i]]]);
          continue;
        }
        const meta = JSON.parse(metaRaw);
        const playersFlat = metaResults[codes.length + i]?.result || [];
        const playerNames = [];
        for (let j = 1; j < playersFlat.length; j += 2) playerNames.push(playersFlat[j]);

        games.push({
          // NOTE: Raw game code is NOT shown on the home page.
          // gameId is used internally to submit join requests without exposing code.
          gameId: codes[i],
          hostName: meta.hostName || 'Host',
          playerCount: playerNames.length,
          round: meta.round,
          createdAt: meta.createdAt,
        });
      }

      return res.status(200).json({ games });
    }

    // ------------------------------------------------------------------
    // PUBLIC: REQUEST TO JOIN (unauthenticated — sends a request to host)
    // ------------------------------------------------------------------
    if (action === 'request_join') {
      if (!code) return res.status(400).json({ error: 'Game code is required.' });

      const [metaRaw] = await redisPipeline([['GET', `game:${code}:meta`]]);
      if (!metaRaw?.result) return res.status(404).json({ error: 'Game not found. Check the code.' });

      const cleanName = (name || '').trim();
      if (!cleanName) return res.status(400).json({ error: 'Please enter a valid name.' });
      if (cleanName.length > 20) return res.status(400).json({ error: 'Name is too long (max 20 characters).' });

      const reqId = 'r_' + crypto.randomBytes(8).toString('hex');
      const reqPayload = JSON.stringify({ name: cleanName, status: 'pending', playerId: null });

      await redisPipeline([
        ['HSET', `game:${code}:requests`, reqId, reqPayload],
        ['EXPIRE', `game:${code}:requests`, TTL],
      ]);

      return res.status(200).json({ success: true, requestId: reqId, name: cleanName });
    }

    // ------------------------------------------------------------------
    // PUBLIC: POLL REQUEST STATUS (player polls until approved/denied)
    // ------------------------------------------------------------------
    if (action === 'poll_request') {
      if (!code) return res.status(400).json({ error: 'Game code is required.' });
      if (!requestId) return res.status(400).json({ error: 'Request ID is required.' });

      const [reqRaw] = await redisPipeline([['HGET', `game:${code}:requests`, requestId]]);
      if (!reqRaw?.result) return res.status(404).json({ error: 'Join request not found or expired.' });

      const request = JSON.parse(reqRaw.result);
      return res.status(200).json({
        status: request.status,     // 'pending' | 'approved' | 'denied'
        playerId: request.playerId, // set when approved
        name: request.name,
        code,
      });
    }

    // ------------------------------------------------------------------
    // CREATE GAME (no code required)
    // ------------------------------------------------------------------
    if (action === 'create') {
      const cleanHostName = (name || '').trim();
      if (!cleanHostName) return res.status(400).json({ error: 'Please enter your name before creating a game.' });
      if (cleanHostName.length > 20) return res.status(400).json({ error: 'Name is too long (max 20 characters).' });

      let gameCode = generateGameCode();
      const [existing] = await redisPipeline([['GET', `game:${gameCode}:meta`]]);
      if (existing?.result) gameCode = generateGameCode(); // retry once

      const hostSecret = generateSecretKey();
      const meta = {
        hostKey: hostSecret,
        hostPlayerId: null,
        hostName: cleanHostName,
        round: 0,
        counts: { traitors: 1, doctors: 1, detectives: 1 },
        createdAt: Date.now(),
      };

      await redisPipeline([
        ['SET', `game:${gameCode}:meta`, JSON.stringify(meta)],
        ['EXPIRE', `game:${gameCode}:meta`, TTL],
        ['DEL', `game:${gameCode}:players`],
        ['DEL', `game:${gameCode}:roles`],
        ['DEL', `game:${gameCode}:acks`],
        ['DEL', `game:${gameCode}:requests`],
        ['SADD', 'games:index', gameCode],
        ['EXPIRE', 'games:index', TTL],
      ]);

      return res.status(200).json({ success: true, code: gameCode, hostKey: hostSecret, hostName: cleanHostName });
    }

    // ------------------------------------------------------------------
    // Require code for all remaining actions
    // ------------------------------------------------------------------
    if (!code) return res.status(400).json({ error: 'Game code is required.' });

    // Retrieve meta & extend TTL for all remaining actions
    const metaRes = await redisPipeline([
      ['GET', `game:${code}:meta`],
      ['EXPIRE', `game:${code}:meta`, TTL],
      ['EXPIRE', `game:${code}:players`, TTL],
      ['EXPIRE', `game:${code}:roles`, TTL],
      ['EXPIRE', `game:${code}:acks`, TTL],
      ['EXPIRE', `game:${code}:requests`, TTL],
    ]);

    const metaRaw = metaRes[0]?.result;
    if (!metaRaw) return res.status(404).json({ error: 'Game not found or host has left. Return to home screen.' });
    const meta = JSON.parse(metaRaw);

    // ------------------------------------------------------------------
    // JOIN GAME (direct — used after host approves a request, or manual code entry)
    // ------------------------------------------------------------------
    if (action === 'join') {
      const cleanName = (name || '').trim();
      if (!cleanName) return res.status(400).json({ error: 'Please enter a valid player name.' });
      if (cleanName.length > 20) return res.status(400).json({ error: 'Name is too long (max 20 characters).' });

      const pId = 'p_' + crypto.randomBytes(8).toString('hex');
      await redisPipeline([
        ['HSET', `game:${code}:players`, pId, cleanName],
        ['EXPIRE', `game:${code}:players`, TTL],
      ]);

      return res.status(200).json({ success: true, code, playerId: pId, name: cleanName });
    }

    // ------------------------------------------------------------------
    // LEAVE GAME
    // ------------------------------------------------------------------
    if (action === 'leave') {
      const isHostLeaving = hostKey === meta.hostKey;

      if (isHostLeaving) {
        if (newHostPlayerId) {
          const newHostKey = generateSecretKey();
          meta.hostKey = newHostKey;
          meta.hostPlayerId = newHostPlayerId;
          await redisPipeline([
            ['SET', `game:${code}:meta`, JSON.stringify(meta)],
            ['EXPIRE', `game:${code}:meta`, TTL],
          ]);
          return res.status(200).json({ success: true, transferred: true });
        } else {
          // Destroy entire game instance
          await redisPipeline([
            ['DEL', `game:${code}:meta`],
            ['DEL', `game:${code}:players`],
            ['DEL', `game:${code}:roles`],
            ['DEL', `game:${code}:acks`],
            ['DEL', `game:${code}:requests`],
            ['SREM', 'games:index', code],
          ]);
          return res.status(200).json({ success: true, destroyed: true });
        }
      } else if (playerId) {
        await redisPipeline([
          ['HDEL', `game:${code}:players`, playerId],
          ['HDEL', `game:${code}:roles`, playerId],
          ['HDEL', `game:${code}:acks`, playerId],
        ]);
        return res.status(200).json({ success: true });
      }
      return res.status(400).json({ error: 'Missing playerId or hostKey.' });
    }

    // ------------------------------------------------------------------
    // GET STATE
    // ------------------------------------------------------------------
    if (action === 'state') {
      const statePipeline = await redisPipeline([
        ['HGETALL', `game:${code}:players`],
        ['HGETALL', `game:${code}:acks`],
        ['HGET', `game:${code}:roles`, playerId || 'none'],
      ]);

      const playersObj = parseHash(statePipeline[0]?.result);
      const acksObj = parseHash(statePipeline[1]?.result);
      const playerRole = statePipeline[2]?.result;
      const playerIds = Object.keys(playersObj);

      let isHost = hostKey === meta.hostKey;
      let newlyPromotedHost = false;

      if (!isHost && playerId && meta.hostPlayerId === playerId) {
        isHost = true;
        newlyPromotedHost = true;
      }

      if (isHost) {
        // Fetch pending join requests
        const [reqRes] = await redisPipeline([['HGETALL', `game:${code}:requests`]]);
        const reqObj = parseHash(reqRes?.result);
        const pendingRequests = Object.entries(reqObj)
          .map(([rid, raw]) => {
            try { return { requestId: rid, ...JSON.parse(raw) }; }
            catch { return null; }
          })
          .filter(r => r && r.status === 'pending');

        const playerList = playerIds.map(id => ({
          id,
          name: playersObj[id],
          acked: acksObj[id] === String(meta.round),
        }));

        return res.status(200).json({
          isHost: true,
          hostKey: meta.hostKey,
          code,
          round: meta.round,
          counts: meta.counts,
          players: playerList,
          totalPlayers: playerList.length,
          confirmedCount: playerList.filter(p => p.acked).length,
          newlyPromotedHost,
          pendingRequests,
        });
      } else {
        const playerAcked = playerId ? acksObj[playerId] === String(meta.round) : false;
        let role = null;
        if (meta.round > 0 && playerRole) role = playerRole;

        // Build public player list (names only, no roles)
        const playerList = playerIds.map(id => ({
          id,
          name: playersObj[id],
          acked: acksObj[id] === String(meta.round),
        }));

        const playerName = (playerId && playersObj[playerId]) ? playersObj[playerId] : (name || 'Player');

        return res.status(200).json({
          isHost: false,
          code,
          name: playerName,
          round: meta.round,
          role,
          acked: playerAcked,
          totalPlayers: playerIds.length,
          dealStarted: meta.round > 0,
          players: playerList, // All players (names only) visible to everyone
        });
      }
    }

    // ------------------------------------------------------------------
    // ACK ROLE
    // ------------------------------------------------------------------
    if (action === 'ack') {
      if (!playerId) return res.status(400).json({ error: 'Player ID required for ack.' });
      await redisPipeline([
        ['HSET', `game:${code}:acks`, playerId, String(meta.round)],
        ['EXPIRE', `game:${code}:acks`, TTL],
      ]);
      return res.status(200).json({ success: true, acked: true });
    }

    // ------------------------------------------------------------------
    // HOST-ONLY ACTIONS — verify hostKey
    // ------------------------------------------------------------------
    if (hostKey !== meta.hostKey) {
      return res.status(403).json({ error: 'Unauthorized: Invalid host key.' });
    }

    // ------------------------------------------------------------------
    // HANDLE JOIN REQUEST (host approves / denies)
    // ------------------------------------------------------------------
    if (action === 'handle_request') {
      const { decision } = body; // 'approve' | 'deny'
      if (!requestId) return res.status(400).json({ error: 'requestId is required.' });
      if (!['approve', 'deny'].includes(decision)) return res.status(400).json({ error: 'Decision must be approve or deny.' });

      const [reqRaw] = await redisPipeline([['HGET', `game:${code}:requests`, requestId]]);
      if (!reqRaw?.result) return res.status(404).json({ error: 'Request not found.' });

      const request = JSON.parse(reqRaw.result);

      if (decision === 'approve') {
        // Create player entry, link playerId back to request
        const pId = 'p_' + crypto.randomBytes(8).toString('hex');
        request.status = 'approved';
        request.playerId = pId;

        await redisPipeline([
          ['HSET', `game:${code}:players`, pId, request.name],
          ['EXPIRE', `game:${code}:players`, TTL],
          ['HSET', `game:${code}:requests`, requestId, JSON.stringify(request)],
        ]);

        return res.status(200).json({ success: true, approved: true, playerId: pId });
      } else {
        request.status = 'denied';
        await redisPipeline([['HSET', `game:${code}:requests`, requestId, JSON.stringify(request)]]);
        return res.status(200).json({ success: true, denied: true });
      }
    }

    // ------------------------------------------------------------------
    // UPDATE COUNTS
    // ------------------------------------------------------------------
    if (action === 'counts') {
      if (!counts || typeof counts !== 'object') return res.status(400).json({ error: 'Invalid counts payload.' });
      meta.counts = {
        traitors: Math.max(0, parseInt(counts.traitors || 0, 10)),
        doctors: Math.max(0, parseInt(counts.doctors || 0, 10)),
        detectives: Math.max(0, parseInt(counts.detectives || 0, 10)),
      };
      await redisPipeline([
        ['SET', `game:${code}:meta`, JSON.stringify(meta)],
        ['EXPIRE', `game:${code}:meta`, TTL],
      ]);
      return res.status(200).json({ success: true, counts: meta.counts });
    }

    // ------------------------------------------------------------------
    // SHUFFLE AND DEAL
    // ------------------------------------------------------------------
    if (action === 'shuffle') {
      const [playersRes] = await redisPipeline([['HGETALL', `game:${code}:players`]]);
      const playersObj = parseHash(playersRes?.result);
      const playerIds = Object.keys(playersObj);

      if (playerIds.length < 2) return res.status(400).json({ error: 'Need at least 2 players to start a game.' });

      const { traitors = 1, doctors = 1, detectives = 1 } = meta.counts;
      const specialCount = traitors + doctors + detectives;
      if (specialCount > playerIds.length) {
        return res.status(400).json({
          error: `Special roles (${specialCount}) exceed total players (${playerIds.length}). Reduce counts to continue.`,
        });
      }

      const deck = [];
      for (let i = 0; i < traitors; i++) deck.push('Traitor');
      for (let i = 0; i < doctors; i++) deck.push('Doctor');
      for (let i = 0; i < detectives; i++) deck.push('Detective');
      for (let i = 0; i < playerIds.length - specialCount; i++) deck.push('Villager');

      const shuffledDeck = cryptoShuffle(deck);
      const roleCommands = [];
      playerIds.forEach((id, idx) => roleCommands.push(id, shuffledDeck[idx]));

      meta.round = (meta.round || 0) + 1;

      await redisPipeline([
        ['SET', `game:${code}:meta`, JSON.stringify(meta)],
        ['EXPIRE', `game:${code}:meta`, TTL],
        ['DEL', `game:${code}:roles`],
        ['DEL', `game:${code}:acks`],
        ['HSET', `game:${code}:roles`, ...roleCommands],
        ['EXPIRE', `game:${code}:roles`, TTL],
      ]);

      return res.status(200).json({ success: true, round: meta.round, totalPlayers: playerIds.length });
    }

    return res.status(400).json({ error: `Unknown action '${action}'.` });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
}
