import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { LobbyManager, LEGACY_LOBBY_ID } from "./lobbyManager.js";

/** Per-socket binding to a lobby/player after successful join. */
type Session = {
  playerId: string | null;
  lobbyId: string | null;
};

export type CreateServerOptions = {
  port?: number;
  tickIntervalMs?: number;
  autoStartTick?: boolean;
};

export type BannerfallServer = {
  lobbyManager: LobbyManager;
  wss: WebSocketServer;
  port: number;
  tickIntervalMs: number;
  broadcastLobbySnapshots: (lobbyId: string) => void;
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
  const lobbyManager = new LobbyManager();
  const wss = new WebSocketServer({ port });
  const sessions = new Map<WebSocket, Session>();
  let tickTimer: NodeJS.Timeout | null = null;

  const sendState = (ws: WebSocket, session: Session): void => {
    const lobbyId = session.lobbyId ?? LEGACY_LOBBY_ID;
    const lobby = lobbyManager.getLobbyById(lobbyId);
    if (!lobby) {
      return;
    }

    const snapshot = lobby.engine.getSnapshotForPlayer(session.playerId);
    send(ws, "state", { lobbyId, joinCode: lobby.joinCode, snapshot });
  };

  const broadcastLobbySnapshots = (lobbyId: string): void => {
    const lobby = lobbyManager.getLobbyById(lobbyId);
    if (!lobby) {
      return;
    }

    for (const [ws, session] of sessions.entries()) {
      if ((session.lobbyId ?? LEGACY_LOBBY_ID) !== lobbyId) {
        continue;
      }
      send(ws, "state", {
        lobbyId,
        joinCode: lobby.joinCode,
        snapshot: lobby.engine.getSnapshotForPlayer(session.playerId),
      });
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
      lobbyManager.tickAllLobbies();
      for (const lobby of lobbyManager.getAllLobbies()) {
        broadcastLobbySnapshots(lobby.lobbyId);
      }
    }, tickIntervalMs);
  };

  const resolveLobbyFromJoinRequest = (msg: Record<string, unknown>) => {
    if (typeof msg.lobbyId === "string" && msg.lobbyId.trim().length > 0) {
      return lobbyManager.getLobbyById(msg.lobbyId.trim());
    }
    if (typeof msg.joinCode === "string" && msg.joinCode.trim().length > 0) {
      return lobbyManager.getLobbyByJoinCode(msg.joinCode);
    }
    return null;
  };

  /** Connection lifecycle and action message handling. */
  wss.on("connection", (ws) => {
    // Legacy compatibility: sockets start in legacy lobby until explicit join_lobby.
    sessions.set(ws, { playerId: null, lobbyId: LEGACY_LOBBY_ID });
    send(ws, "connected", { port, tickSeconds: tickIntervalMs / 1000 });

    const initialSession = sessions.get(ws);
    if (initialSession) {
      sendState(ws, initialSession);
    }

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

      if (type === "create_lobby") {
        const result = lobbyManager.createLobby();
        send(ws, "lobby_created", { lobbyId: result.lobbyId, joinCode: result.joinCode });
        return;
      }

      if (type === "join_lobby") {
        if (session.playerId !== null) {
          send(ws, "error", { message: "This socket is already joined. Leave/reconnect first." });
          return;
        }

        const lobby = resolveLobbyFromJoinRequest(msg);
        if (!lobby) {
          send(ws, "error", { message: "Lobby not found." });
          return;
        }

        const requestedPlayerId =
          typeof msg.playerId === "string" && msg.playerId.trim().length > 0
            ? msg.playerId.trim()
            : randomUUID();

        lobbyManager.reconcilePlayerBindings();
        const existingLobbyId = lobbyManager.getPlayerLobbyId(requestedPlayerId);
        if (existingLobbyId && existingLobbyId !== lobby.lobbyId) {
          send(ws, "error", { message: "This playerId is already bound to another lobby." });
          return;
        }

        const requestedName =
          typeof msg.name === "string" && msg.name.trim().length > 0 ? msg.name.trim() : randomName();

        const joinResult = lobby.engine.addPlayer(requestedPlayerId, requestedName);
        if (!joinResult.ok || !joinResult.playerId || joinResult.factionId === null) {
          send(ws, "error", { message: joinResult.error ?? "Join failed." });
          return;
        }

        session.playerId = joinResult.playerId;
        session.lobbyId = lobby.lobbyId;
        lobbyManager.bindPlayerToLobby(joinResult.playerId, lobby.lobbyId);
        lobby.engine.setPlayerConnected(joinResult.playerId, true);

        send(ws, "lobby_joined", {
          lobbyId: lobby.lobbyId,
          joinCode: lobby.joinCode,
          playerId: joinResult.playerId,
          factionId: joinResult.factionId,
          name: requestedName,
        });

        // Legacy compatibility event for old clients.
        send(ws, "joined", {
          playerId: joinResult.playerId,
          factionId: joinResult.factionId,
          name: requestedName,
        });

        broadcastLobbySnapshots(lobby.lobbyId);
        return;
      }

      // Legacy join command binds this socket to a player in the legacy lobby.
      if (type === "join") {
        if (session.playerId !== null) {
          send(ws, "error", { message: "This socket already joined a player." });
          return;
        }

        const lobby = lobbyManager.ensureLegacyLobby();
        const requestedPlayerId =
          typeof msg.playerId === "string" && msg.playerId.trim().length > 0 ? msg.playerId.trim() : randomUUID();

        lobbyManager.reconcilePlayerBindings();
        const existingLobbyId = lobbyManager.getPlayerLobbyId(requestedPlayerId);
        if (existingLobbyId && existingLobbyId !== lobby.lobbyId) {
          send(ws, "error", { message: "This playerId is already bound to another lobby." });
          return;
        }

        const requestedName =
          typeof msg.name === "string" && msg.name.trim().length > 0 ? msg.name.trim() : randomName();

        const result = lobby.engine.addPlayer(requestedPlayerId, requestedName);
        if (!result.ok || !result.playerId || result.factionId === null) {
          send(ws, "error", { message: result.error ?? "Join failed." });
          return;
        }

        session.playerId = result.playerId;
        session.lobbyId = lobby.lobbyId;
        lobbyManager.bindPlayerToLobby(result.playerId, lobby.lobbyId);
        lobby.engine.setPlayerConnected(result.playerId, true);
        send(ws, "joined", {
          playerId: result.playerId,
          factionId: result.factionId,
          name: requestedName,
        });
        broadcastLobbySnapshots(lobby.lobbyId);
        return;
      }

      if (type === "state") {
        sendState(ws, session);
        return;
      }

      if (type === "leave_lobby") {
        if (!session.playerId || !session.lobbyId) {
          send(ws, "error", { message: "Not currently joined to a lobby." });
          return;
        }

        const previousLobbyId = session.lobbyId;
        const previousPlayerId = session.playerId;

        const lobby = lobbyManager.getLobbyById(previousLobbyId);
        if (!lobby) {
          send(ws, "error", { message: "Lobby not found." });
          return;
        }

        if (lobby.engine.hasPlayer(previousPlayerId)) {
          lobby.engine.setPlayerConnected(previousPlayerId, false);
          if (!lobby.engine.isStarted()) {
            const leaveResult = lobby.engine.requestLobbyLeave(previousPlayerId);
            if (!leaveResult.ok) {
              send(ws, "error", { message: leaveResult.error ?? "Leave failed." });
              return;
            }
          }
        }

        session.playerId = null;
        session.lobbyId = LEGACY_LOBBY_ID;

        send(ws, "ack", { action: type, tick: lobby.engine.getCurrentTick(), lobbyId: previousLobbyId });
        sendState(ws, session);
        broadcastLobbySnapshots(previousLobbyId);
        return;
      }

      if (!session.playerId || !session.lobbyId) {
        send(ws, "error", { message: "Join first before sending actions." });
        return;
      }

      const lobby = lobbyManager.getLobbyById(session.lobbyId);
      if (!lobby) {
        send(ws, "error", { message: "Lobby not found." });
        return;
      }

      let result;
      if (type === "request_leave") {
        result = lobby.engine.requestLobbyLeave(session.playerId);
      } else if (type === "cancel_leave") {
        result = lobby.engine.cancelLobbyLeave(session.playerId);
      } else if (type === "manual_attack") {
        result = lobby.engine.queueManualAttack(session.playerId);
      } else if (type === "burst_commit") {
        result = lobby.engine.setBurstCommit(session.playerId, true);
      } else if (type === "burst_cancel") {
        result = lobby.engine.setBurstCommit(session.playerId, false);
      } else {
        send(ws, "error", { message: `Unknown action type: ${type}` });
        return;
      }

      if (!result.ok) {
        send(ws, "error", { message: result.error ?? "Action failed." });
        return;
      }

      send(ws, "ack", { action: type, tick: lobby.engine.getCurrentTick(), lobbyId: session.lobbyId });
      broadcastLobbySnapshots(session.lobbyId);
    });

    ws.on("close", () => {
      const session = sessions.get(ws);
      if (!session) {
        return;
      }

      if (session.playerId && session.lobbyId) {
        const lobby = lobbyManager.getLobbyById(session.lobbyId);
        if (lobby) {
          lobby.engine.setPlayerConnected(session.playerId, false);
          if (!lobby.engine.isStarted()) {
            // Before match start, disconnected players are auto-marked for delayed leave.
            lobby.engine.requestLobbyLeave(session.playerId);
          }
          broadcastLobbySnapshots(session.lobbyId);
        }
      }

      sessions.delete(ws);
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
    lobbyManager,
    wss,
    port,
    tickIntervalMs,
    broadcastLobbySnapshots,
    startTickLoop,
    stopTickLoop,
    close,
  };
}
