# Engine Test Plan Implementation Status

Source plan: `engine-test-plan.md`.

## Checklist

- [x] **Tooling script baseline exists (`test`, `test:watch`, `test:coverage`)**  
  Status: **Partial** — scripts are present, but `test:coverage` is a placeholder that exits with code 1.
- [ ] **Vitest configured and used for backend tests**  
  Status: **Not implemented** — backend tests use Node's built-in test runner (`node:test`) and no Vitest configuration exists.
- [x] **`density` unit suite**  
  Status: **Implemented** — cap, monotonicity, and invalid-input coverage are present in `density.test.ts`.
- [x] **`lobby` suite**  
  Status: **Implemented** — includes auto-balance, auto-start at max players, delayed leave/rejoin cooldown, and post-start join rejection.
- [x] **`phase` suite**  
  Status: **Implemented** — verifies prep/combat/transition timing, round increment, and round-limit end-state.
- [x] **`manual attack` suite**  
  Status: **Implemented** — covers combat-phase action gating, next-tick scheduling, cooldown enforcement, exposure-side effects, and faction-HP fallback when no targets are exposed.
- [x] **`burst` suite**  
  Status: **Implemented** — covers delayed cancel timing, 70% lock threshold behavior, lock-time cancellation rejection, and next-tick execution/reset semantics.
- [ ] **`damage routing` suite**  
  Status: **Not implemented**.
- [ ] **`xp/level` suite**  
  Status: **Not implemented**.
- [ ] **`death/reset` suite**  
  Status: **Not implemented**.
- [ ] **`win conditions` suite**  
  Status: **Not implemented**.
- [ ] **`snapshot visibility` suite**  
  Status: **Not implemented**.
- [ ] **`server protocol` integration suite**  
  Status: **Not implemented**.
- [ ] **Server refactor for testability (`createServer()` / startup separation)**  
  Status: **Not implemented** — `server.ts` currently instantiates `WarEngine`, `WebSocketServer`, and `setInterval` at module scope.
- [ ] **Deliverables: reusable test helpers**  
  Status: **Not implemented**.
- [ ] **Deliverables: CI-ready coverage target (`>=80%` on `engine/*`)**  
  Status: **Not implemented**.
- [ ] **Definition of done: all high-priority suites green, deterministic replay test, no flakes, one-command full run**  
  Status: **Not achieved**.

## Summary

Current implementation is **incomplete** relative to the test plan.

- Implemented plan suites: **5 / 11** (`density`, `lobby`, `phase`, `manual attack`, `burst`).
- Core blockers:
  - Missing 7 planned suites.
  - No server factory refactor for integration-test isolation.
  - Coverage command/target not configured.
  - Plan's Vitest tooling expectation not met.

Because the plan is not complete, full completion-gate test execution was **not triggered** in this status pass.
