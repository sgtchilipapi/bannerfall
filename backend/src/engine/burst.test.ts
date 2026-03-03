import test from "node:test";
import assert from "node:assert/strict";
import {
  BURST_CANCEL_SECONDS,
  BURST_LOCK_RATIO,
  MAX_PLAYERS,
  PREP_PHASE_SECONDS,
} from "./constants.js";
import { WarEngine } from "./warEngine.js";

function fillLobbyAndStart(engine: WarEngine): void {
  for (let index = 1; index <= MAX_PLAYERS; index += 1) {
    const result = engine.addPlayer(`p${index}`, `p${index}`);
    assert.equal(result.ok, true);
  }
}

function advanceTicks(engine: WarEngine, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) {
    engine.tick();
  }
}

function getFactionPlayerIds(engine: WarEngine, factionId: 0 | 1): string[] {
  const snapshot = engine.getSnapshotForPlayer(null);
  return snapshot.players
    .filter((player) => player.factionId === factionId)
    .map((player) => player.id)
    .sort();
}

function getPlayer(engine: WarEngine, viewerId: string, targetId: string) {
  const snapshot = engine.getSnapshotForPlayer(viewerId);
  const player = snapshot.players.find((entry) => entry.id === targetId);
  assert.ok(player);
  return player;
}

test("WarEngine burst: cancel request finalizes only after 3-tick delay", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const [playerId] = getFactionPlayerIds(engine, 0);
  assert.ok(playerId);
  const viewerId = playerId;

  const committed = engine.setBurstCommit(playerId, true);
  assert.equal(committed.ok, true);

  const cancelRequested = engine.setBurstCommit(playerId, false);
  assert.equal(cancelRequested.ok, true);

  advanceTicks(engine, BURST_CANCEL_SECONDS - 1);
  let player = getPlayer(engine, viewerId, playerId);
  assert.equal(player.isCommittedToBurst, true);

  advanceTicks(engine, 1);
  player = getPlayer(engine, viewerId, playerId);
  assert.equal(player.isCommittedToBurst, false);
});

test("WarEngine burst: locks only when committed alive ratio reaches at least 70%", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

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
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const factionZero = getFactionPlayerIds(engine, 0);
  for (const id of factionZero.slice(0, 5)) {
    assert.equal(engine.setBurstCommit(id, true).ok, true);
  }

  engine.tick();

  const cancelAfterLock = engine.setBurstCommit(factionZero[0]!, false);
  assert.equal(cancelAfterLock.ok, false);
  assert.equal(cancelAfterLock.error, "Burst already locked. Cancel is no longer allowed.");
});

test("WarEngine burst: executes on the tick after lock and clears burst state", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

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
    const player = getPlayer(engine, viewerId, id);
    assert.equal(player.isCommittedToBurst, false);
  }
});
