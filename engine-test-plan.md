**Backend Automated Test Plan (MVP-first)**

1. **Test objective**
- Lock down deterministic MVP gameplay behavior in [warEngine.ts](C:/Users/Paps/projects/bannerfall/backend/src/engine/warEngine.ts), websocket behavior in [server.ts](C:/Users/Paps/projects/bannerfall/backend/src/server.ts), and formula correctness in [density.ts](C:/Users/Paps/projects/bannerfall/backend/src/engine/density.ts).

2. **Tooling and setup**
- Use `vitest` for TypeScript unit/integration tests.
- Add scripts: `test`, `test:watch`, `test:coverage` in [backend/package.json](C:/Users/Paps/projects/bannerfall/backend/package.json).
- Add test config and shared fixtures/helpers.

3. **Test suites (priority order)**
1. `density` unit tests for cap, monotonicity, and edge inputs.
2. `lobby` tests for auto-balance, 14-player auto-start, leave delay, rejoin cooldown, join rejection post-start.
3. `phase` tests for prep/combat/transition timing and round progression.
4. `manual attack` tests for action gating, next-tick scheduling, cooldown, exposure application, faction HP fallback.
5. `burst` tests for commit/cancel timing, 70% lock threshold, lock immutability, next-tick execution.
6. `damage routing` tests for newest-exposed-first, overflow cascade, and density-scaled totals.
7. `xp/level` tests for +5 manual-landed XP, +2 kill XP, threshold leveling, AP scaling to max level.
8. `death/reset` tests for death handling, action blocking while dead, per-round resets with level/faction HP persistence.
9. `win conditions` tests for immediate faction HP depletion and round-5 HP comparison including tie behavior.
10. `snapshot visibility` tests ensuring burst commit counts are visible only to teammates.
11. `server protocol` integration tests for connect/join/state/action/ack/error and malformed message handling.

4. **Required refactor for testability**
- Move boot side effects out of [server.ts](C:/Users/Paps/projects/bannerfall/backend/src/server.ts) into a factory (example: `createServer()`), and keep `server.ts` as startup-only entrypoint. This enables clean integration tests without global port/timer conflicts.

5. **Deliverables**
- Test files under `backend/src/**/*.test.ts`.
- Reusable test helpers for creating players/matches and advancing ticks.
- CI-ready command: `npm run test` and `npm run test:coverage`.
- Coverage target for MVP lock-in: `>=80%` statements/functions on `engine/*`.

6. **Definition of done**
- All high-priority suites green locally.
- Deterministic replay test passes (same scripted actions => same final snapshot/logs).
- No known flaky tests.
- One command runs full backend tests successfully.