import { randomUUID } from "node:crypto";
import { WarEngine } from "./engine/warEngine.js";

export const LEGACY_LOBBY_ID = "legacy";

type LobbyRecord = {
  lobbyId: string;
  joinCode: string;
  engine: WarEngine;
};

export type CreateLobbyResult = {
  lobbyId: string;
  joinCode: string;
};

export class LobbyManager {
  private readonly lobbies = new Map<string, LobbyRecord>();
  private readonly lobbyIdsByJoinCode = new Map<string, string>();
  private readonly playerLobbyById = new Map<string, string>();

  public constructor() {
    this.ensureLegacyLobby();
  }

  public ensureLegacyLobby(): LobbyRecord {
    const existing = this.lobbies.get(LEGACY_LOBBY_ID);
    if (existing) {
      return existing;
    }

    const lobby: LobbyRecord = {
      lobbyId: LEGACY_LOBBY_ID,
      joinCode: "LEGACY",
      engine: new WarEngine(),
    };

    this.lobbies.set(lobby.lobbyId, lobby);
    this.lobbyIdsByJoinCode.set(lobby.joinCode, lobby.lobbyId);
    return lobby;
  }

  public createLobby(): CreateLobbyResult {
    const lobbyId = randomUUID();
    let joinCode = this.generateJoinCode();
    while (this.lobbyIdsByJoinCode.has(joinCode)) {
      joinCode = this.generateJoinCode();
    }

    const lobby: LobbyRecord = {
      lobbyId,
      joinCode,
      engine: new WarEngine(),
    };

    this.lobbies.set(lobbyId, lobby);
    this.lobbyIdsByJoinCode.set(joinCode, lobbyId);

    return { lobbyId, joinCode };
  }

  public getLobbyById(lobbyId: string): LobbyRecord | null {
    return this.lobbies.get(lobbyId) ?? null;
  }

  public getLobbyByJoinCode(joinCode: string): LobbyRecord | null {
    const normalized = joinCode.trim().toUpperCase();
    const lobbyId = this.lobbyIdsByJoinCode.get(normalized);
    if (!lobbyId) {
      return null;
    }
    return this.getLobbyById(lobbyId);
  }

  public getPlayerLobbyId(playerId: string): string | null {
    return this.playerLobbyById.get(playerId) ?? null;
  }

  public bindPlayerToLobby(playerId: string, lobbyId: string): void {
    this.playerLobbyById.set(playerId, lobbyId);
  }

  public unbindPlayer(playerId: string, lobbyId: string): void {
    const boundLobbyId = this.playerLobbyById.get(playerId);
    if (boundLobbyId !== lobbyId) {
      return;
    }
    this.playerLobbyById.delete(playerId);
  }

  public tickAllLobbies(): void {
    for (const lobby of this.lobbies.values()) {
      lobby.engine.tick();
    }
  }

  public getAllLobbies(): LobbyRecord[] {
    return [...this.lobbies.values()];
  }

  private generateJoinCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }
}
