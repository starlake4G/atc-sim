# AGENTS.md

## Repo layout

- Repo root is a wrapper; the actual app is the single npm project in `atc-sim/`. Run all npm commands from `atc-sim/`.
- Layering (hard rule): `atc-sim/src/sim/` is pure deterministic simulation (fixed 10 Hz step, `TICK = 0.1`) and must never import `three`, `react`, `src/ui`, or `src/views`. Nothing lints this — enforce it by review. `src/data/` = airports/levels as data, `src/views/` = three.js scene, `src/ui/` = React, `atc-sim/scripts/` = headless regression tests.
- Live play, fast-forward, and replay all run through `World.step()` (`src/sim/world.ts`); keep simulation deterministic (no wall-clock, randomness only via `Rng`).
- `docs/` = Chinese design docs; `refs/`, `.workbuddy/`, `atc-sim/.tmp/`, `atc-sim/dist/` are gitignored.

## Commands (cwd: `atc-sim/`)

- `npm run dev` — Vite dev server at http://localhost:5173 (also binds `0.0.0.0` for LAN devices).
- `npm run accept` — the verification gate (what CI runs): typecheck + all logic suites. Run this before declaring work done.
- Single logic suite (headless, no browser): `npm run sim:test`, `gameplay:test`, `planning:test`, `challenge:test`, `edge:test`, `experience:test`, `operations:test`, `decisions:test`, `control:test`. Each is a `tsx` script in `scripts/`; to add a test, copy the helpers/pattern from the suite you're extending. Suites exit non-zero on failure.
- `npm run typecheck` — `tsc --noEmit` with `strict` + `noUnusedLocals`.
- Browser E2E: start `npm run dev` in one terminal, then `npm run ui:test` (variants: `planning:ui:test`, `experience:ui:test`, `operations:ui:test`, `decisions:ui:test`, `control:ui:test`, `visual:ui:test`). Needs local Chrome/Edge (`CHROME_PATH` env overrides the path); takes minutes; screenshots go to `.tmp/`. Pass a base URL to point elsewhere: `npm run ui:test -- http://localhost:5174`.
- `npm run build` = typecheck + `vite build`. CI (`.github/workflows/deploy.yml`, push to `main`) runs `npm run accept` then `vite build --base=/atc-sim/` for GitHub Pages — local builds don't need the `--base` flag.
- There is no linter or formatter; typecheck + test scripts are the entire gate.

## Conventions

- Comments, docs, test names, and commit messages are in Chinese; keep new prose Chinese. Commit style: conventional prefix (`feat:` / `fix:` / `docs:` / `chore:` / `polish:`) + Chinese summary.
- Test assertion counts drift with every change; don't trust counts cited in READMEs or CI comments — the `accept` script in `atc-sim/package.json` is the source of truth for which suites exist.
- Adding airports or levels is data-only: follow `docs/CONTENT-GUIDE.md` (coordinate system, required fields, taxi-graph constraints). Startup validation in `src/sim/airport.ts` `buildAirport()` throws with specific messages on invalid data — read them, don't work around them.
- Debug URL params for manual verification: `?level=<id>&fast=<seconds>&bot=1&lite=1&view=tower&mode=standard&safety=guarded&seed=<str>` — see `docs/CONTENT-GUIDE.md` §3 and `atc-sim/README.md`. `bot=1` only auto-controls during fast-forward; `mode=standard` disables assisted taxi; `lite=1` disables reflections/shadows for fast headless rendering.
- `docs/ATC-CODE-REVIEW-*.md` files record past review findings; check them before touching sim physics, runway logic, or the radio/readback system.
