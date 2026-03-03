import { PREP_PHASE_SECONDS } from "../engine/constants.js";
import type { WarEngine } from "../engine/warEngine.js";

export function advanceTicks(engine: WarEngine, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) {
    engine.tick();
  }
}

export function advanceToCombat(engine: WarEngine): void {
  advanceTicks(engine, PREP_PHASE_SECONDS);
}
