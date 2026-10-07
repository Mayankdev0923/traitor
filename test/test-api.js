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
  console.log('--- RUNNING ENHANCED API TEST SUITE ---');

  // 1. Create Game 1
  const g1Create = await callApi({ action: 'create' });
  if (g1Create.status !== 200 || !g1Create.data.code) throw new Error('Game creation failed');

  const g1Code = g1Create.data.code;
  let g1HostKey = g1Create.data.hostKey;

  // 2. Join Alice and Bob
  const pAlice = await callApi({ action: 'join', code: g1Code, name: 'Alice' });
  const pBob = await callApi({ action: 'join', code: g1Code, name: 'Bob' });

  const aliceId = pAlice.data.playerId;
  const bobId = pBob.data.playerId;

  // 3. Shuffle & Deal
  await callApi({
    action: 'counts',
    code: g1Code,
    hostKey: g1HostKey,
    counts: { traitors: 1, doctors: 1, detectives: 0 },
  });
  await callApi({ action: 'shuffle', code: g1Code, hostKey: g1HostKey });

  // 4. Verify Secret Role Peek functionality
  const aliceState1 = await callApi({ action: 'state', code: g1Code, playerId: aliceId });
  const originalRole = aliceState1.data.role;
  if (!originalRole) throw new Error('Alice should receive a role');

  // Alice acks role
  await callApi({ action: 'ack', code: g1Code, playerId: aliceId });

  // Alice peeks role again in same round
  const aliceStatePeek = await callApi({ action: 'state', code: g1Code, playerId: aliceId });
  if (!aliceStatePeek.data.acked) throw new Error('Alice should be marked acked');
  if (aliceStatePeek.data.role !== originalRole) throw new Error('Alice should still be able to peek her secret role again in current round');
  console.log('[PASS] Secret role re-viewing verified.');

  // 5. Test Host Transfer to Alice
  const transferRes = await callApi({
    action: 'leave',
    code: g1Code,
    hostKey: g1HostKey,
    newHostPlayerId: aliceId,
  });
  if (!transferRes.data.transferred) throw new Error('Host transfer failed');

  // Alice polls state and gets promoted to Host!
  const alicePromotedState = await callApi({ action: 'state', code: g1Code, playerId: aliceId });
  if (!alicePromotedState.data.isHost) throw new Error('Alice should be promoted to Host');
  if (!alicePromotedState.data.hostKey) throw new Error('Alice should receive new hostKey');
  g1HostKey = alicePromotedState.data.hostKey;
  console.log('[PASS] Host transfer and automatic promotion verified.');

  // 6. Test Random Host Leave / Game Destruction
  const destroyRes = await callApi({
    action: 'leave',
    code: g1Code,
    hostKey: g1HostKey,
    // No newHostPlayerId -> destroy game instance!
  });
  if (!destroyRes.data.destroyed) throw new Error('Game destruction failed');

  // Bob polls state and gets 404 (Game deleted)
  const bobStateAfterDestroy = await callApi({ action: 'state', code: g1Code, playerId: bobId });
  if (bobStateAfterDestroy.status !== 404) throw new Error('Game should be deleted after host leaves randomly');
  console.log('[PASS] Random host leave game destruction verified.');

  console.log('\n--- ALL ENHANCED API TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch((err) => {
  console.error('\n[FAIL] Test Suite Error:', err.message);
  process.exit(1);
});
