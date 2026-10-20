# Repository Guidelines

Cosmo Automations — a node-graph workflow automation simulation for CodeSignal
Learn & Hire.

This repository is derived from
[`learn_bespoke-template`](https://github.com/CodeSignal/learn_bespoke-template).
It keeps the
template's contracts (below) but replaces the vanilla-JS client with React +
`@xyflow/react` and adds a server-side execution engine — so the template's own
conventions only partly apply. **This file wins where they disagree.**
`BESPOKE-TEMPLATE.md` is retained as reference for the design system and the
platform contracts.

Read [`README.md`](./README.md) first, then [`docs/authoring.md`](docs/authoring.md)
for the scenario format and [`docs/extending.md`](docs/extending.md) for changes.

## Inherited contracts — do not break these

The platform depends on each of these:

| Contract | Where |
|---|---|
| `npm run build` → `dist/` | `vite.config.js` |
| `IS_PRODUCTION=true npm run start:prod` serves `dist/` on port 3000 | `server.js` |
| Design system as a git submodule at `client/design-system` | `.gitmodules` |
| Release tarball published by CI and fetched by `setup.sh` — never `npm install` in a session | `.github/workflows/build-release.yml` |
| Grading is whatever `run_solution.sh` prints to STDOUT | `.codesignal/`, `parse_automation_solution.js` |

Deliberate divergences from the template, each for a stated reason:

- **Binds `127.0.0.1` in development** and all interfaces only in a session
  (`IS_PRODUCTION=true`), where the preview reaches port 3000 from outside.
- **The tarball ships far more** than the template's four paths: `engine/`,
  `live/`, `grading/`, `shared/`, `scenarios/` and the parse script are all required at
  runtime, and the template's list would ship a release that cannot boot.
  `test/release.test.js` enforces the list against the real `require()` closure.
- **`package.json` declares `Elastic-2.0`**, matching the `LICENSE` file. The
  template says MIT while shipping Elastic 2.0; that contradiction was not worth
  inheriting.

## Layout

```
engine/           scheduler, expression evaluator, QuickJS sandbox, nodes, mock transport
grading/          assertion DSL, STDOUT format
shared/           modules used by BOTH engine and client (summaries, node docs, mode)
client/           React app: shell/, canvas/, detail/, help/, ui/, theme/, lib/
scenarios/<name>/ scenario.json, reference_solution.json, variants/ (grading fixture)
live/             the optional live-answer client (outside engine/, injected by the server)
scripts/          validator, grading experiment, demo rehearsals, fixture recorder, release verifier
docs/             authoring, agent-node and activity-log guides
test/             headless — node:test, no browser
```

## Conventions

- **File names** kebab-case; React components PascalCase (`NodeCard.jsx`).
- **CSS: semantic design system tokens only.** Never a literal colour, never a
  hardcoded spacing value. Light and dark mode must both work with no theme
  toggle — check both.
- `.label-*` typography classes are **uppercased** by the design system. Use them
  for micro-labels only, never for anything sentence-shaped. This has caused four
  separate visual bugs.
- **Engine code is CommonJS**, the client is ESM. `shared/` is ESM and is
  `require()`d by the engine (supported on Node 22.12+), so anything both sides
  need has exactly one copy.
- **Never add a network import under `engine/`.** A test enforces it: all I/O goes
  through the mock resolver, so real egress is impossible by construction rather
  than by care.

## Before you commit

```bash
npm test              # everything, headless
npm run validate      # every scenario authored correctly and solvable
npm run experiment    # every grading variant still classified correctly
npm run rehearse      # the eu-orders demo workflow must still behave
```

If you touched the release surface, `npm run release:local` builds a real tarball
and boots it end to end.

## Two rules specific to this simulation

**Grading must be deterministic.** Two runs of the same workflow have to produce
byte-identical output, or a grade is not reproducible. That is why `$now` is a
fixed clock, and why `Date` and `Math.random` are pinned inside the sandbox. Any
change that lets real time or real randomness into a run is a bug, not a quirk.

**A false negative is worse than a false positive.** A candidate who was right and
got rejected escalates, and is entitled to. When you add anything to the STDOUT
report, ask whether a correct solution could be misread as broken — that question
is what produced the branch-node port disclosure and the fan-in/fan-out
annotations.

## Known limitations

Security and integrity properties that once had gaps are pinned by
`test/security-regressions.test.js`. A change that reopens one fails there, with
the property named.
