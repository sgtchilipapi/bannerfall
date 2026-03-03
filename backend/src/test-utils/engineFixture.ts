import assert from "node:assert/strict";
import { MAX_PLAYERS } from "../engine/constants.js";
import { WarEngine } from "../engine/warEngine.js";
import { advanceToCombat } from "./tick.js";

type EngineFixtureOptions = {
  autoFillLobby?: boolean;
  startCombat?: boolean;
};

export function fillLobby(engine: WarEngine, playerCount = MAX_PLAYERS): string[] {
  const playerIds: string[] = [];
  for (let index = 1; index <= playerCount; index += 1) {
    const playerId = `p${index}`;
    const result = engine.addPlayer(playerId, playerId);
    assert.equal(result.ok, true);
    playerIds.push(playerId);
  }
  return playerIds;
}

export function createEngineFixture(options?: EngineFixtureOptions): WarEngine {
  const { autoFillLobby = true, startCombat = true } = options ?? {};
  const engine = new WarEngine();

  if (autoFillLobby) {
    fillLobby(engine);
  }

  if (autoFillLobby && startCombat) {
    advanceToCombat(engine);
  }

  return engine;
}

export function getPlayerFromSnapshot(engine: WarEngine, viewerId: string | null, targetId: string) {
  const snapshot = engine.getSnapshotForPlayer(viewerId);
  const player = snapshot.players.find((entry) => entry.id === targetId);
  assert.ok(player);
  return player;
}
