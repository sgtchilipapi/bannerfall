import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTACK_COOLDOWN_SECONDS,
  MANUAL_EXPOSURE_BASE_SECONDS,
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

function getPlayer(engine: WarEngine, playerId: string) {
  const snapshot = engine.getSnapshotForPlayer(playerId);
  const player = snapshot.players.find((entry) => entry.id === playerId);
  assert.ok(player);
  return player;
}

test("WarEngine manual attack: action gated outside combat", () => {
  const engine = new WarEngine();

  const beforeStart = engine.queueManualAttack("p1");
  assert.equal(beforeStart.ok, false);
  assert.equal(beforeStart.error, "Manual attack is only available during combat.");

  fillLobbyAndStart(engine);
  const inPrep = engine.queueManualAttack("p1");
  assert.equal(inPrep.ok, false);
  assert.equal(inPrep.error, "Manual attack is only available during combat.");
});

test("WarEngine manual attack: resolves on next tick (not immediately)", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const factionHpBeforeQueue = engine.getSnapshotForPlayer(null).factions[1].factionHp;
  const queueResult = engine.queueManualAttack("p1");
  assert.equal(queueResult.ok, true);

  const outcomeBeforeTick = engine.getOutcomeSummary();
  assert.equal(outcomeBeforeTick.damageLog.length, 0);
  assert.equal(engine.getSnapshotForPlayer(null).factions[1].factionHp, factionHpBeforeQueue);

  engine.tick();

  const outcomeAfterTick = engine.getOutcomeSummary();
  assert.equal(outcomeAfterTick.damageLog.length, 1);
  assert.equal(outcomeAfterTick.damageLog[0]?.kind, "manual");
  assert.equal(outcomeAfterTick.damageLog[0]?.attackerId, "p1");
});

test("WarEngine manual attack: applies exposure and cooldown to attacker", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const queued = engine.queueManualAttack("p1");
  assert.equal(queued.ok, true);

  let attacker = getPlayer(engine, "p1");
  assert.equal(attacker.isExposed, true);
  assert.equal(attacker.cooldownRemaining, ATTACK_COOLDOWN_SECONDS);

  advanceTicks(engine, MANUAL_EXPOSURE_BASE_SECONDS);
  attacker = getPlayer(engine, "p1");
  assert.equal(attacker.isExposed, false);
});

test("WarEngine manual attack: cooldown blocks repeated queue until timer expires", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const first = engine.queueManualAttack("p1");
  assert.equal(first.ok, true);

  const blocked = engine.queueManualAttack("p1");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, `Attack cooldown active for ${ATTACK_COOLDOWN_SECONDS}s.`);

  advanceTicks(engine, ATTACK_COOLDOWN_SECONDS);

  const second = engine.queueManualAttack("p1");
  assert.equal(second.ok, true);
});

test("WarEngine manual attack: routes to faction HP when no exposed target exists", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const initialTargetFactionHp = engine.getSnapshotForPlayer(null).factions[1].factionHp;

  const queued = engine.queueManualAttack("p1");
  assert.equal(queued.ok, true);
  engine.tick();

  const outcome = engine.getOutcomeSummary();
  const lastDamage = outcome.damageLog[outcome.damageLog.length - 1];
  assert.ok(lastDamage);
  assert.equal(lastDamage.kind, "manual");
  assert.equal(lastDamage.damageToPlayers, 0);
  assert.ok(lastDamage.damageToFaction > 0);

  const postTickTargetFactionHp = engine.getSnapshotForPlayer(null).factions[1].factionHp;
  assert.ok(postTickTargetFactionHp < initialTargetFactionHp);
});

test("WarEngine manual attack: burst-committed players cannot manual attack", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const committed = engine.setBurstCommit("p1", true);
  assert.equal(committed.ok, true);

  const blocked = engine.queueManualAttack("p1");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "Committed players cannot manual attack.");
});
