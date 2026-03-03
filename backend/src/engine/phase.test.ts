import test from "node:test";
import assert from "node:assert/strict";
import {
  COMBAT_PHASE_SECONDS,
  MAX_PLAYERS,
  PREP_PHASE_SECONDS,
  TOTAL_ROUNDS,
  TRANSITION_SECONDS,
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

test("WarEngine phase: starts in prep round 1 after auto-start", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);

  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.started, true);
  assert.equal(snapshot.phase, "prep");
  assert.equal(snapshot.phaseRemaining, PREP_PHASE_SECONDS);
  assert.equal(snapshot.round, 1);
});

test("WarEngine phase: prep transitions to combat after prep timer expires", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);

  advanceTicks(engine, PREP_PHASE_SECONDS);

  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.phase, "combat");
  assert.equal(snapshot.phaseRemaining, COMBAT_PHASE_SECONDS);
  assert.equal(snapshot.round, 1);
});

test("WarEngine phase: combat transitions to transition, then next prep with round increment", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);

  advanceTicks(engine, PREP_PHASE_SECONDS);
  advanceTicks(engine, COMBAT_PHASE_SECONDS);

  let snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.phase, "transition");
  assert.equal(snapshot.phaseRemaining, TRANSITION_SECONDS);
  assert.equal(snapshot.round, 1);

  advanceTicks(engine, TRANSITION_SECONDS);
  snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.phase, "prep");
  assert.equal(snapshot.phaseRemaining, PREP_PHASE_SECONDS);
  assert.equal(snapshot.round, 2);
});

test("WarEngine phase: ends at round limit after round 5 combat", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);

  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    advanceTicks(engine, PREP_PHASE_SECONDS);
    advanceTicks(engine, COMBAT_PHASE_SECONDS);
    if (round < TOTAL_ROUNDS) {
      advanceTicks(engine, TRANSITION_SECONDS);
    }
  }

  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.ended, true);
  assert.equal(snapshot.phase, "ended");
  assert.equal(snapshot.phaseRemaining, 0);
  assert.equal(snapshot.round, TOTAL_ROUNDS);
  assert.equal(snapshot.winnerFactionId, null);
});
