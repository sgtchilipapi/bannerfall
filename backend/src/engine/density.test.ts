import test from "node:test";
import assert from "node:assert/strict";
import { DENSITY_ALPHA, DENSITY_CAP, DENSITY_CAP_RATIO } from "./constants.js";
import { densityMultiplier } from "./density.js";

test("densityMultiplier: returns baseline 1 for invalid inputs", () => {
  assert.equal(densityMultiplier(0, 7), 1);
  assert.equal(densityMultiplier(1, 0), 1);
  assert.equal(densityMultiplier(-1, 7), 1);
});

test("densityMultiplier: returns cap at or above cap ratio", () => {
  assert.equal(densityMultiplier(5, 7), DENSITY_CAP);
  assert.equal(densityMultiplier(6, 7), DENSITY_CAP);
  assert.equal(densityMultiplier(7, 7), DENSITY_CAP);
});

test("densityMultiplier: uses expected formula below cap ratio", () => {
  const attackers = 3;
  const alive = 7;
  const ratio = attackers / alive;
  const expected = 1 + Math.pow(ratio / DENSITY_CAP_RATIO, DENSITY_ALPHA) * (DENSITY_CAP - 1);
  assert.ok(Math.abs(densityMultiplier(attackers, alive) - expected) < 1e-10);
});

test("densityMultiplier: monotonic with rising attackers at fixed team size", () => {
  const alive = 7;
  const values = [1, 2, 3, 4, 5, 6, 7].map((a) => densityMultiplier(a, alive));
  for (let index = 1; index < values.length; index += 1) {
    const current = values[index];
    const previous = values[index - 1];
    assert.ok(current !== undefined && previous !== undefined && current >= previous);
  }
});

test("densityMultiplier: never exceeds cap", () => {
  for (let attackers = 1; attackers <= 20; attackers += 1) {
    assert.ok(densityMultiplier(attackers, 7) <= DENSITY_CAP);
  }
});
