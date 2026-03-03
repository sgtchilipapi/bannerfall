import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTACK_POWER_PER_LEVEL,
  BASE_ATTACK_POWER,
  KILL_XP,
  MANUAL_LANDED_XP,
  MAX_LEVEL,
  MAX_PLAYERS,
  XP_THRESHOLDS,
} from "./constants.js";
import { WarEngine } from "./warEngine.js";

function fillLobbyAndStart(engine: WarEngine): void {
  for (let index = 1; index <= MAX_PLAYERS; index += 1) {
    const result = engine.addPlayer(`p${index}`, `p${index}`);
    assert.equal(result.ok, true);
  }
}

function advanceToCombat(engine: WarEngine): void {
  let safety = 0;
  while (engine.getSnapshotForPlayer(null).phase !== "combat") {
    engine.tick();
    safety += 1;
    assert.ok(safety < 200, "engine should reach combat phase within bounded ticks");
  }
}

function getFactionPlayerIds(engine: WarEngine, factionId: 0 | 1): string[] {
  return engine
    .getSnapshotForPlayer(null)
    .players.filter((player) => player.factionId === factionId)
    .map((player) => player.id)
    .sort();
}

function getOutcomePlayer(engine: WarEngine, playerId: string) {
  const player = engine.getOutcomeSummary().playerStats.find((entry) => entry.id === playerId);
  assert.ok(player, `missing outcome player: ${playerId}`);
  return player;
}

function getSnapshotPlayer(engine: WarEngine, playerId: string) {
  const player = engine.getSnapshotForPlayer(playerId).players.find((entry) => entry.id === playerId);
  assert.ok(player, `missing snapshot player: ${playerId}`);
  return player;
}

function performLandedManualHit(engine: WarEngine, attackerId: string, targetId: string): void {
  advanceToCombat(engine);

  assert.equal(engine.queueManualAttack(targetId).ok, true, "target should be able to expose self");
  engine.tick();

  advanceToCombat(engine);

  assert.equal(engine.queueManualAttack(attackerId).ok, true, "attacker should be able to queue manual attack");
  engine.tick();

  const resolvedTick = engine.getCurrentTick();
  const damageEntry = engine
    .getOutcomeSummary()
    .damageLog.find(
      (entry) => entry.tick === resolvedTick && entry.attackerId === attackerId && entry.kind === "manual",
    );

  assert.ok(damageEntry, "expected attacker manual damage entry on resolve tick");
  assert.equal(damageEntry.hitExposedPlayers, true, "manual hit should route into exposed target");
  assert.ok(damageEntry.damageToPlayers > 0, "landed manual should damage a player");

  let safety = 0;
  while (getSnapshotPlayer(engine, attackerId).cooldownRemaining > 0) {
    engine.tick();
    safety += 1;
    assert.ok(safety < 200, "attacker cooldown should eventually expire");
  }
}

test("WarEngine xp/level: manual landed hit grants +5 XP and levels at threshold", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);

  const factionZero = getFactionPlayerIds(engine, 0);
  const factionOne = getFactionPlayerIds(engine, 1);
  const attackerId = factionZero[0]!;
  const targetId = factionOne[0]!;

  performLandedManualHit(engine, attackerId, targetId);

  const attacker = getOutcomePlayer(engine, attackerId);
  assert.equal(attacker.xp, MANUAL_LANDED_XP);
  assert.equal(attacker.level, 2);

  const snapshotAttacker = getSnapshotPlayer(engine, attackerId);
  assert.equal(snapshotAttacker.attackPower, BASE_ATTACK_POWER + ATTACK_POWER_PER_LEVEL);
});

test("WarEngine xp/level: kill credit grants +2 XP on top of landed-manual XP", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceToCombat(engine);

  const factionZero = getFactionPlayerIds(engine, 0);
  const factionOne = getFactionPlayerIds(engine, 1);
  const killerId = factionZero[0]!;
  const setupA = factionZero[1]!;
  const setupB = factionZero[2]!;
  const victimId = factionOne[0]!;

  assert.equal(engine.queueManualAttack(victimId).ok, true);
  assert.equal(engine.queueManualAttack(setupA).ok, true);
  assert.equal(engine.queueManualAttack(setupB).ok, true);
  engine.tick();

  const victimAfterSetup = getSnapshotPlayer(engine, victimId);
  assert.ok(victimAfterSetup.hp > 0, "victim should survive setup damage");

  assert.equal(engine.queueManualAttack(killerId).ok, true);
  engine.tick();

  const victimAfterKill = getSnapshotPlayer(engine, victimId);
  assert.equal(victimAfterKill.isAlive, false);
  assert.equal(victimAfterKill.hp, 0);

  const killer = getOutcomePlayer(engine, killerId);
  assert.equal(killer.kills, 1);
  assert.equal(killer.xp, MANUAL_LANDED_XP + KILL_XP);
});

test("WarEngine xp/level: cumulative thresholds cap at max level and AP scaling stops at cap", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);

  const factionZero = getFactionPlayerIds(engine, 0);
  const factionOne = getFactionPlayerIds(engine, 1);
  const attackerId = factionZero[0]!;

  for (let index = 0; index < 7; index += 1) {
    const targetId = factionOne[index % factionOne.length]!;
    performLandedManualHit(engine, attackerId, targetId);
  }

  const xpAtMaxLevel = XP_THRESHOLDS[MAX_LEVEL - 1];
  if (xpAtMaxLevel === undefined) {
    throw new Error("missing max-level XP threshold");
  }

  const attackerAtCap = getOutcomePlayer(engine, attackerId);
  assert.equal(attackerAtCap.xp, xpAtMaxLevel);
  assert.equal(attackerAtCap.level, MAX_LEVEL);
  assert.equal(
    getSnapshotPlayer(engine, attackerId).attackPower,
    BASE_ATTACK_POWER + ATTACK_POWER_PER_LEVEL * (MAX_LEVEL - 1),
  );

  const nextTargetId = factionOne[(7 + 1) % factionOne.length]!;
  performLandedManualHit(engine, attackerId, nextTargetId);

  const attackerBeyondCap = getOutcomePlayer(engine, attackerId);
  assert.equal(attackerBeyondCap.xp, xpAtMaxLevel + MANUAL_LANDED_XP);
  assert.equal(attackerBeyondCap.level, MAX_LEVEL);
  assert.equal(
    getSnapshotPlayer(engine, attackerId).attackPower,
    BASE_ATTACK_POWER + ATTACK_POWER_PER_LEVEL * (MAX_LEVEL - 1),
  );
});
