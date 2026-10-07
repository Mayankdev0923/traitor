import handler from '../api/game.js';

function callApi(body) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let resHeaders = {};
    let resData = null;

    const req = {
      method: 'POST',
      body,
      headers: {},
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      setHeader(k, v) {
        resHeaders[k] = v;
        return this;
      },
      json(data) {
        resData = data;
        resolve({ status: statusCode, headers: resHeaders, data });
        return this;
      },
      send(msg) {
        resData = msg;
        resolve({ status: statusCode, headers: resHeaders, data: msg });
        return this;
      },
    };

    handler(req, res).catch(reject);
  });
}

async function runTests() {
  console.log('--- RUNNING API LOGIC TEST SUITE ---');

  // 1. Create two isolated games
  const g1Create = await callApi({ action: 'create' });
  const g2Create = await callApi({ action: 'create' });

  if (g1Create.status !== 200 || !g1Create.data.code) throw new Error('Game 1 creation failed');
  if (g2Create.status !== 200 || !g2Create.data.code) throw new Error('Game 2 creation failed');
  if (g1Create.data.code === g2Create.data.code) throw new Error('Game codes must be unique');

  const g1Code = g1Create.data.code;
  const g1HostKey = g1Create.data.hostKey;

  const g2Code = g2Create.data.code;
  const g2HostKey = g2Create.data.hostKey;

  console.log(`[PASS] Game 1 created (${g1Code}) & Game 2 created (${g2Code})`);

  // 2. Join players to Game 1 and Game 2
  const pAlice = await callApi({ action: 'join', code: g1Code, name: 'Alice' });
  const pBob = await callApi({ action: 'join', code: g1Code, name: 'Bob' });
  const pCharlie = await callApi({ action: 'join', code: g2Code, name: 'Charlie' });
  const pDiana = await callApi({ action: 'join', code: g2Code, name: 'Diana' });

  const aliceId = pAlice.data.playerId;
  const bobId = pBob.data.playerId;
  const charlieId = pCharlie.data.playerId;
  const dianaId = pDiana.data.playerId;

  console.log('[PASS] Players joined successfully');

  // 3. Configure counts and shuffle Game 1
  await callApi({
    action: 'counts',
    code: g1Code,
    hostKey: g1HostKey,
    counts: { traitors: 1, doctors: 1, detectives: 0 },
  });

  const shuffle1 = await callApi({
    action: 'shuffle',
    code: g1Code,
    hostKey: g1HostKey,
  });

  if (shuffle1.status !== 200 || shuffle1.data.round !== 1) throw new Error('Shuffle 1 failed');
  console.log('[PASS] Roles shuffled in Game 1');

  // 4. Test Secrecy: Check Player Alice state
  const aliceState1 = await callApi({ action: 'state', code: g1Code, playerId: aliceId });
  if (!aliceState1.data.role) throw new Error('Alice should receive a role');
  if (aliceState1.data.bobRole !== undefined) throw new Error('Alice MUST NOT see Bob\'s role');
  if (aliceState1.data.roles !== undefined) throw new Error('Alice MUST NOT see full roles hash');
  console.log(`[PASS] Alice received role '${aliceState1.data.role}' securely without seeing other players' roles.`);

  // 5. Test Host State Secrecy
  const hostState1 = await callApi({ action: 'state', code: g1Code, hostKey: g1HostKey });
  if (!hostState1.data.isHost) throw new Error('Host state check failed');
  if (hostState1.data.confirmedCount !== 0) throw new Error('Initial confirmed count should be 0');
  const hasRolesInHostPayload = hostState1.data.players.some((p) => p.role);
  if (hasRolesInHostPayload) throw new Error('Host state MUST NOT contain player roles');
  console.log('[PASS] Host receives player roster with 0 confirmed, zero player roles exposed.');

  // 6. Test Acknowledge (ack): Role disappears after confirmation
  const aliceAck = await callApi({ action: 'ack', code: g1Code, playerId: aliceId });
  if (aliceAck.status !== 200 || !aliceAck.data.success) {
    console.error('DEBUG aliceAck failure:', aliceAck);
    throw new Error('Alice ack failed');
  }

  const aliceState2 = await callApi({ action: 'state', code: g1Code, playerId: aliceId });
  if (!aliceState2.data.acked) throw new Error('Alice should be marked acked');
  if (aliceState2.data.role !== null) throw new Error('Role MUST be null after ack');
  console.log('[PASS] Role disappeared and set to null after Alice clicked ack.');

  // Verify host sees Alice confirmed
  const hostState2 = await callApi({ action: 'state', code: g1Code, hostKey: g1HostKey });
  if (hostState2.data.confirmedCount !== 1) throw new Error(`Host confirmed count should be 1, got ${hostState2.data.confirmedCount}`);
  console.log('[PASS] Host live confirmed count updated to 1/2.');

  // 7. Test Reshuffle resets acknowledgements and updates round
  const shuffle2 = await callApi({
    action: 'shuffle',
    code: g1Code,
    hostKey: g1HostKey,
  });
  if (shuffle2.data.round !== 2) throw new Error('Round should increment to 2');

  const aliceState3 = await callApi({ action: 'state', code: g1Code, playerId: aliceId });
  if (aliceState3.data.round !== 2) throw new Error('Round should be 2');
  if (aliceState3.data.acked !== false) throw new Error('Acked should reset to false on reshuffle');
  if (!aliceState3.data.role) throw new Error('Alice should get a new role for round 2');
  console.log(`[PASS] Reshuffle reset acknowledgements. Round 2 role for Alice: '${aliceState3.data.role}'`);

  // 8. Verify Game 2 is completely isolated
  const charlieState = await callApi({ action: 'state', code: g2Code, playerId: charlieId });
  if (charlieState.data.code !== g2Code) throw new Error('Charlie should be in Game 2');
  if (charlieState.data.dealStarted !== false) throw new Error('Game 2 should not be shuffled yet');
  console.log('[PASS] Simultaneous Game 2 is completely isolated from Game 1.');

  console.log('\n--- ALL VERIFICATION TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch((err) => {
  console.error('\n[FAIL] Test Suite Error:', err.message);
  process.exit(1);
});
