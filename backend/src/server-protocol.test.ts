import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { createServer } from "./createServer.js";

type Envelope = {
  type?: unknown;
  [key: string]: unknown;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate ephemeral port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForOpen(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket open timeout."));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

async function waitForMessageType(socket: WebSocket, wantedType: string, timeoutMs = 2_000): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message type ${wantedType}.`));
    }, timeoutMs);

    const onMessage = (raw: RawData) => {
      const parsed = JSON.parse(raw.toString("utf8")) as Envelope;
      if (parsed.type === wantedType) {
        cleanup();
        resolve(parsed);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  socket.send(JSON.stringify(payload));
}

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
