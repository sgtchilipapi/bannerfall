import test from "node:test";
import assert from "node:assert/strict";
import { createEngineFixture } from "../test-utils/engineFixture.js";
import type { PublicSnapshot } from "./types.js";

type AttackResolvedPayload = {
  eventId: string;
  tick: number;
  kind: "manual" | "burst";
  attackerId: string;
  attackerFactionId: 0 | 1;
  targetType: "player" | "faction";
  targetPlayerId: string | null;
  targetFactionId: 0 | 1;
  damage: number;
  attackSequenceInTick: number;
  segmentSequenceInAttack: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function toFactionId(value: unknown): 0 | 1 | null {
  return value === 0 || value === 1 ? value : null;
}

function parseAttackResolvedEvents(snapshot: PublicSnapshot): AttackResolvedPayload[] {
  const parsed: AttackResolvedPayload[] = [];

  for (const event of snapshot.events) {
    if (event.type !== "attack_resolved" || !isRecord(event.payload)) {
      continue;
    }

    const payload = event.payload;
    const attackerFactionId = toFactionId(payload.attackerFactionId);
    const targetFactionId = toFactionId(payload.targetFactionId);
    const kind = payload.kind;
    const targetType = payload.targetType;
    const targetPlayerIdRaw = payload.targetPlayerId;

    if (
      typeof payload.eventId !== "string" ||
      typeof payload.tick !== "number" ||
      (kind !== "manual" && kind !== "burst") ||
      typeof payload.attackerId !== "string" ||
      attackerFactionId === null ||
      (targetType !== "player" && targetType !== "faction") ||
      !(typeof targetPlayerIdRaw === "string" || targetPlayerIdRaw === null) ||
      targetFactionId === null ||
      typeof payload.damage !== "number" ||
      typeof payload.attackSequenceInTick !== "number" ||
      typeof payload.segmentSequenceInAttack !== "number"
    ) {
      continue;
    }

    parsed.push({
      eventId: payload.eventId,
      tick: payload.tick,
      kind,
      attackerId: payload.attackerId,
      attackerFactionId,
      targetType,
      targetPlayerId: targetPlayerIdRaw,
      targetFactionId,
      damage: payload.damage,
      attackSequenceInTick: payload.attackSequenceInTick,
      segmentSequenceInAttack: payload.segmentSequenceInAttack,
    });
  }

  return parsed;
}

function getFactionPlayerIds(snapshot: PublicSnapshot, factionId: 0 | 1): string[] {
  return snapshot.players
    .filter((player) => player.factionId === factionId)
    .map((player) => player.id);
}

test("WarEngine attack_resolved: manual attack targets newest exposed enemy when available", () => {
  const engine = createEngineFixture();
  const initialSnapshot = engine.getSnapshotForPlayer(null);
  const factionZero = getFactionPlayerIds(initialSnapshot, 0);
  const factionOne = getFactionPlayerIds(initialSnapshot, 1);

  const attackerId = factionZero[0]!;
  const exposedTargetId = factionOne[0]!;

  assert.equal(engine.queueManualAttack(exposedTargetId).ok, true);
  engine.tick();

  assert.equal(engine.queueManualAttack(attackerId).ok, true);
  engine.tick();

  const snapshot = engine.getSnapshotForPlayer(null);
  const resolvedEvents = parseAttackResolvedEvents(snapshot);
  assert.equal(
    resolvedEvents.some(
      (event) =>
        event.kind === "manual" &&
        event.attackerId === attackerId &&
        event.targetType === "player" &&
        event.targetPlayerId === exposedTargetId,
    ),
    true,
  );
});

test("WarEngine attack_resolved: manual attack falls back to faction target when no exposed enemy exists", () => {
  const engine = createEngineFixture();
  const initialSnapshot = engine.getSnapshotForPlayer(null);
  const factionZero = getFactionPlayerIds(initialSnapshot, 0);

  const attackerId = factionZero[0]!;
  assert.equal(engine.queueManualAttack(attackerId).ok, true);
  engine.tick();

  const snapshot = engine.getSnapshotForPlayer(null);
  const resolvedEvents = parseAttackResolvedEvents(snapshot).filter(
    (event) => event.kind === "manual" && event.attackerId === attackerId,
  );

  assert.ok(resolvedEvents.length > 0);
  assert.equal(resolvedEvents[0]!.targetType, "faction");
  assert.equal(resolvedEvents[0]!.targetPlayerId, null);
  assert.equal(resolvedEvents[0]!.targetFactionId, 1);
});

test("WarEngine attack_resolved: overflow emits ordered player-then-faction segments for one attack", () => {
  const engine = createEngineFixture();
  const initialSnapshot = engine.getSnapshotForPlayer(null);
  const factionZero = getFactionPlayerIds(initialSnapshot, 0);
  const factionOne = getFactionPlayerIds(initialSnapshot, 1);

  const targetId = factionOne[0]!;
  const setupAId = factionZero[1]!;
  const setupBId = factionZero[2]!;
  const primaryAttackerId = factionZero[3]!;
  const supportId = factionZero[4]!;

  assert.equal(engine.queueManualAttack(targetId).ok, true);
  assert.equal(engine.queueManualAttack(setupAId).ok, true);
  assert.equal(engine.queueManualAttack(setupBId).ok, true);
  engine.tick();

  assert.equal(engine.queueManualAttack(primaryAttackerId).ok, true);
  assert.equal(engine.queueManualAttack(supportId).ok, true);
  engine.tick();

  const snapshot = engine.getSnapshotForPlayer(null);
  const primarySegments = parseAttackResolvedEvents(snapshot)
    .filter((event) => event.attackerId === primaryAttackerId && event.kind === "manual")
    .sort((a, b) => a.segmentSequenceInAttack - b.segmentSequenceInAttack);

  assert.ok(primarySegments.length >= 2);
  assert.equal(primarySegments[0]!.targetType, "player");
  assert.equal(primarySegments[0]!.targetPlayerId, targetId);
  assert.equal(primarySegments[1]!.targetType, "faction");
  assert.equal(primarySegments[1]!.targetPlayerId, null);
  assert.equal(primarySegments[1]!.targetFactionId, 1);
  assert.equal(
    primarySegments[0]!.eventId,
    `${snapshot.tick}:${primarySegments[0]!.attackSequenceInTick}:1`,
  );
  assert.equal(
    primarySegments[1]!.eventId,
    `${snapshot.tick}:${primarySegments[1]!.attackSequenceInTick}:2`,
  );
});

test("WarEngine attack_resolved: burst execution emits exact target segments", () => {
  const engine = createEngineFixture();
  const initialSnapshot = engine.getSnapshotForPlayer(null);
  const factionZero = getFactionPlayerIds(initialSnapshot, 0);
  const factionOne = getFactionPlayerIds(initialSnapshot, 1);

  const exposedTargetId = factionOne[0]!;
  assert.equal(engine.queueManualAttack(exposedTargetId).ok, true);

  for (const playerId of factionZero.slice(0, 5)) {
    assert.equal(engine.setBurstCommit(playerId, true).ok, true);
  }
  engine.tick();
  engine.tick();

  const snapshot = engine.getSnapshotForPlayer(null);
  const burstSegments = parseAttackResolvedEvents(snapshot).filter((event) => event.kind === "burst");
  assert.ok(burstSegments.length > 0);
  assert.equal(
    burstSegments.some(
      (event) =>
        event.targetFactionId === 1 &&
        (event.targetType === "faction" || event.targetPlayerId === exposedTargetId),
    ),
    true,
  );
  assert.equal(new Set(burstSegments.map((event) => event.eventId)).size, burstSegments.length);
});
