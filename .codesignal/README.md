# Session scripts

`setup.sh` and `run_solution.sh` are the two scripts a CodeSignal base task runs
for this simulation, and `grader/grader.sh` the optional third, for scoring on
Submit. They live in the base task itself; the copies here are kept
so they are versioned next to the code they depend on, and so a change to the
release layout and a change to the script that unpacks it show up in the same
diff. The base task stores them at `.codesignal/setup.sh` and
`.codesignal/run_solution.sh`, with a `main.sh` that runs the latter.

## The layout

- **One directory, named after the simulation** (`cosmo-automations/`), holds the
  code, the `config.json` the task delivers as its project file
  (`cosmo-automations/config.json`), and everything the simulation writes:
  `solution.json`, `execution.json`, `activity.log`.
- `setup.sh` downloads the release into that directory — the latest on
  production, the newest pre-release on staging (`$APP_ENVIRONMENT`; see the
  main README, "Releases") — unpacks it and starts the server on port 3000. It ends on a foreground server start — the
  session does not expect it to return.
- `run_solution.sh` changes into that directory and prints the grading report.

The release unpacks flat: `package.json` and the bundled server sit at the top
of the directory, every script is one self-contained file at its usual path,
there is no `node_modules`, and `dist/` holds only the built client.

**No readiness check.** If the candidate never ran their workflow,
`execution.json` is absent, every assertion FAILs and the signature is MISSING —
the right verdict, with an explanation, rather than a bare error.

## Scoring on Submit

A task can score submissions itself, with the platform's command grader, instead
of having the grading report read by another grader. Turn on **Score with a
command grader** in the base task and set:

| Setting | Value |
|---|---|
| Grader directory | `.codesignal/grader` |
| Command | `sh grader.sh` |
| Report format | Markdown |
| Partial credit | on for a score per assertion, off for all or nothing |

Then add [`grader/grader.sh`](grader/grader.sh) to the base task as
`.codesignal/grader/grader.sh`, marked hidden — every file in the grader
directory must be.

On Submit, the platform runs the command from a private copy of that directory,
with the candidate's files at `$CODESIGNAL_WORKSPACE`. `grader.sh` downloads the
scorer of the same release the session runs into that private directory — once;
a later run reuses it — and runs it on `$CODESIGNAL_WORKSPACE`. Each release
carries the scorer as its own asset, `score.js`: [`grading/score.js`](../grading/score.js)
packed into one file with the QuickJS WASM inside, so it runs with nothing
beside it and the grader never downloads or unpacks the tarball. `score.js` re-runs the saved workflow and checks it
exactly as `run_solution.sh` does, and writes `score.json` —
`{ totalScore, maxScore, breakoutScores }`, one point per assertion — and
`report.md` — the score, a table of the checks, and the full grading report.
`grader.sh` copies the report to `$SCORE_REPORT_PATH` and prints the score.

`score.js` knows nothing about the command grader: run with no arguments beside
the simulation, as Learn would, it scores the current directory into the same
two files. See its header for every flag.

- **Nothing in the workspace is trusted** but the saved workflow itself. The
  grading code is a fresh download, not the copy in the workspace, and the score
  is worked out at Submit; a score or report file in the workspace is ignored.
  A fix to grading ships with a new release, with no question to republish.
- **It needs the network at Submit.** If the download fails, `grader.sh` exits
  non-zero and the submission goes to manual scoring — it never falls back to
  the workspace's copy.
- **The submitted workflow is what counts.** It is scored by running it at
  Submit, so a workflow never run in the simulation, or changed after its last
  run, scores what it does. The report notes it, for the reviewer.
- **Hidden assertions.** A task ships its answer key as
  `hidden_cosmo-automations/assertions.json`: exported beside `config.json` as a
  hidden, read-only file the candidate cannot open, and read by the grader in
  place of any assertions in `config.json`. An `assertions.json` in the grader
  directory works too, passed with `--assertions`.
- **A broken task is not a 0.** No scenario, unreadable or missing assertions,
  or a crash make the grader exit non-zero, and the platform marks the
  submission for manual scoring instead.

To try it by hand, copy `grader.sh` into an empty directory and run it there:

```sh
CODESIGNAL_WORKSPACE=/usercode/FILESYSTEM SCORE_REPORT_PATH=report.md sh grader.sh
```

## Live AI answers

A task that enables the LLM Proxy gives the session `OPENAI_API_KEY` and
`OPENAI_BASE_URL`. Neither script needs to change: they are in the container's
environment, and the server inherits them. See
[`docs/agent-nodes.md`](../docs/agent-nodes.md#live-answers-learn).

## Checking a change

`npm run release:local` builds a release tarball exactly as CI does and boots it
end to end: it unpacks the tarball, starts the server, runs a workflow over the
API, grades it, checks `activity.log`, and runs `npm run validate` from inside the
package.
