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

    sendJson(joinedSocket, { type: "request_leave" });
    const ack = await waitForMessageType(joinedSocket, "ack");
    assert.equal(ack.type, "ack");
    assert.equal(ack.action, "request_leave");
    assert.equal(typeof ack.tick, "number");

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
