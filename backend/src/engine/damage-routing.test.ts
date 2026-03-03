import test from "node:test";
import assert from "node:assert/strict";
import {
  DENSITY_ALPHA,
  DENSITY_CAP,
  DENSITY_CAP_RATIO,
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
  return engine
    .getSnapshotForPlayer(null)
    .players.filter((player) => player.factionId === factionId)
    .map((player) => player.id)
    .sort();
}

function getPlayerHp(engine: WarEngine, playerId: string): number {
  const player = engine.getSnapshotForPlayer(playerId).players.find((entry) => entry.id === playerId);
  assert.ok(player);
  return player.hp;
}

function expectedDensityMultiplier(attackers: number, aliveTeamSize: number): number {
  if (attackers <= 0 || aliveTeamSize <= 0) {
    return 1;
  }

  const ratio = attackers / aliveTeamSize;
  if (ratio >= DENSITY_CAP_RATIO) {
    return DENSITY_CAP;
  }

  const normalized = ratio / DENSITY_CAP_RATIO;
  return 1 + Math.pow(normalized, DENSITY_ALPHA) * (DENSITY_CAP - 1);
}

function roundDamage(value: number): number {
  return Number(value.toFixed(4));
}

test("WarEngine damage routing: manual damage prioritizes newest exposed target first", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const attackers = getFactionPlayerIds(engine, 0);
  const defenders = getFactionPlayerIds(engine, 1);
  const attackerId = attackers[0]!;
  const olderExposedTargetId = defenders[0]!;
  const newerExposedTargetId = defenders[1]!;

  assert.equal(engine.queueManualAttack(olderExposedTargetId).ok, true);
  engine.tick();

  assert.equal(engine.queueManualAttack(newerExposedTargetId).ok, true);
  assert.equal(engine.queueManualAttack(attackerId).ok, true);

  const olderHpBefore = getPlayerHp(engine, olderExposedTargetId);
  const newerHpBefore = getPlayerHp(engine, newerExposedTargetId);

  engine.tick();

  const olderHpAfter = getPlayerHp(engine, olderExposedTargetId);
  const newerHpAfter = getPlayerHp(engine, newerExposedTargetId);

  assert.ok(newerHpAfter < newerHpBefore, "newest exposed target should take damage first");
  assert.equal(olderHpAfter, olderHpBefore, "older exposed target should remain untouched when damage is insufficient");
});

test("WarEngine damage routing: overflow cascades from exposed players into faction HP", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const factionZero = getFactionPlayerIds(engine, 0);
  const factionOne = getFactionPlayerIds(engine, 1);
  const setupAttackerA = factionZero[0]!;
  const setupAttackerB = factionZero[1]!;
  const primaryAttackerId = factionZero[4]!;
  const supportAttackers = [factionZero[5]!, factionZero[6]!];
  const target = factionOne[0]!;

  assert.equal(engine.queueManualAttack(target).ok, true);
  assert.equal(engine.queueManualAttack(setupAttackerA).ok, true);
  assert.equal(engine.queueManualAttack(setupAttackerB).ok, true);
  engine.tick();

  const targetHpBefore = getPlayerHp(engine, target);
  assert.ok(targetHpBefore < 60, "setup attacks should reduce target HP enough for overflow test");

  assert.equal(engine.queueManualAttack(primaryAttackerId).ok, true);
  for (const attackerId of supportAttackers) {
    assert.equal(engine.queueManualAttack(attackerId).ok, true);
  }

  const factionOneHpBefore = engine.getSnapshotForPlayer(null).factions[1].factionHp;
  engine.tick();

  const damageEntry = engine
    .getOutcomeSummary()
    .damageLog.find(
      (entry) =>
        entry.tick === engine.getCurrentTick() &&
        entry.attackerId === primaryAttackerId &&
        entry.kind === "manual",
    );

  assert.ok(damageEntry);
  assert.ok(damageEntry.hitExposedPlayers, "attack should hit exposed players before faction HP");
  assert.ok(damageEntry.damageToPlayers > 0, "some damage should be routed to exposed players");
  assert.ok(damageEntry.damageToFaction > 0, "overflow should continue into faction HP");

  const factionOneHpAfter = engine.getSnapshotForPlayer(null).factions[1].factionHp;
  assert.ok(factionOneHpAfter < factionOneHpBefore);
});

test("WarEngine damage routing: logged total damage uses density multiplier based on same-tick attackers", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const factionZero = getFactionPlayerIds(engine, 0);
  const attackerIds = factionZero.slice(0, 5);

  for (const attackerId of attackerIds) {
    assert.equal(engine.queueManualAttack(attackerId).ok, true);
  }

  engine.tick();

  const outcome = engine.getOutcomeSummary();
  const entry = outcome.damageLog.find(
    (record) => record.tick === engine.getCurrentTick() && record.attackerId === attackerIds[0],
  );

  assert.ok(entry);
  const expectedMultiplier = roundDamage(expectedDensityMultiplier(attackerIds.length, factionZero.length));
  const expectedTotalDamage = roundDamage(entry.rawDamage * expectedMultiplier);

  assert.equal(entry.multiplier, expectedMultiplier);
  assert.equal(entry.totalDamage, expectedTotalDamage);
  assert.equal(entry.totalDamage > entry.rawDamage, true);
});
