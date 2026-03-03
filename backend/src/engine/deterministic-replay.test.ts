import test from "node:test";
import assert from "node:assert/strict";
import type { ActionResult } from "./types.js";
import type { WarEngine } from "./warEngine.js";
import { createEngineFixture } from "../test-utils/engineFixture.js";

type ScriptedAction = {
  tickOffset: number;
  description: string;
  run: (engine: WarEngine) => ActionResult;
};

type ReplayTrace = {
  timeline: Array<{
    tick: number;
    snapshot: ReturnType<WarEngine["getSnapshotForPlayer"]>;
    outcome: ReturnType<WarEngine["getOutcomeSummary"]>;
  }>;
  finalSnapshot: ReturnType<WarEngine["getSnapshotForPlayer"]>;
  finalOutcome: ReturnType<WarEngine["getOutcomeSummary"]>;
};

function createDeterministicActionScript(): ScriptedAction[] {
  return [
    { tickOffset: 1, description: "p1 manual", run: (engine) => engine.queueManualAttack("p1") },
    { tickOffset: 1, description: "p2 manual", run: (engine) => engine.queueManualAttack("p2") },
    { tickOffset: 2, description: "p3 manual", run: (engine) => engine.queueManualAttack("p3") },
    { tickOffset: 2, description: "p4 manual", run: (engine) => engine.queueManualAttack("p4") },
    {
      tickOffset: 3,
      description: "Faction 0 burst commit p1",
      run: (engine) => engine.setBurstCommit("p1", true),
    },
    {
      tickOffset: 3,
      description: "Faction 0 burst commit p3",
      run: (engine) => engine.setBurstCommit("p3", true),
    },
    {
      tickOffset: 3,
      description: "Faction 0 burst commit p5",
      run: (engine) => engine.setBurstCommit("p5", true),
    },
    {
      tickOffset: 3,
      description: "Faction 0 burst commit p7",
      run: (engine) => engine.setBurstCommit("p7", true),
    },
    {
      tickOffset: 3,
      description: "Faction 0 burst commit p9",
      run: (engine) => engine.setBurstCommit("p9", true),
    },
    {
      tickOffset: 4,
      description: "Faction 1 burst commit p2",
      run: (engine) => engine.setBurstCommit("p2", true),
    },
    {
      tickOffset: 4,
      description: "Faction 1 burst commit p4",
      run: (engine) => engine.setBurstCommit("p4", true),
    },
    {
      tickOffset: 4,
      description: "Faction 1 burst commit p6",
      run: (engine) => engine.setBurstCommit("p6", true),
    },
    {
      tickOffset: 4,
      description: "Faction 1 burst commit p8",
      run: (engine) => engine.setBurstCommit("p8", true),
    },
    {
      tickOffset: 4,
      description: "Faction 1 burst commit p10",
      run: (engine) => engine.setBurstCommit("p10", true),
    },
    {
      tickOffset: 6,
      description: "p11 manual",
      run: (engine) => engine.queueManualAttack("p11"),
    },
    {
      tickOffset: 8,
      description: "p12 manual",
      run: (engine) => engine.queueManualAttack("p12"),
    },
  ];
}

function runReplay(script: ScriptedAction[], ticksToRun: number): ReplayTrace {
  const engine = createEngineFixture();
  const timeline: ReplayTrace["timeline"] = [];

  for (let tickOffset = 1; tickOffset <= ticksToRun; tickOffset += 1) {
    for (const action of script) {
      if (action.tickOffset !== tickOffset) {
        continue;
      }

      const result = action.run(engine);
      assert.equal(result.ok, true, `${action.description}: ${result.error}`);
    }

    engine.tick();
    timeline.push({
      tick: engine.getCurrentTick(),
      snapshot: engine.getSnapshotForPlayer(null),
      outcome: engine.getOutcomeSummary(),
    });
  }

  return {
    timeline,
    finalSnapshot: engine.getSnapshotForPlayer(null),
    finalOutcome: engine.getOutcomeSummary(),
  };
}

test("WarEngine deterministic replay: same scripted actions produce same snapshot and logs", () => {
  const script = createDeterministicActionScript();

  const runA = runReplay(script, 12);
  const runB = runReplay(script, 12);

  assert.deepEqual(runA.timeline, runB.timeline);
  assert.deepEqual(runA.finalSnapshot, runB.finalSnapshot);
  assert.deepEqual(runA.finalOutcome, runB.finalOutcome);
  assert.ok(runA.finalOutcome.damageLog.length > 0);
  assert.ok(runA.finalOutcome.burstEvents.length > 0);
});
