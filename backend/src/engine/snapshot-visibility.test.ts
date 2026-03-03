import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PLAYERS, PREP_PHASE_SECONDS } from "./constants.js";
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

function getPlayer(snapshot: ReturnType<WarEngine["getSnapshotForPlayer"]>, playerId: string) {
  const player = snapshot.players.find((entry) => entry.id === playerId);
  assert.ok(player);
  return player;
}

test("WarEngine snapshot visibility: burst commit counts are visible only to teammates", () => {
  const engine = new WarEngine();
  fillLobbyAndStart(engine);
  advanceTicks(engine, PREP_PHASE_SECONDS);

  const factionZero = getFactionPlayerIds(engine, 0);
  const factionOne = getFactionPlayerIds(engine, 1);

  const teamViewer = factionZero[0]!;
  const opponentViewer = factionOne[0]!;

  const committedTeamIds = factionZero.slice(0, 2);
  for (const playerId of committedTeamIds) {
    assert.equal(engine.setBurstCommit(playerId, true).ok, true);
  }

  const teammateSnapshot = engine.getSnapshotForPlayer(teamViewer);
  assert.equal(teammateSnapshot.factions[0].burstCommitCount, committedTeamIds.length);
  assert.equal(teammateSnapshot.factions[1].burstCommitCount, null);

  for (const playerId of committedTeamIds) {
    assert.equal(getPlayer(teammateSnapshot, playerId).isCommittedToBurst, true);
  }
  assert.equal(getPlayer(teammateSnapshot, opponentViewer).isCommittedToBurst, null);

  const opponentSnapshot = engine.getSnapshotForPlayer(opponentViewer);
  assert.equal(opponentSnapshot.factions[0].burstCommitCount, null);
  assert.equal(opponentSnapshot.factions[1].burstCommitCount, 0);

  for (const playerId of committedTeamIds) {
    assert.equal(getPlayer(opponentSnapshot, playerId).isCommittedToBurst, null);
  }

  const spectatorSnapshot = engine.getSnapshotForPlayer(null);
  assert.equal(spectatorSnapshot.factions[0].burstCommitCount, null);
  assert.equal(spectatorSnapshot.factions[1].burstCommitCount, null);
  assert.equal(
    spectatorSnapshot.players.every((player) => player.isCommittedToBurst === null),
    true,
  );
});
