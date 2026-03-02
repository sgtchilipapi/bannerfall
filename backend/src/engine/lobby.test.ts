import test from "node:test";
import assert from "node:assert/strict";
import { LOBBY_LEAVE_SECONDS, LOBBY_REJOIN_COOLDOWN_SECONDS, MAX_PLAYERS } from "./constants.js";
import { WarEngine } from "./warEngine.js";

function join(engine: WarEngine, id: string): void {
  const result = engine.addPlayer(id, id);
  assert.equal(result.ok, true);
}

test("WarEngine lobby: auto-balances players between factions", () => {
  const engine = new WarEngine();
  for (let index = 1; index <= 6; index += 1) {
    join(engine, `p${index}`);
  }

  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.factions[0].playerCount, 3);
  assert.equal(snapshot.factions[1].playerCount, 3);
});

test("WarEngine lobby: auto-starts at 14 players", () => {
  const engine = new WarEngine();
  for (let index = 1; index <= MAX_PLAYERS; index += 1) {
    join(engine, `p${index}`);
  }

  const snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.started, true);
  assert.equal(snapshot.phase, "prep");
  assert.equal(snapshot.round, 1);
});

test("WarEngine lobby: delayed leave and rejoin cooldown", () => {
  const engine = new WarEngine();
  join(engine, "p1");

  const leaveResult = engine.requestLobbyLeave("p1");
  assert.equal(leaveResult.ok, true);

  for (let tick = 0; tick < LOBBY_LEAVE_SECONDS; tick += 1) {
    engine.tick();
  }

  let snapshot = engine.getSnapshotForPlayer(null);
  assert.equal(snapshot.players.some((player) => player.id === "p1"), false);

  const blocked = engine.addPlayer("p1", "p1");
  assert.equal(blocked.ok, false);
  assert.ok((blocked.error ?? "").includes("Rejoin cooldown active"));

  for (let tick = 0; tick < LOBBY_REJOIN_COOLDOWN_SECONDS; tick += 1) {
    engine.tick();
  }

  const allowed = engine.addPlayer("p1", "p1");
  assert.equal(allowed.ok, true);

  snapshot = engine.getSnapshotForPlayer("p1");
  assert.equal(snapshot.players.some((player) => player.id === "p1"), true);
});

test("WarEngine lobby: rejects joins after match start", () => {
  const engine = new WarEngine();
  for (let index = 1; index <= MAX_PLAYERS; index += 1) {
    join(engine, `p${index}`);
  }

  const result = engine.addPlayer("late", "late");
  assert.equal(result.ok, false);
  assert.ok((result.error ?? "").includes("Match already started"));
});
