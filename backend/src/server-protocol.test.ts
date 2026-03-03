import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createServer } from "./createServer.js";
import {
  getFreePort,
  sendJson,
  waitForMessageType,
  waitForOpen,
} from "./test-utils/websocketHarness.js";

test("server protocol: connect/join/state/action/ack/error and malformed message handling", async () => {
  const port = await getFreePort();
  const server = createServer({ port, autoStartTick: false });

  const sockets: WebSocket[] = [];
  try {
    const joinedSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(joinedSocket);
    await waitForOpen(joinedSocket);

    const connected = await waitForMessageType(joinedSocket, "connected");
    assert.equal(connected.type, "connected");
    assert.equal(typeof connected.tickSeconds, "number");

    const initialState = await waitForMessageType(joinedSocket, "state");
    assert.equal(initialState.type, "state");
    assert.equal(typeof initialState.snapshot, "object");
    assert.equal(initialState.lobbyId, "legacy");

    sendJson(joinedSocket, { type: "join", playerId: "integration-p1", name: "Integration One" });
    const joined = await waitForMessageType(joinedSocket, "joined");
    assert.equal(joined.type, "joined");
    assert.equal(joined.playerId, "integration-p1");
    assert.equal(joined.name, "Integration One");
    assert.equal(typeof joined.factionId, "number");

    sendJson(joinedSocket, { type: "state" });
    const requestedState = await waitForMessageType(joinedSocket, "state");
    assert.equal(requestedState.type, "state");
    assert.equal(typeof requestedState.snapshot, "object");
    assert.equal(requestedState.lobbyId, "legacy");

    sendJson(joinedSocket, { type: "request_leave" });
    const ack = await waitForMessageType(joinedSocket, "ack");
    assert.equal(ack.type, "ack");
    assert.equal(ack.action, "request_leave");
    assert.equal(typeof ack.tick, "number");
    assert.equal(ack.lobbyId, "legacy");

    sendJson(joinedSocket, { type: "unknown_action" });
    const unknownActionError = await waitForMessageType(joinedSocket, "error");
    assert.equal(unknownActionError.type, "error");
    assert.equal(unknownActionError.message, "Unknown action type: unknown_action");

    joinedSocket.send("{malformed-json");
    const malformedError = await waitForMessageType(joinedSocket, "error");
    assert.equal(malformedError.type, "error");
    assert.equal(malformedError.message, "Invalid JSON message.");

    const unjoinedSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(unjoinedSocket);
    await waitForOpen(unjoinedSocket);
    await waitForMessageType(unjoinedSocket, "connected");
    await waitForMessageType(unjoinedSocket, "state");

    sendJson(unjoinedSocket, { type: "manual_attack" });
    const preJoinActionError = await waitForMessageType(unjoinedSocket, "error");
    assert.equal(preJoinActionError.type, "error");
    assert.equal(preJoinActionError.message, "Join first before sending actions.");
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    await server.close();
  }
});

test("server protocol: create_lobby + join_lobby isolates state and blocks cross-lobby player reuse", async () => {
  const port = await getFreePort();
  const server = createServer({ port, autoStartTick: false });

  const sockets: WebSocket[] = [];
  try {
    const owner = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(owner);
    await waitForOpen(owner);
    await waitForMessageType(owner, "connected");
    await waitForMessageType(owner, "state");

    sendJson(owner, { type: "create_lobby" });
    const createdA = await waitForMessageType(owner, "lobby_created");
    assert.equal(typeof createdA.lobbyId, "string");
    assert.equal(typeof createdA.joinCode, "string");

    sendJson(owner, { type: "create_lobby" });
    const createdB = await waitForMessageType(owner, "lobby_created");
    assert.notEqual(createdA.lobbyId, createdB.lobbyId);

    sendJson(owner, {
      type: "join_lobby",
      joinCode: createdA.joinCode,
      playerId: "alpha-player",
      name: "Alpha",
    });
    const ownerJoined = await waitForMessageType(owner, "lobby_joined");
    assert.equal(ownerJoined.playerId, "alpha-player");
    assert.equal(ownerJoined.lobbyId, createdA.lobbyId);

    const otherSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(otherSocket);
    await waitForOpen(otherSocket);
    await waitForMessageType(otherSocket, "connected");
    await waitForMessageType(otherSocket, "state");

    sendJson(otherSocket, {
      type: "join_lobby",
      joinCode: createdB.joinCode,
      playerId: "alpha-player",
      name: "Alpha Copy",
    });
    const reusedIdError = await waitForMessageType(otherSocket, "error");
    assert.equal(reusedIdError.message, "This playerId is already bound to another lobby.");

    sendJson(otherSocket, {
      type: "join_lobby",
      joinCode: createdB.joinCode,
      playerId: "bravo-player",
      name: "Bravo",
    });
    const otherJoined = await waitForMessageType(otherSocket, "lobby_joined");
    assert.equal(otherJoined.playerId, "bravo-player");
    assert.equal(otherJoined.lobbyId, createdB.lobbyId);

    sendJson(owner, { type: "state" });
    const ownerState = await waitForMessageType(owner, "state");
    const ownerPlayers = ((ownerState.snapshot as Record<string, unknown>).players as Array<Record<string, unknown>>).map(
      (player) => player.id,
    );
    assert.deepEqual(ownerPlayers, ["alpha-player"]);

    sendJson(otherSocket, { type: "state" });
    const otherState = await waitForMessageType(otherSocket, "state");
    const otherPlayers = ((otherState.snapshot as Record<string, unknown>).players as Array<Record<string, unknown>>).map(
      (player) => player.id,
    );
    assert.deepEqual(otherPlayers, ["bravo-player"]);
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    await server.close();
  }
});
