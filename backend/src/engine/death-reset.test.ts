import test from "node:test";
import assert from "node:assert/strict";
import { FACTION_HP_INITIAL, MAX_PLAYERS, PLAYER_HP_INITIAL } from "./constants.js";
import { WarEngine } from "./warEngine.js";
import type { MatchPhase, PublicPlayerView } from "./types.js";

function fillLobbyAndStart(engine: WarEngine): void {
  for (let index = 1; index <= MAX_PLAYERS; index += 1) {
    const result = engine.addPlayer(`p${index}`, `p${index}`);
    assert.equal(result.ok, true);
  }
}

function advanceToPhase(engine: WarEngine, phase: MatchPhase): void {
  let safety = 0;
  while (engine.getSnapshotForPlayer(null).phase !== phase) {
    engine.tick();
    safety += 1;
    assert.ok(safety < 300, `engine should reach ${phase} phase within bounded ticks`);
  }
}

function getFactionPlayerIds(engine: WarEngine, factionId: 0 | 1): string[] {
  return engine
    .getSnapshotForPlayer(null)
    .players.filter((player) => player.factionId === factionId)
    .map((player) => player.id)
    .sort();
}

function getPlayer(engine: WarEngine, playerId: string): PublicPlayerView {
  const player = engine.getSnapshotForPlayer(null).players.find((entry) => entry.id === playerId);
  assert.ok(player, `missing snapshot player: ${playerId}`);
  return player;
}


function waitForCooldownClear(engine: WarEngine, playerId: string): void {
  let safety = 0;
  while (getPlayer(engine, playerId).cooldownRemaining > 0) {
    assert.equal(engine.getSnapshotForPlayer(null).phase, "combat", "combat should still be active");
    engine.tick();
    safety += 1;
    assert.ok(safety < 200, "cooldown should expire within bounded ticks");
  }
}

function waitForNoExposureInFaction(engine: WarEngine, factionId: 0 | 1): void {
  let safety = 0;
  while (
    engine
      .getSnapshotForPlayer(null)
      .players.some((player) => player.factionId === factionId && player.isExposed)
  ) {
    assert.equal(engine.getSnapshotForPlayer(null).phase, "combat", "combat should still be active");
    engine.tick();
    safety += 1;
    assert.ok(safety < 200, "exposure should expire within bounded ticks");
  }
}

test("WarEngine death/reset: death state blocks actions and next-round reset revives players while preserving level and faction HP", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceToPhase(engine, "combat");

  const factionZero = getFactionPlayerIds(engine, 0);
  const factionOne = getFactionPlayerIds(engine, 1);

  const levelerId = factionZero[0]!;
  const attackerAId = factionZero[1]!;
  const victimId = factionOne[0]!;

  assert.equal(getPlayer(engine, victimId).deaths, 0, "death count should start at zero");

  assert.equal(engine.queueManualAttack(victimId).ok, true, "victim should be able to self-expose");
  engine.tick();

  assert.equal(engine.queueManualAttack(levelerId).ok, true, "landed-manual attacker should queue");
  engine.tick();

  assert.equal(getPlayer(engine, levelerId).level, 2, "landed manual hit should grant enough XP to level");

  waitForNoExposureInFaction(engine, 1);

  assert.equal(engine.queueManualAttack(attackerAId).ok, true, "manual fallback attacker should queue");
  engine.tick();

  const enemyFactionHpAfterFallback = engine.getSnapshotForPlayer(null).factions[1].factionHp;
  assert.ok(
    enemyFactionHpAfterFallback < FACTION_HP_INITIAL,
    "manual damage with no exposed targets should reduce enemy faction HP",
  );

  waitForNoExposureInFaction(engine, 1);
  waitForCooldownClear(engine, victimId);
  waitForCooldownClear(engine, attackerAId);

  assert.equal(engine.queueManualAttack(victimId).ok, true, "victim should expose again before kill sequence");
  assert.equal(engine.queueManualAttack(attackerAId).ok, true);
  engine.tick();

  const victimAfterSetup = getPlayer(engine, victimId);
  assert.ok(victimAfterSetup.hp > 0, "setup attack should not kill victim yet");

  waitForCooldownClear(engine, levelerId);
  assert.equal(engine.queueManualAttack(levelerId).ok, true, "killer should queue final attack");
  engine.tick();

  const victimAfterDeath = getPlayer(engine, victimId);
  assert.equal(victimAfterDeath.isAlive, false, "victim should be marked dead after lethal damage");
  assert.equal(victimAfterDeath.hp, 0, "dead victim HP should be clamped to zero");
  assert.equal(victimAfterDeath.isExposed, false, "dead victim should not remain exposed");
  assert.equal(victimAfterDeath.cooldownRemaining, 0, "dead victim cooldown should be cleared");
  assert.equal(victimAfterDeath.deaths, 1, "death count should increment on elimination");

  assert.deepEqual(engine.queueManualAttack(victimId), {
    ok: false,
    error: "Dead players cannot attack.",
  });
  assert.deepEqual(engine.setBurstCommit(victimId, true), {
    ok: false,
    error: "Dead players cannot change burst commitment.",
  });

  const levelBeforeReset = getPlayer(engine, levelerId).level;
  const enemyFactionHpBeforeReset = engine.getSnapshotForPlayer(null).factions[1].factionHp;
  assert.ok(
    enemyFactionHpBeforeReset <= enemyFactionHpAfterFallback,
    "later combat should not increase faction HP before reset",
  );

  advanceToPhase(engine, "transition");

  const victimAfterReset = getPlayer(engine, victimId);
  assert.equal(victimAfterReset.isAlive, true, "round reset should revive dead players");
  assert.equal(victimAfterReset.hp, PLAYER_HP_INITIAL, "round reset should restore player HP");
  assert.equal(victimAfterReset.isExposed, false, "round reset should clear exposure");
  assert.equal(victimAfterReset.cooldownRemaining, 0, "round reset should clear cooldown");
  assert.equal(victimAfterReset.deaths, 1, "round reset should preserve match-wide deaths");

  assert.ok(levelBeforeReset > 1, "leveler should have gained levels before reset");
  assert.equal(getPlayer(engine, levelerId).level, levelBeforeReset, "round reset should preserve player level");
  assert.equal(
    engine.getSnapshotForPlayer(null).factions[1].factionHp,
    enemyFactionHpBeforeReset,
    "round reset should preserve faction HP",
  );
});
