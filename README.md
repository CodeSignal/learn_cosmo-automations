# Cosmo Automations

A node-graph workflow automation simulation for CodeSignal Learn & Hire. Learners
build workflows on a canvas — triggers, HTTP calls, transforms, branching, loops,
integrations, AI agents — and a deterministic engine runs them against mocked
services. Grading re-runs the submitted workflow and checks it against the
task's assertions.

## Quick start

```bash
npm install
npm run start:dev    # canvas at http://127.0.0.1:3000
npm test             # headless test suite
```

If port 3000 is taken: `VITE_PORT=3100 API_PORT=3101 npm run start:dev`.

| Command | What it does |
|---|---|
| `npm run validate [path]` | Check that scenarios are authored correctly and solvable |
| `npm run experiment` | Grade the correct and wrong variants of the bundled scenarios |
| `npm run grade` | Print the grading report for the current session |
| `npm run demo <scenario>` | Stage a bundled scenario as if a session had delivered it |
| `npm run rehearse`, `npm run rehearse:showcase` | Walk the demo workflows and check their results |
| `npm run record` | Record AI fixtures from a real model (dry run by default) |
| `npm run release:local` | Build a release tarball and boot it end to end |

## In a session

A base task downloads the latest release and starts the server on port 3000 —
see [`.codesignal/`](.codesignal/README.md). Everything lives in one directory,
`cosmo-automations/`:

| File | Written by | Purpose |
|---|---|---|
| `config.json` | the task | The scenario: palette, credential types, starting workflow, mock APIs, AI fixtures, assertions |
| `solution.json` | the simulation | The learner's workflow and the credentials they created |
| `execution.json` | the simulation | The last full run |
| `activity.log` | the simulation | What the learner did, one JSON event per line — see [`docs/activity-log.md`](docs/activity-log.md) |

`run_solution.sh` prints the grading report, which the grader reads.

## Grading

`parse_automation_solution.js` re-runs the workflow and prints:

```
## ASSERTIONS
RESULT: FAIL (6 PASS, 2 FAIL)
PASS  fetches-orders
FAIL  keeps-three-orders      expected in exactly 3, got Aggregate Totals=4

## TRACE SIGNATURE
VALID
```

Approve only when `RESULT` says `PASS`, no line begins with `FAIL`, and the
signature is `VALID`. The verdict always comes from a fresh, deterministic run, so
editing the saved files cannot change it. Hire tasks can keep their assertions in
a hidden `assertions.json` that exists only at Submit, and set `grading.private`
to withhold expected values from FAIL lines.

[`grading/score.js`](grading/score.js) turns the same verdict into a score with
one point per assertion and a Markdown report, always as two files
(`score.json` and `report.md`, or wherever `--score-path` and `--report-path` say).
A Hire task runs it on Submit through the platform's command grader; see
[`.codesignal/README.md`](.codesignal/README.md#scoring-on-submit).

## Releases

Every merge to `main` that passes the tests and the grading experiment is packed
(`npm run pack`: one minified file per entry point, no `node_modules`) and
published as a **pre-release**, `vN`. It also moves the floating `prerelease`
release, so there are two download URLs:

| | URL |
|---|---|
| Production | `https://github.com/CodeSignal/learn_cosmo-automations/releases/latest/download/release.tar.gz` |
| Staging | `https://github.com/CodeSignal/learn_cosmo-automations/releases/download/prerelease/release.tar.gz` |

The base task's `setup.sh` and `grader/grader.sh` pick between them with
`$APP_ENVIRONMENT`, so a build reaches staging first. Once it is tested there,
promote it to production by making it the latest release:

```sh
gh release edit vN --prerelease=false --latest
```

## Documentation

| | |
|---|---|
| [`docs/authoring.md`](docs/authoring.md) | Writing a task: nodes, expressions, credentials, mock APIs, assertions |
| [`scenario.example.jsonc`](scenario.example.jsonc) | Annotated scenario template |
| [`docs/agent-nodes.md`](docs/agent-nodes.md) | AI agents, subagents, approvals, recorded and live answers |
| [`docs/extending.md`](docs/extending.md) | Changing the simulation itself |
| [`docs/activity-log.md`](docs/activity-log.md) | The activity log events |

## Licence

[Elastic License 2.0](LICENSE).
