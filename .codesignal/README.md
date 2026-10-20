# Session scripts

`setup.sh` and `run_solution.sh` are the two scripts a CodeSignal base task runs
for this simulation. They live in the base task itself; the copies here are kept
so they are versioned next to the code they depend on, and so a change to the
release layout and a change to the script that unpacks it show up in the same
diff. The base task stores them at `.codesignal/setup.sh` and
`.codesignal/run_solution.sh`, with a `main.sh` that runs the latter.

## The layout

- **One directory, named after the simulation** (`cosmo-automations/`), holds the
  code, the `config.json` the task delivers as its project file
  (`cosmo-automations/config.json`), and everything the simulation writes:
  `solution.json`, `execution.json`, `activity.log`.
- `setup.sh` downloads the latest release into that directory, unpacks it and
  starts the server on port 3000. It ends on a foreground server start — the
  session does not expect it to return.
- `run_solution.sh` changes into that directory and prints the grading report.

The release unpacks flat: `package.json` and the server sit at the top of the
directory, and `dist/` holds only the built client.

**No readiness check.** If the candidate never ran their workflow,
`execution.json` is absent, every assertion FAILs and the signature is MISSING —
the right verdict, with an explanation, rather than a bare error.

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
