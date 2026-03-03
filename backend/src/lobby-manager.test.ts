import assert from "node:assert/strict";
import test from "node:test";
import { LobbyManager, LEGACY_LOBBY_ID } from "./lobbyManager.js";

test("LobbyManager: bootstraps legacy lobby", () => {
  const manager = new LobbyManager();
  const legacy = manager.getLobbyById(LEGACY_LOBBY_ID);
  assert.ok(legacy);
  assert.equal(legacy?.joinCode, "LEGACY");
});

test("LobbyManager: createLobby returns unique ids and join codes", () => {
  const manager = new LobbyManager();
  const lobbyA = manager.createLobby();
  const lobbyB = manager.createLobby();

  assert.notEqual(lobbyA.lobbyId, lobbyB.lobbyId);
  assert.notEqual(lobbyA.joinCode, lobbyB.joinCode);
  assert.ok(manager.getLobbyByJoinCode(lobbyA.joinCode));
});
