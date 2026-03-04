import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createServer } from "./createServer.js";
import {
  LOBBY_LEAVE_SECONDS,
  LOBBY_REJOIN_COOLDOWN_SECONDS,
  MAX_PLAYERS,
} from "./engine/constants.js";
import {
  getFreePort,
  openSocketWithHandshake,
  sendJson,
  waitForMessageType,
} from "./test-utils/websocketHarness.js";

function extractPlayers(snapshotEnvelope: Record<string, unknown>): Array<Record<string, unknown>> {
  return (snapshotEnvelope.snapshot as Record<string, unknown>).players as Array<Record<string, unknown>>;
}

function extractStarted(snapshotEnvelope: Record<string, unknown>): boolean {
  return ((snapshotEnvelope.snapshot as Record<string, unknown>).started as boolean) ?? false;
}

test("server protocol: connect/join/state/action/ack/error and malformed message handling", async () => {
  const port = await getFreePort();
  const server = createServer({ port, autoStartTick: false });

  const sockets: WebSocket[] = [];
  try {
    const joinedClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const joinedSocket = joinedClient.socket;
    sockets.push(joinedSocket);

    const connected = joinedClient.connected;
    assert.equal(connected.type, "connected");
    assert.equal(typeof connected.tickSeconds, "number");

    const initialState = joinedClient.state;
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

    const unjoinedClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const unjoinedSocket = unjoinedClient.socket;
    sockets.push(unjoinedSocket);

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
    const ownerClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const owner = ownerClient.socket;
    sockets.push(owner);

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

    const otherClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const otherSocket = otherClient.socket;
    sockets.push(otherSocket);

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
    const ownerPlayers = extractPlayers(ownerState).map((player) => player.id);
    assert.deepEqual(ownerPlayers, ["alpha-player"]);

    sendJson(otherSocket, { type: "state" });
    const otherState = await waitForMessageType(otherSocket, "state");
    const otherPlayers = extractPlayers(otherState).map((player) => player.id);
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

test("server protocol: leave_lobby pre-match detaches socket session and allows same socket to join another lobby", async () => {
  const port = await getFreePort();
  const server = createServer({ port, autoStartTick: false });

  const sockets: WebSocket[] = [];
  try {
    const ownerClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const owner = ownerClient.socket;
    sockets.push(owner);

    sendJson(owner, { type: "create_lobby" });
    const createdA = await waitForMessageType(owner, "lobby_created");

    sendJson(owner, { type: "create_lobby" });
    const createdB = await waitForMessageType(owner, "lobby_created");

    sendJson(owner, {
      type: "join_lobby",
      joinCode: createdA.joinCode,
      playerId: "alpha-player",
      name: "Alpha",
    });
    await waitForMessageType(owner, "lobby_joined");

    const leaveAckPromise = waitForMessageType(owner, "ack");
    const detachedStatePromise = waitForMessageType(owner, "state");
    sendJson(owner, { type: "leave_lobby" });
    const leaveAck = await leaveAckPromise;
    assert.equal(leaveAck.action, "leave_lobby");
    assert.equal(leaveAck.lobbyId, createdA.lobbyId);

    const detachedState = await detachedStatePromise;
    assert.equal(detachedState.lobbyId, "legacy");

    sendJson(owner, {
      type: "join_lobby",
      joinCode: createdB.joinCode,
      playerId: "bravo-player",
      name: "Bravo",
    });
    const rejoined = await waitForMessageType(owner, "lobby_joined");
    assert.equal(rejoined.playerId, "bravo-player");
    assert.equal(rejoined.lobbyId, createdB.lobbyId);
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    await server.close();
  }
});

test("server protocol: leave_lobby pre-match preserves binding until delayed leave finalizes, then allows reuse after cooldown", async () => {
  const port = await getFreePort();
  const server = createServer({ port, autoStartTick: false });

  const sockets: WebSocket[] = [];
  try {
    const ownerClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const owner = ownerClient.socket;
    sockets.push(owner);

    sendJson(owner, { type: "create_lobby" });
    const createdA = await waitForMessageType(owner, "lobby_created");

    sendJson(owner, { type: "create_lobby" });
    const createdB = await waitForMessageType(owner, "lobby_created");

    sendJson(owner, {
      type: "join_lobby",
      joinCode: createdA.joinCode,
      playerId: "alpha-player",
      name: "Alpha",
    });
    await waitForMessageType(owner, "lobby_joined");

    const leaveAckPromise = waitForMessageType(owner, "ack");
    const detachedStatePromise = waitForMessageType(owner, "state");
    sendJson(owner, { type: "leave_lobby" });
    await leaveAckPromise;
    await detachedStatePromise;

    const challengerClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const challenger = challengerClient.socket;
    sockets.push(challenger);

    sendJson(challenger, {
      type: "join_lobby",
      joinCode: createdB.joinCode,
      playerId: "alpha-player",
      name: "Alpha-Clone",
    });
    const stillBound = await waitForMessageType(challenger, "error");
    assert.equal(stillBound.message, "This playerId is already bound to another lobby.");

    for (let tick = 0; tick < LOBBY_LEAVE_SECONDS + LOBBY_REJOIN_COOLDOWN_SECONDS; tick += 1) {
      server.lobbyManager.tickAllLobbies();
    }

    sendJson(challenger, {
      type: "join_lobby",
      joinCode: createdB.joinCode,
      playerId: "alpha-player",
      name: "Alpha-Rejoined",
    });
    const joinedAfterCooldown = await waitForMessageType(challenger, "lobby_joined");
    assert.equal(joinedAfterCooldown.playerId, "alpha-player");
    assert.equal(joinedAfterCooldown.lobbyId, createdB.lobbyId);
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    await server.close();
  }
});

test("server protocol: leave_lobby post-start detaches socket while player remains in match as disconnected", async () => {
  const port = await getFreePort();
  const server = createServer({ port, autoStartTick: false });

  const sockets: WebSocket[] = [];
  try {
    const ownerClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const owner = ownerClient.socket;
    sockets.push(owner);

    sendJson(owner, { type: "create_lobby" });
    const created = await waitForMessageType(owner, "lobby_created");

    sendJson(owner, {
      type: "join_lobby",
      joinCode: created.joinCode,
      playerId: "p1",
      name: "P1",
    });
    await waitForMessageType(owner, "lobby_joined");

    const joinedSockets: WebSocket[] = [owner];
    for (let index = 2; index <= MAX_PLAYERS; index += 1) {
      const client = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
      const socket = client.socket;
      sockets.push(socket);
      joinedSockets.push(socket);

      sendJson(socket, {
        type: "join_lobby",
        joinCode: created.joinCode,
        playerId: `p${index}`,
        name: `P${index}`,
      });
      await waitForMessageType(socket, "lobby_joined");
    }

    const observerSocket = joinedSockets[1];
    assert.ok(observerSocket);

    sendJson(observerSocket, { type: "state" });
    const startedState = await waitForMessageType(observerSocket, "state");
    assert.equal(extractStarted(startedState), true);

    const leaveAckPromise = waitForMessageType(owner, "ack");
    const ownerDetachedPromise = waitForMessageType(owner, "state");
    sendJson(owner, { type: "leave_lobby" });
    const leaveAck = await leaveAckPromise;
    assert.equal(leaveAck.action, "leave_lobby");
    assert.equal(leaveAck.lobbyId, created.lobbyId);

    const ownerDetached = await ownerDetachedPromise;
    assert.equal(ownerDetached.lobbyId, "legacy");

    sendJson(observerSocket, { type: "state" });
    const teammateView = await waitForMessageType(observerSocket, "state");
    const p1 = extractPlayers(teammateView).find((player) => player.id === "p1");
    assert.ok(p1);
    assert.equal(p1.connected, false);
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    await server.close();
  }
});

test("server protocol: match starts exactly when the 14th player joins", async () => {
  const port = await getFreePort();
  const server = createServer({ port, autoStartTick: false });

  const sockets: WebSocket[] = [];
  try {
    const ownerClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const owner = ownerClient.socket;
    sockets.push(owner);

    sendJson(owner, { type: "create_lobby" });
    const created = await waitForMessageType(owner, "lobby_created");

    const participants: WebSocket[] = [];

    for (let index = 1; index <= MAX_PLAYERS - 1; index += 1) {
      const client = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
      const socket = client.socket;
      sockets.push(socket);
      participants.push(socket);

      sendJson(socket, {
        type: "join_lobby",
        joinCode: created.joinCode,
        playerId: `prestart-${index}`,
        name: `PreStart${index}`,
      });
      await waitForMessageType(socket, "lobby_joined");
    }

    const watcherSocket = participants[0];
    assert.ok(watcherSocket);

    sendJson(watcherSocket, { type: "state" });
    const beforeStart = await waitForMessageType(watcherSocket, "state");
    assert.equal(extractStarted(beforeStart), false);
    assert.equal(extractPlayers(beforeStart).length, MAX_PLAYERS - 1);

    const finalClient = await openSocketWithHandshake(`ws://127.0.0.1:${port}`);
    const finalSocket = finalClient.socket;
    sockets.push(finalSocket);

    sendJson(finalSocket, {
      type: "join_lobby",
      joinCode: created.joinCode,
      playerId: "starter-14",
      name: "Starter14",
    });
    await waitForMessageType(finalSocket, "lobby_joined");

    sendJson(watcherSocket, { type: "state" });
    const afterStart = await waitForMessageType(watcherSocket, "state");
    assert.equal(extractStarted(afterStart), true);
    assert.equal(extractPlayers(afterStart).length, MAX_PLAYERS);
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    await server.close();
  }
});
