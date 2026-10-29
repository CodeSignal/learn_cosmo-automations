#!/bin/sh
# BASE-TASK CONTENT — paste into the base task's .codesignal/grader/grader.sh,
# marked hidden. See .codesignal/README.md ("Scoring on Submit").
#
# Submit runs this as the command grader, from a private copy of the grader
# directory, with the candidate's files at $CODESIGNAL_WORKSPACE.
#
# It grades with a fresh copy of the scorer, downloaded here, never with the
# code in the workspace: the candidate cannot touch what runs, and a fix ships
# with a new release instead of a republished question. The scorer is one
# self-contained file each release carries beside its tarball. It re-runs the
# saved workflow, checks it, and writes report.md and score.json, which this
# script hands to the platform.
#
# The answer key is the task's hidden assertions.json beside config.json, or an
# assertions.json in this directory if the base task keeps one here.
#
# If the download fails, grading fails — the platform then asks for a manual
# score — rather than falling back to the workspace's copy.
set -eu

# The same build the session ran: the newest on staging, the latest release
# elsewhere (see setup.sh).
SCORER_URL="https://github.com/CodeSignal/learn_cosmo-automations/releases/latest/download/score.js"
if [ "${APP_ENVIRONMENT:-}" = "staging" ]; then
  SCORER_URL="https://github.com/CodeSignal/learn_cosmo-automations/releases/download/prerelease/score.js"
fi

# A grader can run more than once; a scorer a previous run downloaded is reused.
# It only ever appears complete: downloaded aside, then renamed into place.
if [ ! -s score.js ]; then
  rm -f score.js score.js.partial
  if ! curl -fsSL --retry 3 --max-time 120 -o score.js.partial "$SCORER_URL" || [ ! -s score.js.partial ]; then
    rm -f score.js.partial
    echo "Cannot grade this task: the scorer could not be downloaded from $SCORER_URL" >&2
    exit 1
  fi
  mv score.js.partial score.js
fi

# score.js writes report.md and score.json here; the platform wants the report
# at $SCORE_REPORT_PATH and the score on STDOUT. If score.js fails, set -e stops
# before either is handed on, and the platform asks for a manual score.
rm -f report.md score.json
if [ -f assertions.json ]; then
  node score.js --workspace "$CODESIGNAL_WORKSPACE" --assertions "$PWD/assertions.json"
else
  node score.js --workspace "$CODESIGNAL_WORKSPACE"
fi
cp report.md "$SCORE_REPORT_PATH"
cat score.json
