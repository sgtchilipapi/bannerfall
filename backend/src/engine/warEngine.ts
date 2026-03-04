import {
  ATTACK_COOLDOWN_SECONDS,
  ATTACK_POWER_PER_LEVEL,
  BASE_ATTACK_POWER,
  BURST_CANCEL_SECONDS,
  BURST_EXPOSURE_BASE_SECONDS,
  BURST_LOCK_RATIO,
  COMBAT_PHASE_SECONDS,
  FACTION_HP_INITIAL,
  KILL_XP,
  LOBBY_LEAVE_SECONDS,
  LOBBY_REJOIN_COOLDOWN_SECONDS,
  MANUAL_EXPOSURE_BASE_SECONDS,
  MANUAL_LANDED_XP,
  MAX_LEVEL,
  MAX_PLAYERS,
  PLAYER_HP_INITIAL,
  PREP_PHASE_SECONDS,
  TOTAL_ROUNDS,
  TRANSITION_SECONDS,
  XP_THRESHOLDS,
} from "./constants.js";
import { densityMultiplier } from "./density.js";
import type {
  ActionResult,
  EngineEvent,
  FactionId,
  FactionState,
  JoinResult,
  MatchPhase,
  MatchState,
  PlayerState,
  PublicFactionView,
  PublicPlayerView,
  PublicSnapshot,
  ScheduledAttack,
} from "./types.js";

/** Returns the opposing faction id in a 2-faction match. */
function oppositeFactionId(factionId: FactionId): FactionId {
  return factionId === 0 ? 1 : 0;
}

/** Builds default faction state at match construction time. */
function createFaction(id: FactionId): FactionState {
  return {
    id,
    players: [],
    factionHp: FACTION_HP_INITIAL,
    burstCommits: [],
    burstLocked: false,
    burstScheduledTick: null,
    burstLockedAliveCount: null,
  };
}

/**
 * Exposure tie-breaker:
 * - Higher `exposureAppliedTick` first (newest exposed target).
 * - Stable id ordering as deterministic fallback.
 */
function sortByExposureNewestFirst(a: PlayerState, b: PlayerState): number {
  if (a.exposureAppliedTick !== b.exposureAppliedTick) {
    return b.exposureAppliedTick - a.exposureAppliedTick;
  }
  return a.id.localeCompare(b.id);
}

/** Keeps floating point damage logs stable for client display and testing. */
function roundDamage(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Authoritative deterministic game engine.
 * All state mutations happen through this class on 1-second ticks.
 */
export class WarEngine {
  /**
   * Tracks post-leave rejoin lockout by player id.
   * Value is the tick when joining becomes legal again.
   */
  private readonly rejoinCooldownById = new Map<string, number>();

  /** Single source of truth for match, faction, and player state. */
  private state: MatchState = {
    tick: 0,
    started: false,
    ended: false,
    phase: "waiting",
    phaseRemaining: 0,
    round: 0,
    winnerFactionId: null,
    players: {},
    factions: [createFaction(0), createFaction(1)],
    scheduledAttacks: [],
    damageLog: [],
    burstEvents: [],
    events: [],
  };

  /**
   * Runs one authoritative tick.
   *
   * Order:
   * 1) advance tick id + clear transient events
   * 2) pre-match: process delayed lobby leaves
   * 3) combat phase: execute deterministic combat pipeline
   * 4) phase timer transitions (prep/combat/transition)
   */
  public tick(): void {
    this.state.tick += 1;
    this.state.events = [];

    if (!this.state.started) {
      this.processPendingLobbyLeaves();
      return;
    }

    if (this.state.ended) {
      return;
    }

    if (this.state.phase === "combat") {
      this.runCombatTick();
    }

    if (!this.state.ended) {
      this.advancePhaseTimer();
    }
  }

  /** Indicates whether lobby already transitioned into an active match. */
  public isStarted(): boolean {
    return this.state.started;
  }

  /** Indicates whether a winner/tie has been finalized. */
  public isEnded(): boolean {
    return this.state.ended;
  }

  /** Returns the current authoritative tick counter. */
  public getCurrentTick(): number {
    return this.state.tick;
  }

  /** Indicates whether a player record currently exists in this lobby/match instance. */
  public hasPlayer(playerId: string): boolean {
    return this.state.players[playerId] !== undefined;
  }

  /** Updates transport-level connection status for an existing player record. */
  public setPlayerConnected(playerId: string, connected: boolean): void {
    const player = this.state.players[playerId];
    if (!player) {
      return;
    }
    player.connected = connected;
  }

  /**
   * Adds a player to the lobby (or reconnects by id).
   * Auto-balances into the faction with fewer players.
   * Match auto-starts when player count reaches 14.
   */
  public addPlayer(playerId: string, requestedName: string): JoinResult {
    const existing = this.state.players[playerId];
    if (existing) {
      existing.connected = true;
      existing.pendingLobbyLeaveTick = null;
      this.emitEvent("player_reconnected", `${existing.name} reconnected`, {
        playerId: existing.id,
      });
      return { ok: true, error: null, playerId: existing.id, factionId: existing.factionId };
    }

    if (this.state.started) {
      return {
        ok: false,
        error: "Match already started. New players are blocked.",
        playerId: null,
        factionId: null,
      };
    }

    if (this.getPlayerCount() >= MAX_PLAYERS) {
      return {
        ok: false,
        error: "Lobby is full.",
        playerId: null,
        factionId: null,
      };
    }

    const blockedUntilTick = this.rejoinCooldownById.get(playerId);
    if (blockedUntilTick !== undefined && this.state.tick < blockedUntilTick) {
      return {
        ok: false,
        error: `Rejoin cooldown active for ${blockedUntilTick - this.state.tick}s.`,
        playerId: null,
        factionId: null,
      };
    }

    const factionId = this.pickFactionForJoin();
    const player = this.createPlayer(playerId, requestedName, factionId);
    this.state.players[player.id] = player;
    this.getFaction(factionId).players.push(player.id);

    this.emitEvent("player_joined", `${player.name} joined F${factionId}`, {
      playerId: player.id,
      factionId,
    });

    if (this.getPlayerCount() === MAX_PLAYERS) {
      this.startMatch();
    }

    return { ok: true, error: null, playerId: player.id, factionId };
  }

  /** Marks player for delayed lobby exit (5s) before match start. */
  public requestLobbyLeave(playerId: string): ActionResult {
    if (this.state.started) {
      return { ok: false, error: "Leave intent only available before match start." };
    }

    const player = this.state.players[playerId];
    if (!player) {
      return { ok: false, error: "Player not found in lobby." };
    }

    if (player.pendingLobbyLeaveTick !== null) {
      return { ok: true, error: null };
    }

    player.pendingLobbyLeaveTick = this.state.tick + LOBBY_LEAVE_SECONDS;
    this.emitEvent("leave_requested", `${player.name} requested lobby leave`, {
      playerId: player.id,
      exitsAtTick: player.pendingLobbyLeaveTick,
    });

    return { ok: true, error: null };
  }

  /** Cancels a pending pre-match lobby leave request. */
  public cancelLobbyLeave(playerId: string): ActionResult {
    if (this.state.started) {
      return { ok: false, error: "Lobby leave cancel only available before match start." };
    }

    const player = this.state.players[playerId];
    if (!player) {
      return { ok: false, error: "Player not found in lobby." };
    }

    player.pendingLobbyLeaveTick = null;
    this.emitEvent("leave_cancelled", `${player.name} cancelled leave request`, {
      playerId: player.id,
    });
    return { ok: true, error: null };
  }

  /**
   * Queues a manual attack to resolve on next tick.
   * Also applies immediate exposure window and starts cooldown.
   */
  public queueManualAttack(playerId: string): ActionResult {
    if (!this.state.started || this.state.phase !== "combat" || this.state.ended) {
      return { ok: false, error: "Manual attack is only available during combat." };
    }

    const player = this.state.players[playerId];
    if (!player) {
      return { ok: false, error: "Player not found." };
    }
    if (!player.isAlive) {
      return { ok: false, error: "Dead players cannot attack." };
    }
    if (player.cooldownRemaining > 0) {
      return { ok: false, error: `Attack cooldown active for ${player.cooldownRemaining}s.` };
    }
    if (player.isCommittedToBurst) {
      return { ok: false, error: "Committed players cannot manual attack." };
    }

    this.state.scheduledAttacks.push({
      kind: "manual",
      attackerId: player.id,
      attackerFactionId: player.factionId,
      targetFactionId: oppositeFactionId(player.factionId),
      resolveTick: this.state.tick + 1,
      attackPower: player.attackPower,
    });

    const exposureDuration = this.getManualExposureDuration(player.factionId);
    this.applyExposure(player, exposureDuration);
    player.cooldownRemaining = ATTACK_COOLDOWN_SECONDS;

    this.emitEvent("manual_attack_queued", `${player.name} queued a manual attack`, {
      playerId: player.id,
      resolveTick: this.state.tick + 1,
      exposureDuration,
    });
    return { ok: true, error: null };
  }

  /**
   * Handles burst commitment toggling.
   * `commit=true` immediately commits.
   * `commit=false` requests delayed cancel (3s) when lock has not happened yet.
   */
  public setBurstCommit(playerId: string, commit: boolean): ActionResult {
    if (!this.state.started || this.state.phase !== "combat" || this.state.ended) {
      return { ok: false, error: "Burst actions are only available during combat." };
    }

    const player = this.state.players[playerId];
    if (!player) {
      return { ok: false, error: "Player not found." };
    }
    if (!player.isAlive) {
      return { ok: false, error: "Dead players cannot change burst commitment." };
    }

    if (commit) {
      if (player.isCommittedToBurst) {
        return { ok: true, error: null };
      }
      player.isCommittedToBurst = true;
      player.burstCommitTimestamp = this.state.tick;
      player.pendingBurstCancelTick = null;

      const faction = this.getFaction(player.factionId);
      if (!faction.burstCommits.includes(player.id)) {
        faction.burstCommits.push(player.id);
      }

      this.emitEvent("burst_committed", `${player.name} committed to burst`, {
        playerId: player.id,
        factionId: player.factionId,
      });
      return { ok: true, error: null };
    }

    if (!player.isCommittedToBurst) {
      return { ok: false, error: "Player is not committed to burst." };
    }

    const faction = this.getFaction(player.factionId);
    if (faction.burstLocked) {
      return { ok: false, error: "Burst already locked. Cancel is no longer allowed." };
    }

    if (player.pendingBurstCancelTick !== null) {
      return { ok: true, error: null };
    }

    player.pendingBurstCancelTick = this.state.tick + BURST_CANCEL_SECONDS;
    this.emitEvent("burst_cancel_requested", `${player.name} requested burst cancel`, {
      playerId: player.id,
      factionId: player.factionId,
      cancelAtTick: player.pendingBurstCancelTick,
    });
    return { ok: true, error: null };
  }

  /**
   * Builds a visibility-filtered snapshot for one viewer.
   * Teammate-only burst commitment visibility is applied here.
   */
  public getSnapshotForPlayer(viewerPlayerId: string | null): PublicSnapshot {
    const viewer = viewerPlayerId ? this.state.players[viewerPlayerId] : undefined;
    const viewerFactionId: FactionId | null = viewer ? viewer.factionId : null;

    const factions: [PublicFactionView, PublicFactionView] = [
      this.toPublicFactionView(0, viewerFactionId),
      this.toPublicFactionView(1, viewerFactionId),
    ];

    const players = Object.values(this.state.players)
      .map((player) => this.toPublicPlayerView(player, viewerFactionId))
      .sort((a, b) => {
        if (a.factionId !== b.factionId) {
          return a.factionId - b.factionId;
        }
        return a.name.localeCompare(b.name);
      });

    const events: EngineEvent[] = this.state.events.map((event) => ({ ...event }));

    return {
      tick: this.state.tick,
      started: this.state.started,
      ended: this.state.ended,
      phase: this.state.phase,
      phaseRemaining: this.state.phaseRemaining,
      round: this.state.round,
      totalRounds: TOTAL_ROUNDS,
      winnerFactionId: this.state.winnerFactionId,
      selfPlayerId: viewer ? viewer.id : null,
      selfFactionId: viewerFactionId,
      factions,
      players,
      events,
    };
  }

  /** Returns post-match telemetry payload for DB persistence/on-chain hashing steps. */
  public getOutcomeSummary(): {
    winnerFactionId: FactionId | null;
    finalFactionHp: [number, number];
    playerStats: Array<{
      id: string;
      name: string;
      factionId: FactionId;
      level: number;
      xp: number;
      kills: number;
      damageDealt: number;
    }>;
    burstEvents: MatchState["burstEvents"];
    damageLog: MatchState["damageLog"];
  } {
    const playerStats = Object.values(this.state.players).map((player) => ({
      id: player.id,
      name: player.name,
      factionId: player.factionId,
      level: player.level,
      xp: player.xp,
      kills: player.kills,
      damageDealt: roundDamage(player.damageDealt),
    }));

    return {
      winnerFactionId: this.state.winnerFactionId,
      finalFactionHp: [
        roundDamage(this.state.factions[0].factionHp),
        roundDamage(this.state.factions[1].factionHp),
      ],
      playerStats,
      burstEvents: [...this.state.burstEvents],
      damageLog: [...this.state.damageLog],
    };
  }

  /** Runs the combat-only tick steps in strict MVP order. */
  private runCombatTick(): void {
    this.reduceCooldowns();
    this.reduceExposure();
    this.processPendingBurstCancels();

    const manualAttacks = this.collectManualAttacksForCurrentTick();
    this.checkBurstThresholds();
    const burstAttacks = this.collectBurstAttacksForCurrentTick();

    const pendingDeaths = this.resolveAttacks([...manualAttacks, ...burstAttacks]);
    this.finalizeDeaths(pendingDeaths);
    this.checkImmediateHpWin();
  }

  /** Pulls manual attacks scheduled for this exact tick and keeps future ones queued. */
  private collectManualAttacksForCurrentTick(): ScheduledAttack[] {
    const ready: ScheduledAttack[] = [];
    const remaining: ScheduledAttack[] = [];
    for (const attack of this.state.scheduledAttacks) {
      if (attack.resolveTick === this.state.tick) {
        ready.push(attack);
      } else {
        remaining.push(attack);
      }
    }
    this.state.scheduledAttacks = remaining;
    return ready;
  }

  /**
   * Materializes burst attacks at their scheduled execution tick.
   * A burst contributes one attack per committed alive player.
   */
  private collectBurstAttacksForCurrentTick(): ScheduledAttack[] {
    const attacks: ScheduledAttack[] = [];

    for (const faction of this.state.factions) {
      if (!faction.burstLocked || faction.burstScheduledTick !== this.state.tick) {
        continue;
      }

      const committedAlive = faction.players
        .map((playerId) => this.state.players[playerId])
        .filter((player): player is PlayerState => Boolean(player?.isAlive && player.isCommittedToBurst));

      for (const player of committedAlive) {
        attacks.push({
          kind: "burst",
          attackerId: player.id,
          attackerFactionId: player.factionId,
          targetFactionId: oppositeFactionId(player.factionId),
          resolveTick: this.state.tick,
          attackPower: player.attackPower,
        });
      }

      this.state.burstEvents.push({
        tick: this.state.tick,
        factionId: faction.id,
        stage: "executed",
        committedAtStage: committedAlive.length,
      });

      this.emitEvent(`burst_executed`, `Faction ${faction.id} burst executed`, {
        factionId: faction.id,
        attackers: committedAlive.length,
      });

      this.clearFactionBurstCommitState(faction.id);
    }

    return attacks;
  }

  /**
   * Resolves a batch of attacks with density scaling, routing, and XP effects.
   * Returns unresolved death map for a separate finalize step.
   */
  private resolveAttacks(attacks: ScheduledAttack[]): Map<string, string> {
    const pendingDeaths = new Map<string, string>();
    if (attacks.length === 0) {
      return pendingDeaths;
    }

    const attacksByFaction: [number, number] = [0, 0];
    for (const attack of attacks) {
      attacksByFaction[attack.attackerFactionId] += 1;
    }

    const aliveByFaction: [number, number] = [this.getAliveCount(0), this.getAliveCount(1)];

    for (const attack of attacks) {
      const attacker = this.state.players[attack.attackerId];
      if (!attacker || !attacker.isAlive) {
        continue;
      }

      const factionAttackers = attacksByFaction[attack.attackerFactionId];
      const aliveTeamSize = Math.max(1, aliveByFaction[attack.attackerFactionId]);
      const multiplier = densityMultiplier(factionAttackers, aliveTeamSize);
      const totalDamage = roundDamage(attack.attackPower * multiplier);

      const routing = this.routeDamage(
        attack.targetFactionId,
        totalDamage,
        attacker.id,
        pendingDeaths,
      );

      attacker.damageDealt += routing.damageToPlayers + routing.damageToFaction;

      if (attack.kind === "manual" && routing.hitExposedPlayers && routing.damageToPlayers > 0) {
        this.grantXp(attacker, MANUAL_LANDED_XP);
      }

      this.state.damageLog.push({
        tick: this.state.tick,
        kind: attack.kind,
        attackerId: attacker.id,
        attackerFactionId: attack.attackerFactionId,
        targetFactionId: attack.targetFactionId,
        rawDamage: attack.attackPower,
        multiplier: roundDamage(multiplier),
        totalDamage,
        damageToPlayers: roundDamage(routing.damageToPlayers),
        damageToFaction: roundDamage(routing.damageToFaction),
        hitExposedPlayers: routing.hitExposedPlayers,
      });
    }

    return pendingDeaths;
  }

  /**
   * Routes attack damage:
   * 1) newest exposed enemy players first
   * 2) overflow into target faction HP
   */
  private routeDamage(
    targetFactionId: FactionId,
    totalDamage: number,
    attackerId: string,
    pendingDeaths: Map<string, string>,
  ): { damageToPlayers: number; damageToFaction: number; hitExposedPlayers: boolean } {
    let remaining = totalDamage;
    let damageToPlayers = 0;
    let damageToFaction = 0;
    let hitExposedPlayers = false;

    const exposedTargets = this.getExposedTargets(targetFactionId);
    for (const target of exposedTargets) {
      if (remaining <= 0) {
        break;
      }
      if (!target.isAlive || target.hp <= 0) {
        continue;
      }

      const applied = Math.min(target.hp, remaining);
      target.hp = roundDamage(target.hp - applied);
      remaining = roundDamage(remaining - applied);
      damageToPlayers = roundDamage(damageToPlayers + applied);
      hitExposedPlayers = true;

      if (target.hp <= 0 && !pendingDeaths.has(target.id)) {
        pendingDeaths.set(target.id, attackerId);
      }
    }

    if (remaining > 0) {
      const targetFaction = this.getFaction(targetFactionId);
      const factionApplied = Math.min(targetFaction.factionHp, remaining);
      targetFaction.factionHp = roundDamage(targetFaction.factionHp - factionApplied);
      damageToFaction = roundDamage(damageToFaction + factionApplied);
    }

    return { damageToPlayers, damageToFaction, hitExposedPlayers };
  }

  /**
   * Applies pending deaths after all attack routing for the tick.
   * This prevents order bias across multiple simultaneous hits.
   */
  private finalizeDeaths(pendingDeaths: Map<string, string>): void {
    if (pendingDeaths.size === 0) {
      return;
    }

    for (const [victimId, killerId] of pendingDeaths.entries()) {
      const victim = this.state.players[victimId];
      if (!victim || !victim.isAlive || victim.hp > 0) {
        continue;
      }

      victim.hp = 0;
      victim.isAlive = false;
      victim.isExposed = false;
      victim.exposureRemaining = 0;
      victim.cooldownRemaining = 0;
      victim.pendingBurstCancelTick = null;
      victim.isCommittedToBurst = false;
      victim.burstCommitTimestamp = null;
      this.removeBurstCommit(victim.factionId, victim.id);

      const killer = this.state.players[killerId];
      if (killer && killer.id !== victim.id) {
        killer.kills += 1;
        this.grantXp(killer, KILL_XP);
      }

      this.emitEvent("player_died", `${victim.name} was eliminated`, {
        playerId: victim.id,
        factionId: victim.factionId,
        killerId,
      });
    }
  }

  /**
   * Evaluates burst threshold (>=70% of alive teammates committed).
   * When reached, burst locks immediately and is scheduled for next tick.
   */
  private checkBurstThresholds(): void {
    for (const faction of this.state.factions) {
      if (faction.burstLocked) {
        continue;
      }

      const alivePlayers = faction.players
        .map((playerId) => this.state.players[playerId])
        .filter((player): player is PlayerState => Boolean(player?.isAlive));

      const aliveCount = alivePlayers.length;
      if (aliveCount === 0) {
        continue;
      }

      const committedAlive = alivePlayers.filter((player) => player.isCommittedToBurst);
      const commitRatio = committedAlive.length / aliveCount;
      if (commitRatio < BURST_LOCK_RATIO) {
        continue;
      }

      faction.burstLocked = true;
      faction.burstScheduledTick = this.state.tick + 1;
      faction.burstLockedAliveCount = aliveCount;
      faction.burstCommits = committedAlive.map((player) => player.id);

      const exposureDuration = this.getBurstExposureDuration(faction.id);
      for (const player of committedAlive) {
        this.applyExposure(player, exposureDuration);
      }

      this.state.burstEvents.push({
        tick: this.state.tick,
        factionId: faction.id,
        stage: "locked",
        committedAtStage: committedAlive.length,
      });

      this.emitEvent("burst_locked", `Faction ${faction.id} burst locked`, {
        factionId: faction.id,
        committed: committedAlive.length,
        alive: aliveCount,
        scheduledTick: faction.burstScheduledTick,
      });
    }
  }

  /**
   * Finalizes pending burst cancel requests once their delay expires.
   * Cancels are ignored if lock already happened.
   */
  private processPendingBurstCancels(): void {
    for (const player of Object.values(this.state.players)) {
      if (player.pendingBurstCancelTick === null) {
        continue;
      }
      if (this.state.tick < player.pendingBurstCancelTick) {
        continue;
      }

      const faction = this.getFaction(player.factionId);
      if (!faction.burstLocked && player.isCommittedToBurst) {
        player.isCommittedToBurst = false;
        player.burstCommitTimestamp = null;
        this.removeBurstCommit(player.factionId, player.id);
        this.emitEvent("burst_cancelled", `${player.name} cancelled burst commitment`, {
          playerId: player.id,
          factionId: player.factionId,
        });
      }

      player.pendingBurstCancelTick = null;
    }
  }

  /** Decrements per-player manual attack cooldown timers. */
  private reduceCooldowns(): void {
    for (const player of Object.values(this.state.players)) {
      if (player.cooldownRemaining > 0) {
        player.cooldownRemaining -= 1;
      }
    }
  }

  /** Decrements exposure timers and clears exposure flag on expiry. */
  private reduceExposure(): void {
    for (const player of Object.values(this.state.players)) {
      if (player.exposureRemaining > 0) {
        player.exposureRemaining -= 1;
        if (player.exposureRemaining <= 0) {
          player.exposureRemaining = 0;
          player.isExposed = false;
        }
      }
    }
  }

  /** Retrieves exposed alive targets in newest-exposed-first order. */
  private getExposedTargets(targetFactionId: FactionId): PlayerState[] {
    const faction = this.getFaction(targetFactionId);
    return faction.players
      .map((playerId) => this.state.players[playerId])
      .filter((player): player is PlayerState => Boolean(player?.isAlive && player.isExposed))
      .sort(sortByExposureNewestFirst);
  }

  /** Ends match immediately if any faction HP reaches zero (or both for tie). */
  private checkImmediateHpWin(): void {
    const faction0Hp = this.state.factions[0].factionHp;
    const faction1Hp = this.state.factions[1].factionHp;

    if (faction0Hp <= 0 && faction1Hp <= 0) {
      this.endMatch("hp_depleted_tie", null);
      return;
    }
    if (faction0Hp <= 0) {
      this.endMatch("hp_depleted", 1);
      return;
    }
    if (faction1Hp <= 0) {
      this.endMatch("hp_depleted", 0);
    }
  }

  /**
   * Decrements phase timer and transitions across prep/combat/transition.
   * Also enforces round-limit winner resolution after round 5 combat.
   */
  private advancePhaseTimer(): void {
    if (this.state.phase === "waiting" || this.state.phase === "ended") {
      return;
    }

    if (this.state.phaseRemaining > 0) {
      this.state.phaseRemaining -= 1;
    }
    if (this.state.phaseRemaining > 0) {
      return;
    }

    if (this.state.phase === "prep") {
      this.setPhase("combat", COMBAT_PHASE_SECONDS, "combat_started", "Combat phase started");
      return;
    }

    if (this.state.phase === "combat") {
      if (this.state.round >= TOTAL_ROUNDS) {
        this.endByHigherFactionHp("round_limit");
        return;
      }

      this.resetRoundPlayerState();
      this.setPhase("transition", TRANSITION_SECONDS, "round_transition", "Round transition started");
      return;
    }

    if (this.state.phase === "transition") {
      this.state.round += 1;
      this.setPhase("prep", PREP_PHASE_SECONDS, "prep_started", "Prep phase started");
    }
  }

  /** Chooses winner by higher faction HP at round-limit completion. */
  private endByHigherFactionHp(reason: string): void {
    const faction0Hp = this.state.factions[0].factionHp;
    const faction1Hp = this.state.factions[1].factionHp;

    if (faction0Hp > faction1Hp) {
      this.endMatch(reason, 0);
      return;
    }
    if (faction1Hp > faction0Hp) {
      this.endMatch(reason, 1);
      return;
    }
    this.endMatch(`${reason}_tie`, null);
  }

  /** Finalizes terminal state and emits end-of-match event payload. */
  private endMatch(reason: string, winnerFactionId: FactionId | null): void {
    if (this.state.ended) {
      return;
    }
    this.state.ended = true;
    this.state.phase = "ended";
    this.state.phaseRemaining = 0;
    this.state.winnerFactionId = winnerFactionId;

    this.emitEvent("match_ended", "Match ended", {
      reason,
      winnerFactionId,
      finalFactionHp: [
        roundDamage(this.state.factions[0].factionHp),
        roundDamage(this.state.factions[1].factionHp),
      ],
    });
  }

  /** Initializes match state when lobby reaches 14 players. */
  private startMatch(): void {
    this.state.started = true;
    this.state.ended = false;
    this.state.phase = "prep";
    this.state.phaseRemaining = PREP_PHASE_SECONDS;
    this.state.round = 1;
    this.state.winnerFactionId = null;
    this.state.scheduledAttacks = [];
    this.state.damageLog = [];
    this.state.burstEvents = [];

    this.state.factions[0].factionHp = FACTION_HP_INITIAL;
    this.state.factions[1].factionHp = FACTION_HP_INITIAL;
    this.clearFactionBurstCommitState(0);
    this.clearFactionBurstCommitState(1);
    this.resetRoundPlayerState();

    this.emitEvent("match_started", "Match started", {
      round: this.state.round,
      phase: this.state.phase,
      phaseRemaining: this.state.phaseRemaining,
    });
  }

  /** Processes delayed lobby exits and applies rejoin cooldowns pre-match. */
  private processPendingLobbyLeaves(): void {
    const playerIds = Object.keys(this.state.players);
    for (const playerId of playerIds) {
      const player = this.state.players[playerId];
      if (!player || player.pendingLobbyLeaveTick === null) {
        continue;
      }
      if (this.state.tick < player.pendingLobbyLeaveTick) {
        continue;
      }

      this.removePlayerFromFaction(player.factionId, player.id);
      delete this.state.players[player.id];
      this.rejoinCooldownById.set(player.id, this.state.tick + LOBBY_REJOIN_COOLDOWN_SECONDS);

      this.emitEvent("player_left", `${player.name} left lobby`, {
        playerId: player.id,
        rejoinAvailableAtTick: this.state.tick + LOBBY_REJOIN_COOLDOWN_SECONDS,
      });
    }
  }

  /** Applies round reset rules while preserving level/xp/faction HP. */
  private resetRoundPlayerState(): void {
    for (const player of Object.values(this.state.players)) {
      player.hp = PLAYER_HP_INITIAL;
      player.cooldownRemaining = 0;
      player.isExposed = false;
      player.exposureRemaining = 0;
      player.isAlive = true;
      player.isCommittedToBurst = false;
      player.burstCommitTimestamp = null;
      player.pendingBurstCancelTick = null;
      player.pendingLobbyLeaveTick = null;
      player.attackPower = this.calculateAttackPower(player.level);
    }

    this.state.scheduledAttacks = [];
    this.clearFactionBurstCommitState(0);
    this.clearFactionBurstCommitState(1);
  }

  /** Builds per-faction view with burst commit visibility restricted to teammates. */
  private toPublicFactionView(
    factionId: FactionId,
    viewerFactionId: FactionId | null,
  ): PublicFactionView {
    const faction = this.getFaction(factionId);
    const aliveCount = this.getAliveCount(factionId);
    const burstCommitCount =
      viewerFactionId === factionId
        ? faction.players
            .map((playerId) => this.state.players[playerId])
            .filter((player): player is PlayerState => Boolean(player?.isAlive && player.isCommittedToBurst))
            .length
        : null;

    return {
      id: faction.id,
      factionHp: roundDamage(faction.factionHp),
      playerCount: faction.players.length,
      aliveCount,
      burstLocked: faction.burstLocked,
      burstCommitCount,
    };
  }

  /** Builds per-player public state with burst commitment redacted across factions. */
  private toPublicPlayerView(
    player: PlayerState,
    viewerFactionId: FactionId | null,
  ): PublicPlayerView {
    const sameFaction = viewerFactionId !== null && viewerFactionId === player.factionId;
    return {
      id: player.id,
      name: player.name,
      factionId: player.factionId,
      level: player.level,
      xp: player.xp,
      hp: roundDamage(player.hp),
      isAlive: player.isAlive,
      isExposed: player.isExposed,
      cooldownRemaining: player.cooldownRemaining,
      kills: player.kills,
      damageDealt: roundDamage(player.damageDealt),
      attackPower: player.attackPower,
      connected: player.connected,
      isCommittedToBurst: sameFaction ? player.isCommittedToBurst : null,
    };
  }

  /** Shared helper for phase transitions and corresponding event emission. */
  private setPhase(
    phase: MatchPhase,
    phaseRemaining: number,
    eventType: string,
    message: string,
  ): void {
    this.state.phase = phase;
    this.state.phaseRemaining = phaseRemaining;
    this.emitEvent(eventType, message, {
      phase,
      phaseRemaining,
      round: this.state.round,
    });
  }

  /** Creates a new player record with MVP default values. */
  private createPlayer(playerId: string, name: string, factionId: FactionId): PlayerState {
    return {
      id: playerId,
      name,
      factionId,
      level: 1,
      xp: 0,
      hp: PLAYER_HP_INITIAL,
      attackPower: BASE_ATTACK_POWER,
      cooldownRemaining: 0,
      isExposed: false,
      exposureRemaining: 0,
      isAlive: true,
      isCommittedToBurst: false,
      burstCommitTimestamp: null,
      pendingBurstCancelTick: null,
      pendingLobbyLeaveTick: null,
      exposureAppliedTick: -1,
      kills: 0,
      damageDealt: 0,
      connected: true,
    };
  }

  /** Picks the faction with fewer players to keep lobby balanced. */
  private pickFactionForJoin(): FactionId {
    const faction0Count = this.state.factions[0].players.length;
    const faction1Count = this.state.factions[1].players.length;
    return faction0Count <= faction1Count ? 0 : 1;
  }

  /** Direct faction accessor for tuple-backed faction state. */
  private getFaction(factionId: FactionId): FactionState {
    return this.state.factions[factionId];
  }

  /** Counts alive players for a faction at the current tick. */
  private getAliveCount(factionId: FactionId): number {
    const faction = this.getFaction(factionId);
    return faction.players
      .map((playerId) => this.state.players[playerId])
      .filter((player): player is PlayerState => Boolean(player?.isAlive)).length;
  }

  /** Counts total players in the lobby/match. */
  private getPlayerCount(): number {
    return Object.keys(this.state.players).length;
  }

  /** Removes player references from faction arrays and burst commit lists. */
  private removePlayerFromFaction(factionId: FactionId, playerId: string): void {
    const faction = this.getFaction(factionId);
    faction.players = faction.players.filter((id) => id !== playerId);
    this.removeBurstCommit(factionId, playerId);
  }

  /** Clears all burst flags and commitments for a faction and its players. */
  private clearFactionBurstCommitState(factionId: FactionId): void {
    const faction = this.getFaction(factionId);
    for (const playerId of faction.players) {
      const player = this.state.players[playerId];
      if (!player) {
        continue;
      }
      player.isCommittedToBurst = false;
      player.burstCommitTimestamp = null;
      player.pendingBurstCancelTick = null;
    }
    faction.burstCommits = [];
    faction.burstLocked = false;
    faction.burstScheduledTick = null;
    faction.burstLockedAliveCount = null;
  }

  /** Removes one player id from a faction burst commitment list. */
  private removeBurstCommit(factionId: FactionId, playerId: string): void {
    const faction = this.getFaction(factionId);
    faction.burstCommits = faction.burstCommits.filter((id) => id !== playerId);
  }

  /** Applies exposure duration and updates exposure recency marker. */
  private applyExposure(player: PlayerState, durationSeconds: number): void {
    player.isExposed = true;
    player.exposureRemaining = Math.max(player.exposureRemaining, durationSeconds);
    player.exposureAppliedTick = this.state.tick;
  }

  /**
   * Returns additional exposure pre/post seconds based on faction HP bands:
   * 100-75% => +0, 74-50% => +1, 49-0% => +2.
   */
  private getExposurePenaltyModifierSeconds(factionId: FactionId): number {
    const hpRatio = this.getFaction(factionId).factionHp / FACTION_HP_INITIAL;
    if (hpRatio <= 0.49) {
      return 2;
    }
    if (hpRatio <= 0.74) {
      return 1;
    }
    return 0;
  }

  /** Manual exposure base + HP-band modifier (before/after contributes *2). */
  private getManualExposureDuration(factionId: FactionId): number {
    return MANUAL_EXPOSURE_BASE_SECONDS + this.getExposurePenaltyModifierSeconds(factionId) * 2;
  }

  /** Burst exposure base + HP-band modifier (before/after contributes *2). */
  private getBurstExposureDuration(factionId: FactionId): number {
    return BURST_EXPOSURE_BASE_SECONDS + this.getExposurePenaltyModifierSeconds(factionId) * 2;
  }

  /** Grants XP and performs cumulative threshold level-ups to level cap. */
  private grantXp(player: PlayerState, amount: number): void {
    if (amount <= 0) {
      return;
    }

    player.xp += amount;
    while (player.level < MAX_LEVEL) {
      const nextLevel = player.level + 1;
      const threshold = XP_THRESHOLDS[nextLevel - 1];
      if (threshold === undefined || player.xp < threshold) {
        break;
      }
      player.level = nextLevel;
      player.attackPower = this.calculateAttackPower(player.level);
      this.emitEvent("level_up", `${player.name} reached level ${player.level}`, {
        playerId: player.id,
        level: player.level,
        attackPower: player.attackPower,
      });
    }
  }

  /** Computes attack power from level using linear scaling. */
  private calculateAttackPower(level: number): number {
    return BASE_ATTACK_POWER + (level - 1) * ATTACK_POWER_PER_LEVEL;
  }

  /** Appends one transient event to the current tick event buffer. */
  private emitEvent(type: string, message: string, payload: Record<string, unknown>): void {
    this.state.events.push({
      tick: this.state.tick,
      type,
      message,
      payload,
    });
  }
}
