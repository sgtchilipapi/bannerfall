import test from "node:test";
import assert from "node:assert/strict";
import { ATTACK_COOLDOWN_SECONDS, BURST_CANCEL_SECONDS, BURST_LOCK_RATIO } from "./constants.js";
import { createEngineFixture, getPlayerFromSnapshot } from "../test-utils/engineFixture.js";

function getFactionPlayerIds(engine: ReturnType<typeof createEngineFixture>, factionId: 0 | 1): string[] {
  const snapshot = engine.getSnapshotForPlayer(null);
  return snapshot.players
    .filter((player) => player.factionId === factionId)
    .map((player) => player.id)
    .sort();
}

test("WarEngine burst: cancel request finalizes only after 3-tick delay", () => {
  const engine = createEngineFixture();

  const [playerId] = getFactionPlayerIds(engine, 0);
  assert.ok(playerId);
  const viewerId = playerId;

  const committed = engine.setBurstCommit(playerId, true);
  assert.equal(committed.ok, true);

  const cancelRequested = engine.setBurstCommit(playerId, false);
  assert.equal(cancelRequested.ok, true);

  for (let index = 0; index < BURST_CANCEL_SECONDS - 1; index += 1) {
    engine.tick();
  }
  let player = getPlayerFromSnapshot(engine, viewerId, playerId);
  assert.equal(player.isCommittedToBurst, true);

  engine.tick();
  player = getPlayerFromSnapshot(engine, viewerId, playerId);
  assert.equal(player.isCommittedToBurst, false);
});

test("WarEngine burst: locks only when committed alive ratio reaches at least 70%", () => {
  const engine = createEngineFixture();

  const factionZero = getFactionPlayerIds(engine, 0);
  assert.equal(factionZero.length, 7);

  const belowThreshold = Math.floor(factionZero.length * BURST_LOCK_RATIO);
  assert.equal(belowThreshold, 4);

  for (const id of factionZero.slice(0, belowThreshold)) {
    assert.equal(engine.setBurstCommit(id, true).ok, true);
  }

  engine.tick();
  const viewerId = factionZero[0]!;
  let snapshot = engine.getSnapshotForPlayer(viewerId);
  assert.equal(snapshot.factions[0].burstLocked, false);

  const nextCommitterId = factionZero[belowThreshold]!;
  const lockCommit = engine.setBurstCommit(nextCommitterId, true);
  assert.equal(lockCommit.ok, true);

  engine.tick();
  snapshot = engine.getSnapshotForPlayer(viewerId);
  assert.equal(snapshot.factions[0].burstLocked, true);
  assert.equal(snapshot.factions[0].burstCommitCount, belowThreshold + 1);
});

test("WarEngine burst: cancellation is rejected once burst is locked", () => {
  const engine = createEngineFixture();

  const factionZero = getFactionPlayerIds(engine, 0);
  for (const id of factionZero.slice(0, 5)) {
    assert.equal(engine.setBurstCommit(id, true).ok, true);
  }

  engine.tick();

  const cancelAfterLock = engine.setBurstCommit(factionZero[0]!, false);
  assert.equal(cancelAfterLock.ok, false);
  assert.equal(cancelAfterLock.error, "Burst already locked. Cancel is no longer allowed.");
});

test("WarEngine burst: commit is blocked while shared cooldown is active", () => {
  const engine = createEngineFixture();

  const attacked = engine.queueManualAttack("p1");
  assert.equal(attacked.ok, true);

  const blockedCommit = engine.setBurstCommit("p1", true);
  assert.equal(blockedCommit.ok, false);
  assert.equal(blockedCommit.error, `Attack cooldown active for ${ATTACK_COOLDOWN_SECONDS}s.`);
});

test("WarEngine burst: executes on the tick after lock and clears burst state", () => {
  const engine = createEngineFixture();

  const factionZero = getFactionPlayerIds(engine, 0);
  for (const id of factionZero.slice(0, 5)) {
    assert.equal(engine.setBurstCommit(id, true).ok, true);
  }

  engine.tick();

  const lockedAtTick = engine.getCurrentTick();
  const beforeExecutionLogLength = engine.getOutcomeSummary().damageLog.length;

  engine.tick();

  const outcome = engine.getOutcomeSummary();
  const burstEntries = outcome.damageLog.filter((entry) => entry.kind === "burst");
  assert.equal(outcome.damageLog.length - beforeExecutionLogLength, 5);
  assert.equal(burstEntries.length, 5);
  assert.ok(burstEntries.every((entry) => entry.tick === lockedAtTick + 1));

  const events = outcome.burstEvents.filter((entry) => entry.factionId === 0);
  const lockedEvent = events.find((entry) => entry.stage === "locked" && entry.tick === lockedAtTick);
  const executedEvent = events.find(
    (entry) => entry.stage === "executed" && entry.tick === lockedAtTick + 1,
  );
  assert.ok(lockedEvent);
  assert.ok(executedEvent);

  const viewerId = factionZero[0]!;
  const postExecutionSnapshot = engine.getSnapshotForPlayer(viewerId);
  assert.equal(postExecutionSnapshot.factions[0].burstLocked, false);
  assert.equal(postExecutionSnapshot.factions[0].burstCommitCount, 0);

  for (const id of factionZero.slice(0, 5)) {
    const player = getPlayerFromSnapshot(engine, viewerId, id);
    assert.equal(player.isCommittedToBurst, false);
  }
});

test("WarEngine burst: execution applies shared cooldown to participating attackers", () => {
  const engine = createEngineFixture();

  const factionZero = getFactionPlayerIds(engine, 0);
  const burstParticipants = factionZero.slice(0, 5);
  for (const id of burstParticipants) {
    assert.equal(engine.setBurstCommit(id, true).ok, true);
  }

  engine.tick();
  engine.tick();

  for (const id of burstParticipants) {
    const player = getPlayerFromSnapshot(engine, id, id);
    assert.equal(player.cooldownRemaining, ATTACK_COOLDOWN_SECONDS);
  }
});

test("WarEngine burst: committed player cannot queue manual attack before burst execution", () => {
  const engine = createEngineFixture();

  const factionZero = getFactionPlayerIds(engine, 0);
  const burstParticipants = factionZero.slice(0, 5);
  const [manualAttackerId] = burstParticipants;
  assert.ok(manualAttackerId);

  for (const id of burstParticipants) {
    assert.equal(engine.setBurstCommit(id, true).ok, true);
  }
  const manualWhileCommitted = engine.queueManualAttack(manualAttackerId);
  assert.equal(manualWhileCommitted.ok, false);
  assert.equal(manualWhileCommitted.error, "Committed players cannot manual attack.");

  engine.tick();
  const lockedAtTick = engine.getCurrentTick();
  engine.tick();

  const outcome = engine.getOutcomeSummary();
  const burstEntries = outcome.damageLog.filter((entry) => entry.kind === "burst" && entry.tick === lockedAtTick + 1);
  assert.equal(burstEntries.length, burstParticipants.length);
  assert.equal(burstEntries.some((entry) => entry.attackerId === manualAttackerId), true);

  const executeEvent = outcome.burstEvents.find(
    (entry) => entry.factionId === 0 && entry.stage === "executed" && entry.tick === lockedAtTick + 1,
  );
  assert.ok(executeEvent);
  assert.equal(executeEvent.committedAtStage, burstParticipants.length);
});
