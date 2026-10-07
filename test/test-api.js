import handler from '../api/game.js';

// ---------------------------------------------------------------------------
// Mock req/res adapter for the Vercel handler
// ---------------------------------------------------------------------------
function callApi(body) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = { method: 'POST', body, headers: {} };
    const res = {
      status(code) { statusCode = code; return this; },
      json(data)   { resolve({ status: statusCode, data }); return this; },
      send(msg)    { resolve({ status: statusCode, data: msg }); return this; },
    };
    handler(req, res).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------
function assert(condition, msg) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('='.repeat(60));
  console.log('  TRAITORS ROLE DEALER — FULL API VERIFICATION SUITE');
  console.log('='.repeat(60));

  // ── 1. Create two independent games ──────────────────────────────────────
  console.log('\n[1] Creating games…');
  const g1 = await callApi({ action: 'create' });
  const g2 = await callApi({ action: 'create' });

  assert(g1.status === 200 && g1.data.code, 'Game 1 created');
  assert(g2.status === 200 && g2.data.code, 'Game 2 created');
  assert(g1.data.code !== g2.data.code, 'Game codes are unique');

  const G1 = g1.data.code, H1 = g1.data.hostKey;
  const G2 = g2.data.code, H2 = g2.data.hostKey;
  console.log(`  [PASS] Game 1: ${G1}, Game 2: ${G2}`);

  // ── 2. List ongoing games (includes both new games) ──────────────────────
  console.log('\n[2] Listing ongoing games…');
  const listRes = await callApi({ action: 'list_games' });
  assert(listRes.status === 200, 'list_games returns 200');
  assert(Array.isArray(listRes.data.games), 'games is an array');
  const codes = listRes.data.games.map(g => g.code);
  assert(codes.includes(G1), 'Game 1 appears in list');
  assert(codes.includes(G2), 'Game 2 appears in list');
  console.log(`  [PASS] Both games visible in ongoing games list`);

  // ── 3. Direct join (code entry) ──────────────────────────────────────────
  console.log('\n[3] Players joining directly…');
  const rAlice = await callApi({ action: 'join', code: G1, name: 'Alice' });
  const rBob   = await callApi({ action: 'join', code: G1, name: 'Bob' });
  assert(rAlice.status === 200 && rAlice.data.playerId, 'Alice joined Game 1');
  assert(rBob.status === 200   && rBob.data.playerId,   'Bob joined Game 1');
  const aliceId = rAlice.data.playerId;
  const bobId   = rBob.data.playerId;
  console.log('  [PASS] Alice and Bob joined Game 1 directly');

  // ── 4. Join request flow ─────────────────────────────────────────────────
  console.log('\n[4] Join-request flow…');
  // Eve sends a request
  const rReqEve = await callApi({ action: 'request_join', code: G1, name: 'Eve' });
  assert(rReqEve.status === 200 && rReqEve.data.requestId, 'Eve request_join succeeds');
  const eveReqId = rReqEve.data.requestId;

  // Polling while pending
  const pollPending = await callApi({ action: 'poll_request', code: G1, requestId: eveReqId });
  assert(pollPending.data.status === 'pending', 'Request is pending');

  // Host sees pending request in state
  const hostState0 = await callApi({ action: 'state', code: G1, hostKey: H1 });
  assert(hostState0.data.pendingRequests.length >= 1, 'Host sees pending requests');
  assert(hostState0.data.pendingRequests.some(r => r.requestId === eveReqId), 'Eve\'s request visible to host');
  console.log('  [PASS] Eve request sent; host sees it as pending');

  // Host APPROVES Eve
  const rApprove = await callApi({ action: 'handle_request', code: G1, hostKey: H1, requestId: eveReqId, decision: 'approve' });
  assert(rApprove.status === 200 && rApprove.data.approved, 'Host approved Eve');

  // Eve polls — now approved with a playerId
  const pollApproved = await callApi({ action: 'poll_request', code: G1, requestId: eveReqId });
  assert(pollApproved.data.status === 'approved', 'Request status is approved');
  assert(pollApproved.data.playerId, 'Eve got a playerId');
  const eveId = pollApproved.data.playerId;
  console.log(`  [PASS] Eve approved; playerId: ${eveId}`);

  // Frank sends a request and gets DENIED
  const rReqFrank = await callApi({ action: 'request_join', code: G1, name: 'Frank' });
  const frankReqId = rReqFrank.data.requestId;
  await callApi({ action: 'handle_request', code: G1, hostKey: H1, requestId: frankReqId, decision: 'deny' });
  const pollDenied = await callApi({ action: 'poll_request', code: G1, requestId: frankReqId });
  assert(pollDenied.data.status === 'denied', 'Frank request is denied');
  console.log('  [PASS] Frank denied correctly');

  // ── 5. Role counts & shuffle ─────────────────────────────────────────────
  console.log('\n[5] Configuring roles and shuffling…');
  await callApi({ action: 'counts', code: G1, hostKey: H1, counts: { traitors: 1, doctors: 1, detectives: 0 } });
  // Now 3 players (Alice, Bob, Eve); 1 traitor + 1 doctor + 1 villager
  const rShuffle = await callApi({ action: 'shuffle', code: G1, hostKey: H1 });
  assert(rShuffle.status === 200 && rShuffle.data.round === 1, 'Shuffle succeeded, round 1');
  assert(rShuffle.data.totalPlayers === 3, '3 players dealt to');
  console.log('  [PASS] Roles shuffled for round 1 (3 players)');

  // ── 6. Role secrecy ──────────────────────────────────────────────────────
  console.log('\n[6] Verifying role secrecy…');
  const aliceState = await callApi({ action: 'state', code: G1, playerId: aliceId });
  assert(aliceState.data.role !== undefined, 'Alice receives her role');
  assert(aliceState.data.roles === undefined, 'Alice does NOT receive the full roles hash');

  const hostState1 = await callApi({ action: 'state', code: G1, hostKey: H1 });
  assert(hostState1.data.isHost === true, 'Host flag set');
  assert(hostState1.data.players.every(p => p.role === undefined), 'Host sees NO player roles');
  assert(hostState1.data.confirmedCount === 0, 'Initially 0 confirmed');

  const eveState = await callApi({ action: 'state', code: G1, playerId: eveId });
  assert(eveState.data.role !== null, 'Eve gets a role too');
  console.log(`  [PASS] Alice: "${aliceState.data.role}", Eve: "${eveState.data.role}" — no role leaks`);

  // ── 7. Players see the roster ─────────────────────────────────────────────
  console.log('\n[7] Players can see who is in the room…');
  assert(Array.isArray(aliceState.data.players), 'Alice sees players array');
  assert(aliceState.data.players.length === 3, 'Alice sees 3 players');
  assert(aliceState.data.players.every(p => p.role === undefined), 'Player list has no roles for peers');
  const names = aliceState.data.players.map(p => p.name);
  assert(names.includes('Alice') && names.includes('Bob') && names.includes('Eve'), 'All names present');
  console.log('  [PASS] Alice sees all 3 players; no peer roles exposed');

  // ── 8. Ack & role re-view ────────────────────────────────────────────────
  console.log('\n[8] Ack and re-view secret role…');
  const aliceRoleBefore = aliceState.data.role;

  await callApi({ action: 'ack', code: G1, playerId: aliceId });

  // Role is still available for re-peeking (server keeps it until next shuffle)
  const aliceAfterAck = await callApi({ action: 'state', code: G1, playerId: aliceId });
  assert(aliceAfterAck.data.acked === true, 'Alice is acked');
  assert(aliceAfterAck.data.role === aliceRoleBefore, 'Alice can still re-view her role after acking');

  // Host sees confirmed count bump
  const hostState2 = await callApi({ action: 'state', code: G1, hostKey: H1 });
  assert(hostState2.data.confirmedCount === 1, 'Host sees 1/3 confirmed');
  console.log('  [PASS] Role re-view works after ack; host confirmed count = 1');

  // ── 9. Reshuffle resets acks ─────────────────────────────────────────────
  console.log('\n[9] Reshuffle resets acks…');
  const rShuffle2 = await callApi({ action: 'shuffle', code: G1, hostKey: H1 });
  assert(rShuffle2.data.round === 2, 'Round 2 after reshuffle');

  const aliceRound2 = await callApi({ action: 'state', code: G1, playerId: aliceId });
  assert(aliceRound2.data.acked === false, 'Alice ack reset for round 2');
  assert(aliceRound2.data.role !== null, 'Alice has a new role in round 2');
  console.log(`  [PASS] Reshuffle: round 2, Alice ack reset, new role: "${aliceRound2.data.role}"`);

  // ── 10. Game isolation ────────────────────────────────────────────────────
  console.log('\n[10] Game isolation…');
  const rJoinG2 = await callApi({ action: 'join', code: G2, name: 'Charlie' });
  assert(rJoinG2.status === 200, 'Charlie joins Game 2');
  const charlieId = rJoinG2.data.playerId;

  const charlieState = await callApi({ action: 'state', code: G2, playerId: charlieId });
  assert(charlieState.data.code === G2, 'Charlie is in Game 2');
  assert(charlieState.data.dealStarted === false, 'Game 2 not yet shuffled');
  // Charlie should not see Game 1 data
  assert(charlieState.data.players.every(p => p.id !== aliceId), 'Alice is not in Game 2 roster');
  console.log('  [PASS] Game 2 fully isolated from Game 1');

  // ── 11. Host transfer ─────────────────────────────────────────────────────
  console.log('\n[11] Host transfer…');
  const rTransfer = await callApi({ action: 'leave', code: G1, hostKey: H1, newHostPlayerId: aliceId });
  assert(rTransfer.data.transferred === true, 'Transfer succeeded');

  // Alice polls — promoted to host
  const alicePromoted = await callApi({ action: 'state', code: G1, playerId: aliceId });
  assert(alicePromoted.data.isHost === true, 'Alice promoted to host');
  assert(alicePromoted.data.hostKey, 'Alice receives new hostKey');
  const newH1 = alicePromoted.data.hostKey;
  console.log('  [PASS] Host transferred to Alice');

  // ── 12. Host destroy game ─────────────────────────────────────────────────
  console.log('\n[12] Host destroys game instance…');
  const rDestroy = await callApi({ action: 'leave', code: G1, hostKey: newH1 });
  assert(rDestroy.data.destroyed === true, 'Game destroyed');

  // Bob polls — 404
  const bobAfter = await callApi({ action: 'state', code: G1, playerId: bobId });
  assert(bobAfter.status === 404, 'Game 1 is gone; Bob gets 404');

  // Game should no longer appear in ongoing games list
  const listAfter = await callApi({ action: 'list_games' });
  const codesAfter = listAfter.data.games.map(g => g.code);
  assert(!codesAfter.includes(G1), 'Game 1 removed from ongoing list after destruction');
  console.log('  [PASS] Game destroyed; Bob gets 404; removed from list');

  // ── 13. Edge-case: insufficient players ───────────────────────────────────
  console.log('\n[13] Edge cases…');
  const gEdge = (await callApi({ action: 'create' })).data;
  await callApi({ action: 'join', code: gEdge.code, name: 'Solo' }); // only 1 player
  const rShuffleFail = await callApi({ action: 'shuffle', code: gEdge.code, hostKey: gEdge.hostKey });
  assert(rShuffleFail.status === 400, 'Shuffle blocked with <2 players');

  // Edge: role overflow
  await callApi({ action: 'join', code: gEdge.code, name: 'Duo' }); // now 2
  await callApi({ action: 'counts', code: gEdge.code, hostKey: gEdge.hostKey, counts: { traitors: 2, doctors: 2, detectives: 2 } });
  const rOverflow = await callApi({ action: 'shuffle', code: gEdge.code, hostKey: gEdge.hostKey });
  assert(rOverflow.status === 400, 'Shuffle blocked when roles > players');

  // Tidy up
  await callApi({ action: 'leave', code: gEdge.code, hostKey: gEdge.hostKey });
  console.log('  [PASS] Edge cases handled correctly');

  // ── 14. Auth guard on host actions ────────────────────────────────────────
  console.log('\n[14] Auth guards…');
  const gAuth = (await callApi({ action: 'create' })).data;
  await callApi({ action: 'join', code: gAuth.code, name: 'X' });
  await callApi({ action: 'join', code: gAuth.code, name: 'Y' });
  const rBadKey = await callApi({ action: 'shuffle', code: gAuth.code, hostKey: 'WRONG_KEY' });
  assert(rBadKey.status === 403, 'Shuffle blocked with wrong host key');
  console.log('  [PASS] Bad host key correctly rejected with 403');

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('  ✅  ALL 14 VERIFICATION TESTS PASSED');
  console.log('='.repeat(60) + '\n');
}

runTests().catch(err => {
  console.error('\n❌  Test Suite Error:', err.message);
  process.exit(1);
});
