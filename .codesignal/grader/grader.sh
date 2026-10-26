#!/bin/sh
# BASE-TASK CONTENT — paste into the base task's .codesignal/grader/grader.sh,
# marked hidden. See .codesignal/README.md ("Scoring on Submit").
#
# Submit runs this as the command grader, from a private copy of the grader
# directory, with the candidate's files at $CODESIGNAL_WORKSPACE. score.js
# re-runs the saved workflow, checks it, prints the score as JSON and writes the
# report to $SCORE_REPORT_PATH. Nothing the session wrote is taken on trust.
#
# A hidden assertions.json beside this script, if the task has one, replaces
# the assertions in config.json.
exec node "$CODESIGNAL_WORKSPACE/cosmo-automations/grading/score.js"
