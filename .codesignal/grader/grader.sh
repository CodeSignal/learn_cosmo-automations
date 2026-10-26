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
# saved workflow, checks it, prints the score as JSON and writes the report to
# $SCORE_REPORT_PATH. A hidden assertions.json beside this script, if the task
# has one, replaces the assertions in config.json.
#
# If the download fails, grading fails — the platform then asks for a manual
# score — rather than falling back to the workspace's copy.
set -eu

RELEASE_URL="https://github.com/CodeSignal/learn_cosmo-automations/releases/latest/download/release.tar.gz"

rm -rf release release.tar.gz
mkdir release
if ! curl -fsSL --retry 3 --max-time 120 -o release.tar.gz "$RELEASE_URL"; then
  echo "Cannot grade this task: the simulation could not be downloaded from $RELEASE_URL" >&2
  exit 1
fi
tar -xzf release.tar.gz -C release

exec node release/grading/score.js
