import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { WarEngine } from "./engine/warEngine.js";

/** Per-socket binding to an engine player id after successful join. */
type Session = {
  playerId: string | null;
};

export type CreateServerOptions = {
  port?: number;
  tickIntervalMs?: number;
  engine?: WarEngine;
  autoStartTick?: boolean;
};

export type BannerfallServer = {
  engine: WarEngine;
  wss: WebSocketServer;
  port: number;
  tickIntervalMs: number;
  broadcastSnapshots: () => void;
  startTickLoop: () => void;
  stopTickLoop: () => void;
  close: () => Promise<void>;
};

/** Name generation pools used when client omits a display name. */
const NAME_PREFIXES = ["Iron", "Storm", "Grim", "Ash", "Vex", "Rune", "Feral", "Nova"];
const NAME_SUFFIXES = ["Wolf", "Banner", "Warden", "Spear", "Flint", "Raven", "Hawk", "Pyre"];

/** Generates a short random display name for anonymous join requests. */
function randomName(): string {
  const prefix = NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)];
  const suffix = NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)];
  const digits = Math.floor(100 + Math.random() * 900);
  return `${prefix}${suffix}${digits}`;
}

/** Sends one JSON envelope to a websocket if still open. */
function send(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type, ...payload }));
}

/** Parses raw websocket payload into a JSON object or returns null for invalid input. */
function parseMessage(raw: unknown): Record<string, unknown> | null {
  try {
    if (typeof raw === "string") {
      return JSON.parse(raw) as Record<string, unknown>;
    }
    if (raw instanceof Buffer) {
      return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    }
    if (Array.isArray(raw)) {
      const merged = Buffer.concat(raw as Buffer[]);
      return JSON.parse(merged.toString("utf8")) as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Creates and wires the Bannerfall websocket transport without module-scope side effects. */
export function createServer(options: CreateServerOptions = {}): BannerfallServer {
  const port = options.port ?? Number(process.env.PORT ?? 8080);
  const tickIntervalMs = options.tickIntervalMs ?? 1000;
  const autoStartTick = options.autoStartTick ?? true;
  const engine = options.engine ?? new WarEngine();
  const wss = new WebSocketServer({ port });
  const sessions = new Map<WebSocket, Session>();
  let tickTimer: NodeJS.Timeout | null = null;

  const broadcastSnapshots = (): void => {
    for (const [ws, session] of sessions.entries()) {
      const snapshot = engine.getSnapshotForPlayer(session.playerId);
      send(ws, "state", { snapshot });
    }
  };

  const stopTickLoop = (): void => {
    if (!tickTimer) {
      return;
    }
    clearInterval(tickTimer);
    tickTimer = null;
  };

  const startTickLoop = (): void => {
    if (tickTimer) {
      return;
    }

    tickTimer = setInterval(() => {
      engine.tick();
      broadcastSnapshots();
    }, tickIntervalMs);
  };

  /** Connection lifecycle and action message handling. */
  wss.on("connection", (ws) => {
    // New sockets start unauthenticated until they issue "join".
    sessions.set(ws, { playerId: null });
    send(ws, "connected", { port, tickSeconds: tickIntervalMs / 1000 });
    send(ws, "state", { snapshot: engine.getSnapshotForPlayer(null) });

    ws.on("message", (raw) => {
      const msg = parseMessage(raw);
      if (!msg) {
        send(ws, "error", { message: "Invalid JSON message." });
        return;
      }

      const type = typeof msg.type === "string" ? msg.type : "";
      const session = sessions.get(ws);
      if (!session) {
        return;
      }

      // Join command binds this socket to a persistent engine player id.
      if (type === "join") {
        if (session.playerId !== null) {
          send(ws, "error", { message: "This socket already joined a player." });
          return;
        }

        const requestedPlayerId =
          typeof msg.playerId === "string" && msg.playerId.trim().length > 0
            ? msg.playerId.trim()
            : randomUUID();

        const requestedName =
          typeof msg.name === "string" && msg.name.trim().length > 0 ? msg.name.trim() : randomName();

        const result = engine.addPlayer(requestedPlayerId, requestedName);
        if (!result.ok || !result.playerId || result.factionId === null) {
          send(ws, "error", { message: result.error ?? "Join failed." });
          return;
        }

        session.playerId = result.playerId;
        engine.setPlayerConnected(result.playerId, true);
        send(ws, "joined", {
          playerId: result.playerId,
          factionId: result.factionId,
          name: requestedName,
        });
        broadcastSnapshots();
        return;
      }

      // Allows clients to explicitly fetch current state on demand.
      if (type === "state") {
        send(ws, "state", { snapshot: engine.getSnapshotForPlayer(session.playerId) });
        return;
      }

      if (!session.playerId) {
        send(ws, "error", { message: "Join first before sending actions." });
        return;
      }

      // Action routing to engine command surface.
      let result;
      if (type === "request_leave") {
        result = engine.requestLobbyLeave(session.playerId);
      } else if (type === "cancel_leave") {
        result = engine.cancelLobbyLeave(session.playerId);
      } else if (type === "manual_attack") {
        result = engine.queueManualAttack(session.playerId);
      } else if (type === "burst_commit") {
        result = engine.setBurstCommit(session.playerId, true);
      } else if (type === "burst_cancel") {
        result = engine.setBurstCommit(session.playerId, false);
      } else {
        send(ws, "error", { message: `Unknown action type: ${type}` });
        return;
      }

      if (!result.ok) {
        send(ws, "error", { message: result.error ?? "Action failed." });
        return;
      }

      send(ws, "ack", { action: type, tick: engine.getCurrentTick() });
      broadcastSnapshots();
    });

    ws.on("close", () => {
      const session = sessions.get(ws);
      if (!session) {
        return;
      }

      if (session.playerId) {
        engine.setPlayerConnected(session.playerId, false);
        if (!engine.isStarted()) {
          // Before match start, disconnected players are auto-marked for delayed leave.
          engine.requestLobbyLeave(session.playerId);
        }
      }

      sessions.delete(ws);
      broadcastSnapshots();
    });
  });

  if (autoStartTick) {
    startTickLoop();
  }

  const close = async (): Promise<void> => {
    stopTickLoop();
    for (const ws of sessions.keys()) {
      ws.close();
    }
    sessions.clear();

    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  return {
    engine,
    wss,
    port,
    tickIntervalMs,
    broadcastSnapshots,
    startTickLoop,
    stopTickLoop,
    close,
  };
}
