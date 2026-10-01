#!/bin/bash
# 一键启动 Xanthil 本地分析工作台 (双端通用: macmini / MacBook)
# 流程: 装依赖(首次) → 建/复用工作区并预置演示数据(全本地) → 注入本机模型凭据
#       → 打印状态面板 → 进入带 xanthil 命令的交互 shell。
# 模型凭据仅注入本进程环境(经 scripts/with-llm-env.sh, 不打印不落仓);
# 退出 shell 即失效。双机同步: git push 后另一端 git pull。
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

CHECK_ONLY=0
[ "$1" = "--check" ] && CHECK_ONLY=1

echo "== Xanthil 本地分析工作台 =="

# --- 依赖(首次运行) ---
if [ ! -d host/node_modules ]; then
  echo "[首次运行] 安装 host 依赖 (pnpm install)…"
  pnpm install
fi
if [ ! -x worker/.venv/bin/python ]; then
  echo "[首次运行] 安装 worker 环境 (uv sync)…"
  (cd worker && uv sync)
fi

REPO="$PWD"
X="$REPO/host/node_modules/.bin/tsx $REPO/host/src/cli.ts"
WS="$PWD/workspace"

# --- 工作区 + 演示数据(全本地, 零模型调用) ---
if [ ! -f "$WS/.xanthil/db.sqlite" ]; then
  echo "[首次运行] 初始化工作区 workspace/ 并预置演示数据集…"
  mkdir -p "$WS"
  (cd "$WS" && $X init >/dev/null)
  cat > "$WS/demo-sales.csv" <<'CSV'
order_id,order_date,customer_id,category,net_amount,refund_amount
007,2026-07-01,C01,womens,120.50,20.00
008,2026-07-01,C02,mens,50.00,0.00
009,2026-07-02,C01,womens,80.00,10.00
007,2026-07-02,C01,womens,30.00,0.00
010,2026-08-01,C03,mens,200.00,0.00
011,2026-08-02,C02,womens,60.00,5.00
012,2026-08-02,C03,womens,40.00,0.00
CSV
  (cd "$WS" && $X register demo-sales.csv --alias sales >/dev/null)
  (cd "$WS" && $X profile sales >/dev/null)
  # 演示卡的口径: 一行=订单商品行, 净额=net_amount-refund_amount, 前导零订单号保留
  python3 - "$WS/.xanthil/datasets/sales.schema.yaml" <<'PY'
import sys
path = sys.argv[1]
s = open(path, encoding="utf8").read()
s = s.replace('grain: ""', 'grain: "one row = order line"')
s = s.replace("notes: []\n", """notes: []
checks:
  date_fields:
    - order_date
  amount_fields:
    - net_amount
    - refund_amount
  precision: 2
""")
open(path, "w", encoding="utf8").write(s)
PY
  (cd "$WS" && $X schema approve sales >/dev/null)
  (cd "$WS" && $X sandbox check >/dev/null && echo "[首次运行] 沙箱逃逸自检通过" || echo "[警告] 沙箱自检未通过——真实数据执行将被拒绝")
fi

# --- 凭据注入(本进程, source 模式; 不打印密钥) ---
MODEL_STATUS="未配置(仅夹具/离线模式; export XANTHIL_LLM_* 可手动配置)"
if [ -z "$XANTHIL_LLM_API_KEY" ]; then
  . "$REPO/scripts/with-llm-env.sh" --source || true
fi
if [ -n "$XANTHIL_LLM_API_KEY" ]; then
  MODEL_STATUS="${XANTHIL_LLM_MODEL} @ ${XANTHIL_LLM_BASE_URL}"
fi

# --- 状态面板 ---
cat <<PANEL

工作区    $WS
数据集    demo-sales.csv (别名 sales, 已确认口径)
模型端点  $MODEL_STATUS

快速开始(演示):
  xanthil ask "按品类统计净销售额(net_amount-refund_amount)与去重订单数" --dataset sales
  xanthil confirm <taskId> && xanthil run <taskId> && xanthil artifacts <taskId>
  xanthil skills                        # 零模型调用的内置分析
  xanthil skill-run monthly_compare --dataset sales --param date_field=order_date --param value_field=net_amount
  xanthil audit                         # 核对模型实际收到了什么
帮助: xanthil --help    退出: exit
PANEL

if [ "$CHECK_ONLY" = "1" ]; then
  (cd "$WS" && $X datasets)
  echo "--check 完成(非交互)"
  exit 0
fi

# --- 交互 shell(带 xanthil 函数; 凭据与函数随 shell 存续) ---
cd "$WS"
export XANTHIL_REPO="$REPO"
bash -i <<< '
xanthil() { "$XANTHIL_REPO/host/node_modules/.bin/tsx" "$XANTHIL_REPO/host/src/cli.ts" "$@"; }
export XANTHIL_LLM_API_KEY XANTHIL_LLM_BASE_URL XANTHIL_LLM_MODEL XANTHIL_REPO
cd workspace 2>/dev/null || true
echo "(已进入交互 shell; xanthil 命令可用, 当前目录=工作区)"
exec bash -i
'
