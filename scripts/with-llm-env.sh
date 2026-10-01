#!/bin/sh
# 注入本机模型凭据到环境(不打印、不落仓)。
#
# 用法:
#   scripts/with-llm-env.sh <command...>   包装执行(deep-research 风格): exec command
#   . scripts/with-llm-env.sh --source     source 模式: 仅设置变量后返回
#
# 凭据来源: ~/.zcode/v2/config.json 的 bigmodel provider(含 apiKey 的首个)。
# 优先级: 已设置的 XANTHIL_LLM_API_KEY/BASE_URL > 本机凭据源(不覆盖)。
# 默认模型 GLM-5.3-Flash(便宜快速); 用 XANTHIL_LLM_MODEL 覆盖, e.g. GLM-5.3。
SOURCE_MODE=0
if [ "${1:-}" = "--source" ]; then
  SOURCE_MODE=1
  shift
fi

if [ -z "$XANTHIL_LLM_API_KEY" ] || [ -z "$XANTHIL_LLM_BASE_URL" ]; then
  DETECTED=$(python3 - <<'PY' 2>/dev/null
import json, os
try:
    cfg = json.load(open(os.path.expanduser('~/.zcode/v2/config.json')))
except Exception:
    raise SystemExit(0)
for name, p in (cfg.get('provider') or {}).items():
    opts = p.get('options') or {}
    base = str(opts.get('baseURL', ''))
    key = opts.get('apiKey', '')
    if 'bigmodel' in base and key:
        print(f"{key}\t{base}")
        break
PY
)
  if [ -n "$DETECTED" ]; then
    KEY=$(printf '%s' "$DETECTED" | cut -f1)
    BASE=$(printf '%s' "$DETECTED" | cut -f2)
    export XANTHIL_LLM_API_KEY="${XANTHIL_LLM_API_KEY:-$KEY}"
    export XANTHIL_LLM_BASE_URL="${XANTHIL_LLM_BASE_URL:-$BASE}"
    export XANTHIL_LLM_MODEL="${XANTHIL_LLM_MODEL:-GLM-5.3-Flash}"
  fi
fi

if [ "$SOURCE_MODE" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
if [ $# -gt 0 ]; then
  exec "$@"
fi
return 0 2>/dev/null || exit 0
