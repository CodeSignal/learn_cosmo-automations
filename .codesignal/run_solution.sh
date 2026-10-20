#!/bin/bash
# BASE-TASK CONTENT — paste into the base task's .codesignal/run_solution.sh.
# Cosmo reads this script's STDOUT and nothing else.
#
# Everything lives in cosmo-automations/: the code, config.json, and the files
# the simulation writes (solution.json, execution.json, activity.log). The parse
# script reads them from its working directory.
#
# No readiness check: if the candidate never ran their workflow, execution.json
# is absent, every assertion FAILs and the TRACE SIGNATURE is MISSING — the right
# verdict, with an explanation, rather than a bare error.
cd /usercode/FILESYSTEM/cosmo-automations || exit 1
node parse_automation_solution.js
