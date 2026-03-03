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

function moveToCombatStart(engine: WarEngine): void {
  advanceTicks(engine, PREP_PHASE_SECONDS);
  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.phase, "combat");
}

function getFactionPlayerIds(engine: WarEngine, factionId: 0 | 1): string[] {
  return engine
    .getSnapshotForPlayer(null)
    .players.filter((player) => player.factionId === factionId)
    .map((player) => player.id);
}

function findMatchEndedReason(engine: WarEngine): string | null {
  const endEvent = engine
    .getSnapshotForPlayer(null)
    .events.find((event) => event.type === "match_ended");
  if (!endEvent || !endEvent.payload) {
    return null;
  }
  const { reason } = endEvent.payload as { reason?: unknown };
  return typeof reason === "string" ? reason : null;
}

test("WarEngine win conditions: ends immediately when faction HP is depleted during combat", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  moveToCombatStart(engine);

  const faction0PlayerIds = getFactionPlayerIds(engine, 0);
  const queueAvailableFaction0Attacks = (): number => {
    let queuedAttacks = 0;
    for (const playerId of faction0PlayerIds) {
      const result = engine.queueManualAttack(playerId);
      if (result.ok) {
        queuedAttacks += 1;
        continue;
      }

      assert.match(result.error ?? "", /cooldown active/i);
    }
    return queuedAttacks;
  };

  assert.ok(queueAvailableFaction0Attacks() > 0);

  let guardTicks = 0;
  while (!engine.isEnded() && guardTicks < 300) {
    engine.tick();
    guardTicks += 1;

    const snapshot = engine.getSnapshotForPlayer(null);
    if (snapshot.phase === "combat") {
      queueAvailableFaction0Attacks();
    }
  }

  assert.equal(engine.isEnded(), true);

  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.winnerFactionId, 0);
  assert.equal(snapshot.phase, "ended");
  assert.equal(findMatchEndedReason(engine), "hp_depleted");
});

test("WarEngine win conditions: round-5 winner is faction with higher HP", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  moveToCombatStart(engine);

  const faction0PlayerIds = getFactionPlayerIds(engine, 0);
  for (const playerId of faction0PlayerIds) {
    const result = engine.queueManualAttack(playerId);
    assert.equal(result.ok, true);
  }

  advanceTicks(engine, 1);

  // No more actions; allow round-limit logic to decide from faction HP totals.
  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    advanceTicks(engine, COMBAT_PHASE_SECONDS - (round === 1 ? 1 : 0));
    if (round < TOTAL_ROUNDS) {
      advanceTicks(engine, TRANSITION_SECONDS + PREP_PHASE_SECONDS);
    }
  }

  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.ended, true);
  assert.equal(snapshot.winnerFactionId, 0);
  assert.equal(findMatchEndedReason(engine), "round_limit");
  assert.ok(snapshot.factions[0].factionHp > snapshot.factions[1].factionHp);
});

test("WarEngine win conditions: round-5 equal HP resolves as tie", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);

  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    advanceTicks(engine, PREP_PHASE_SECONDS + COMBAT_PHASE_SECONDS);
    if (round < TOTAL_ROUNDS) {
      advanceTicks(engine, TRANSITION_SECONDS);
    }
  }

  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.ended, true);
  assert.equal(snapshot.winnerFactionId, null);
  assert.equal(findMatchEndedReason(engine), "round_limit_tie");
  assert.equal(snapshot.factions[0].factionHp, snapshot.factions[1].factionHp);
});
