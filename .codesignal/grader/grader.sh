#!/bin/sh
# BASE-TASK CONTENT — paste into the base task's .codesignal/grader/grader.sh,
# marked hidden. See .codesignal/README.md ("Scoring on Submit").
#
# Submit runs this as the command grader, from a private copy of the grader
# directory, with the candidate's files at $CODESIGNAL_WORKSPACE.
#
# It grades with a fresh copy of the simulation, downloaded here, never with the
# code in the workspace: the candidate cannot touch what runs, and a fix ships
# with a new release instead of a republished question. score.js re-runs the
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
RELEASE_URL="https://github.com/CodeSignal/learn_cosmo-automations/releases/latest/download/release.tar.gz"
if [ "${APP_ENVIRONMENT:-}" = "staging" ]; then
  RELEASE_URL="https://github.com/CodeSignal/learn_cosmo-automations/releases/download/prerelease/release.tar.gz"
fi

# A grader can run more than once; a release a previous run unpacked is reused.
# It only ever appears complete: unpacked aside, then renamed into place.
if [ ! -f release/grading/score.js ]; then
  rm -rf release release.partial release.tar.gz
  if ! curl -fsSL --retry 3 --max-time 120 -o release.tar.gz "$RELEASE_URL"; then
    echo "Cannot grade this task: the simulation could not be downloaded from $RELEASE_URL" >&2
    exit 1
  fi
  mkdir release.partial
  tar -xzf release.tar.gz -C release.partial
  mv release.partial release
  rm -f release.tar.gz
fi

# score.js writes report.md and score.json here; the platform wants the report
# at $SCORE_REPORT_PATH and the score on STDOUT. If score.js fails, set -e stops
# before either is handed on, and the platform asks for a manual score.
rm -f report.md score.json
if [ -f assertions.json ]; then
  node release/grading/score.js --workspace "$CODESIGNAL_WORKSPACE" --assertions "$PWD/assertions.json"
else
  node release/grading/score.js --workspace "$CODESIGNAL_WORKSPACE"
fi
cp report.md "$SCORE_REPORT_PATH"
cat score.json
