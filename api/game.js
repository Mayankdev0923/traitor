import crypto from 'node:crypto';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const isRedisConfigured = !!(REDIS_URL && REDIS_TOKEN);

// In-memory storage fallback for local development or testing without Redis
const memoryStore = new Map();

// Helper to simulate Redis commands in memory
function runInMemoryCommand(cmd) {
  const op = cmd[0].toUpperCase();
  if (op === 'SET') {
    const key = cmd[1];
    const val = cmd[2];
    memoryStore.set(key, { type: 'string', value: val });
    return { result: 'OK' };
  } else if (op === 'GET') {
    const item = memoryStore.get(cmd[1]);
    return { result: item && item.type === 'string' ? item.value : null };
  } else if (op === 'HSET') {
    const key = cmd[1];
    let item = memoryStore.get(key);
    if (!item || item.type !== 'hash') {
      item = { type: 'hash', value: new Map() };
      memoryStore.set(key, item);
    }
    for (let i = 2; i < cmd.length; i += 2) {
      item.value.set(cmd[i], cmd[i + 1]);
    }
    return { result: 'OK' };
  } else if (op === 'HGET') {
    const key = cmd[1];
    const field = cmd[2];
    const item = memoryStore.get(key);
    if (item && item.type === 'hash') {
      return { result: item.value.get(field) || null };
    }
    return { result: null };
  } else if (op === 'HGETALL') {
    const key = cmd[1];
    const item = memoryStore.get(key);
    if (item && item.type === 'hash') {
      const flat = [];
      for (const [k, v] of item.value.entries()) {
        flat.push(k, v);
      }
      return { result: flat };
    }
    return { result: [] };
  } else if (op === 'HDEL') {
    const key = cmd[1];
    const field = cmd[2];
    const item = memoryStore.get(key);
    if (item && item.type === 'hash') {
      item.value.delete(field);
    }
    return { result: 1 };
  } else if (op === 'DEL') {
    for (let i = 1; i < cmd.length; i++) {
      memoryStore.delete(cmd[i]);
    }
    return { result: 1 };
  } else if (op === 'EXPIRE') {
    return { result: 1 };
  }
  return { result: null };
}

async function redisPipeline(commands) {
  if (!isRedisConfigured) {
    return commands.map(cmd => runInMemoryCommand(cmd));
  }

  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upstash Redis REST error (${res.status}): ${errText}`);
  }

  return await res.json();
}

function parseHash(flatArray) {
  const obj = {};
  if (!Array.isArray(flatArray)) return obj;
  for (let i = 0; i < flatArray.length; i += 2) {
    obj[flatArray[i]] = flatArray[i + 1];
  }
  return obj;
}

// Cryptographically sound shuffle (Fisher-Yates with randomInt)
function cryptoShuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Non-confusing characters (no 0/O/1/I/L)
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateGameCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    const randomIndex = crypto.randomInt(0, ALPHABET.length);
    code += ALPHABET[randomIndex];
  }
  return code;
}

function generateSecretKey() {
  return crypto.randomBytes(16).toString('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { action, code: rawCode, hostKey, playerId, name, counts } = req.body || {};
    const code = rawCode ? rawCode.toUpperCase().trim() : '';

    // Action 1: CREATE GAME
    if (action === 'create') {
      let gameCode = generateGameCode();
      const checkRes = await redisPipeline([['GET', `game:${gameCode}:meta`]]);
      if (checkRes[0]?.result) {
        gameCode = generateGameCode();
      }

      const hostSecret = generateSecretKey();
      const meta = {
        hostKey: hostSecret,
        round: 0,
        counts: { traitors: 1, doctors: 1, detectives: 1 },
        createdAt: Date.now(),
      };

      await redisPipeline([
        ['SET', `game:${gameCode}:meta`, JSON.stringify(meta), 'EX', '86400'],
        ['DEL', `game:${gameCode}:players`],
        ['DEL', `game:${gameCode}:roles`],
        ['DEL', `game:${gameCode}:acks`],
        ['EXPIRE', `game:${gameCode}:players`, '86400'],
      ]);

      return res.status(200).json({
        success: true,
        code: gameCode,
        hostKey: hostSecret,
      });
    }

    if (!code) {
      return res.status(400).json({ error: 'Game code is required. Please check your 4-character code.' });
    }

    // Retrieve meta & update TTL
    const metaRes = await redisPipeline([
      ['GET', `game:${code}:meta`],
      ['EXPIRE', `game:${code}:meta`, '86400'],
      ['EXPIRE', `game:${code}:players`, '86400'],
      ['EXPIRE', `game:${code}:roles`, '86400'],
      ['EXPIRE', `game:${code}:acks`, '86400'],
    ]);

    const metaRaw = metaRes[0]?.result;
    if (!metaRaw) {
      return res.status(404).json({ error: 'Game not found or expired. Check the code or create a new game.' });
    }

    const meta = JSON.parse(metaRaw);

    // Action 2: JOIN GAME
    if (action === 'join') {
      const cleanName = (name || '').trim();
      if (!cleanName) {
        return res.status(400).json({ error: 'Please enter a valid player name.' });
      }
      if (cleanName.length > 20) {
        return res.status(400).json({ error: 'Name is too long (max 20 characters).' });
      }

      const pId = 'p_' + crypto.randomBytes(8).toString('hex');

      await redisPipeline([
        ['HSET', `game:${code}:players`, pId, cleanName],
      ]);

      return res.status(200).json({
        success: true,
        code,
        playerId: pId,
        name: cleanName,
      });
    }

    // Action 3: LEAVE GAME
    if (action === 'leave') {
      if (playerId) {
        await redisPipeline([
          ['HDEL', `game:${code}:players`, playerId],
          ['HDEL', `game:${code}:roles`, playerId],
          ['HDEL', `game:${code}:acks`, playerId],
        ]);
      }
      return res.status(200).json({ success: true });
    }

    // Action 4: GET STATE (Host or Player)
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
      const isHost = hostKey === meta.hostKey;

      if (isHost) {
        // Host view: roster, confirmed status, counts
        const playerList = playerIds.map(id => ({
          id,
          name: playersObj[id],
          acked: acksObj[id] === String(meta.round),
        }));

        const totalConfirmed = playerList.filter(p => p.acked).length;

        return res.status(200).json({
          isHost: true,
          code,
          round: meta.round,
          counts: meta.counts,
          players: playerList,
          totalPlayers: playerList.length,
          confirmedCount: totalConfirmed,
        });
      } else {
        // Player view: isolated player information
        if (!playerId || !playersObj[playerId]) {
          return res.status(401).json({ error: 'Player session not found in this game.' });
        }

        const playerAcked = acksObj[playerId] === String(meta.round);
        
        let role = null;
        if (meta.round > 0 && !playerAcked && playerRole) {
          role = playerRole;
        }

        return res.status(200).json({
          isHost: false,
          code,
          name: playersObj[playerId],
          round: meta.round,
          role,
          acked: playerAcked,
          totalPlayers: playerIds.length,
          dealStarted: meta.round > 0,
        });
      }
    }

    // Action 5: ACKNOWLEDGE ROLE (Player saw their role)
    if (action === 'ack') {
      if (!playerId) {
        return res.status(400).json({ error: 'Player ID required for ack.' });
      }

      await redisPipeline([
        ['HSET', `game:${code}:acks`, playerId, String(meta.round)],
        ['HDEL', `game:${code}:roles`, playerId], // Wipe stored role from server for secrecy!
      ]);

      return res.status(200).json({ success: true, acked: true });
    }

    // --- Host actions below require secret hostKey verification ---
    if (hostKey !== meta.hostKey) {
      return res.status(403).json({ error: 'Unauthorized: Invalid host key.' });
    }

    // Action 6: UPDATE COUNTS
    if (action === 'counts') {
      if (!counts || typeof counts !== 'object') {
        return res.status(400).json({ error: 'Invalid counts payload.' });
      }

      const traitors = Math.max(0, parseInt(counts.traitors || 0, 10));
      const doctors = Math.max(0, parseInt(counts.doctors || 0, 10));
      const detectives = Math.max(0, parseInt(counts.detectives || 0, 10));

      meta.counts = { traitors, doctors, detectives };

      await redisPipeline([
        ['SET', `game:${code}:meta`, JSON.stringify(meta), 'EX', '86400'],
      ]);

      return res.status(200).json({ success: true, counts: meta.counts });
    }

    // Action 7: SHUFFLE AND DEAL
    if (action === 'shuffle') {
      const playersRes = await redisPipeline([
        ['HGETALL', `game:${code}:players`],
      ]);

      const playersObj = parseHash(playersRes[0]?.result);
      const playerIds = Object.keys(playersObj);

      if (playerIds.length < 2) {
        return res.status(400).json({ error: 'Need at least 2 players to start a game.' });
      }

      const { traitors = 1, doctors = 1, detectives = 1 } = meta.counts;
      const specialCount = traitors + doctors + detectives;

      if (specialCount > playerIds.length) {
        return res.status(400).json({
          error: `Special roles (${specialCount}) exceed total players (${playerIds.length}). Reduce counts to continue.`,
        });
      }

      const villagerCount = playerIds.length - specialCount;

      // Construct deck of roles
      const deck = [];
      for (let i = 0; i < traitors; i++) deck.push('Traitor');
      for (let i = 0; i < doctors; i++) deck.push('Doctor');
      for (let i = 0; i < detectives; i++) deck.push('Detective');
      for (let i = 0; i < villagerCount; i++) deck.push('Villager');

      // Cryptographically shuffle deck
      const shuffledDeck = cryptoShuffle(deck);

      // Map roles to players
      const roleCommands = [];
      playerIds.forEach((id, index) => {
        roleCommands.push(id, shuffledDeck[index]);
      });

      meta.round = (meta.round || 0) + 1;

      // Update meta, clear old roles & acks, write new roles
      await redisPipeline([
        ['SET', `game:${code}:meta`, JSON.stringify(meta), 'EX', '86400'],
        ['DEL', `game:${code}:roles`],
        ['DEL', `game:${code}:acks`],
        ['HSET', `game:${code}:roles`, ...roleCommands],
      ]);

      return res.status(200).json({
        success: true,
        round: meta.round,
        totalPlayers: playerIds.length,
      });
    }

    return res.status(400).json({ error: `Unknown action '${action}'.` });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
}
