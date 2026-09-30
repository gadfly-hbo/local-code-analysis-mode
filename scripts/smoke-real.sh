#!/usr/bin/env bash
# Real-endpoint smoke test (manual; requires credentials):
#   XANTHIL_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \
#   XANTHIL_LLM_MODEL=glm-4.x \
#   XANTHIL_LLM_API_KEY=*** scripts/smoke-real.sh
# Runs the full mode-S chain once against a tiny synthetic CSV and prints the
# audit summary. Nothing here sends row data to the model (envelope is asserted
# by the gateway before dispatch).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${XANTHIL_LLM_BASE_URL:?set XANTHIL_LLM_BASE_URL}"
: "${XANTHIL_LLM_MODEL:?set XANTHIL_LLM_MODEL}"
: "${XANTHIL_LLM_API_KEY:?set XANTHIL_LLM_API_KEY}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CLI="$(pwd)/host/node_modules/.bin/tsx $(pwd)/host/src/cli.ts"

printf 'order_id,order_date,customer_id,category,net_amount\n007,2026-07-01,C01,womens,100.5\n008,2026-07-02,C02,mens,200\n' > "$TMP/sales.csv"

cd "$TMP"
$CLI init
$CLI register sales.csv --alias sales
$CLI profile sales > /dev/null
sed -i '' 's/grain: ""/grain: "one row = order line"/' .xanthil/datasets/sales.schema.yaml
$CLI schema approve sales

TASK=$($CLI ask "net sales by category" --dataset sales | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
$CLI confirm "$TASK"
$CLI run "$TASK"
$CLI artifacts "$TASK"

# Mode A: trusted publication of the same aggregates (needs target_model = $XANTHIL_LLM_MODEL)
PLAN=$($CLI publish plan sales | python3 -c 'import json,sys; print(json.load(sys.stdin)["plan_path"])')
python3 - "$PLAN" "$XANTHIL_LLM_MODEL" <<'PY'
import sys, yaml
path, model = sys.argv[1], sys.argv[2]
plan = yaml.safe_load(open(path))
plan["target_model"] = model
plan["min_subjects"] = 1
yaml.safe_dump(plan, open(path, "w"), sort_keys=False)
PY
PUB=$($CLI publish prepare "$PLAN" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="prepared", d; print(d["id"])')
$CLI publish approve "$PUB"
$CLI publish send "$PUB"
echo "--- audit (what the model actually received) ---"
$CLI audit | python3 -c 'import json,sys; [print(c["id"], c["provider"], c["outcome"]) for c in json.load(sys.stdin)]'
