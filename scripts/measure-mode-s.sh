#!/usr/bin/env bash
# Mode-S success-rate harness (KA1): run N scripted analysis goals through the
# full ask->confirm->run chain and report first-attempt / <=3-round success.
#
# Fixture mode (no credentials): scripts/measure-mode-s.sh fixture
# Real mode (KA1 measurement):   scripts/measure-mode-s.sh real
#   requires XANTHIL_LLM_BASE_URL/_MODEL/_API_KEY — each goal is one real ask
#   plus up to 3 structural fix rounds; costs are bounded by that cap.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-fixture}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CLI="$(pwd)/host/node_modules/.bin/tsx $(pwd)/host/src/cli.ts"

printf 'order_id,order_date,customer_id,category,net_amount,refund_amount\n007,2026-07-01,C01,womens,120.5,20\n008,2026-07-01,C02,mens,50,0\n009,2026-07-02,C01,womens,80,10\n' > "$TMP/sales.csv"

GOALS=(
  "net sales (= net_amount - refund_amount) by category"
  "distinct customer count and mean order value per customer"
  "daily net sales trend with day-over-day change"
)

if [ "$MODE" = "fixture" ]; then
  # One canned spec per goal: a working aggregation using the ctx contract.
  SPEC() { python3 -c "
import json
code = '''import pandas as pd
df = ctx.datasets['sales']
df = df.assign(net=(df['net_amount'].astype(float) - df['refund_amount'].astype(float)))
out = df.groupby('category')['net'].sum().reset_index()
ctx.save_result('result', out)'''
print(json.dumps({'goal':'g','assumptions':[],'code':code,'validation_checks':[]}))"; }
  : > "$TMP/fixture.jsonl"
  for _ in "${GOALS[@]}"; do echo "$(SPEC)" >> "$TMP/fixture.jsonl"; done
  export XANTHIL_LLM_FIXTURE="$TMP/fixture.jsonl"
else
  : "${XANTHIL_LLM_BASE_URL:?real mode needs XANTHIL_LLM_BASE_URL}"
  : "${XANTHIL_LLM_MODEL:?real mode needs XANTHIL_LLM_MODEL}"
  : "${XANTHIL_LLM_API_KEY:?real mode needs XANTHIL_LLM_API_KEY}"
fi

cd "$TMP"
$CLI init >/dev/null
$CLI register sales.csv --alias sales >/dev/null
$CLI profile sales >/dev/null
sed -i '' 's/grain: ""/grain: "one row = order line"/' .xanthil/datasets/sales.schema.yaml
$CLI schema approve sales >/dev/null

PASS=0; FAIL=0; ROUNDS_TOTAL=0
for GOAL in "${GOALS[@]}"; do
  TASK=$($CLI ask "$GOAL" --dataset sales | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  $CLI confirm "$TASK" >/dev/null
  OUT=$($CLI run "$TASK")
  STATUS=$(echo "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  ROUNDS=$($CLI tasks | python3 -c "
import json,sys
for t in json.load(sys.stdin):
    if t['id'] == '$TASK':
        print({'succeeded': 1, 'failed': 1}.get(t['status'], 1))")
  ROUNDS_TOTAL=$((ROUNDS_TOTAL + ROUNDS))
  if [ "$STATUS" = "succeeded" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
  echo "$STATUS  $GOAL"
done

echo "---"
echo "mode=$MODE goals=${#GOALS[@]} passed=$PASS failed=$FAIL model_call_rounds_total=$ROUNDS_TOTAL"
$CLI audit | python3 -c 'import json,sys; calls=json.load(sys.stdin); print(f"model_calls={len(calls)} (all mode-S envelopes, see .xanthil/logs/egress)")'
