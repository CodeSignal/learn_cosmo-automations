#!/usr/bin/env bash
# The grading experiment.
#
# Runs every variant in scenarios/<name>/variants/ through the engine and the
# parse script, then checks the mechanical verdict (all PASS + VALID) against
# what the filename claims. `correct-*` must be approved, `wrong-*` rejected.
#
# The STDOUT captured under out/ is what you paste into Cosmo alongside the
# acceptance criteria to confirm the LLM agrees with the arithmetic.
set -uo pipefail
cd "$(dirname "$0")/.."

SCENARIO_DIR="${1:-scenarios/eu-orders}"
SCENARIO="$SCENARIO_DIR/scenario.json"
OUT="$SCENARIO_DIR/out"
rm -rf "$OUT" && mkdir -p "$OUT"

pass_count=0
fail_count=0

printf '%-32s %-10s %-10s %s\n' "VARIANT" "EXPECTED" "VERDICT" "RESULT"
printf '%.0s─' {1..76}; printf '\n'

for variant in "$SCENARIO_DIR"/variants/*.json; do
  name="$(basename "$variant" .json)"
  case "$name" in
    correct-*) expected="APPROVE" ;;
    wrong-*)   expected="REJECT" ;;
    *)         expected="?" ;;
  esac

  node run.js "$SCENARIO" "$variant" "$OUT/$name.execution.json" 2>"$OUT/$name.run.log"

  # The parse script reads from cwd, so stage the trio in a temp dir.
  work="$(mktemp -d)"
  cp "$SCENARIO" "$work/scenario.json"
  cp "$variant" "$work/solution.json"
  cp "$OUT/$name.execution.json" "$work/execution.json"
  ( cd "$work" && node "$OLDPWD/parse_automation_solution.js" ) > "$OUT/$name.stdout.txt"
  rm -rf "$work"

  stdout="$OUT/$name.stdout.txt"
  if grep -q '^FAIL' "$stdout" || ! grep -qx 'VALID' "$stdout"; then
    verdict="REJECT"
  else
    verdict="APPROVE"
  fi

  if [ "$verdict" = "$expected" ]; then
    result="ok"; pass_count=$((pass_count + 1))
  else
    result="MISCLASSIFIED"; fail_count=$((fail_count + 1))
  fi
  printf '%-32s %-10s %-10s %s\n' "$name" "$expected" "$verdict" "$result"
done

printf '%.0s─' {1..76}; printf '\n'
total=$((pass_count + fail_count))
echo "$pass_count/$total variants classified correctly"
echo "STDOUT captures: $OUT/*.stdout.txt"
[ "$fail_count" -eq 0 ]
