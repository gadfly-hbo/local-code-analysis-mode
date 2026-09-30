"""Correctness benchmarks (F02/F03/F04) and DuckDB hardening (§8.3).

Expected values are hand-computed literals — never recomputed the same way
the code under test computes them.
"""

import json
from pathlib import Path

from worker.execute import execute_code

# Order-line grain, one refund row, leading-zero order ids.
SALES_CSV = (
    "order_id,order_date,customer_id,category,net_amount\n"
    "007,2026-07-01,C01,womens,100.50\n"
    "008,2026-07-01,C01,mens,50.00\n"
    "009,2026-07-02,C02,womens,-20.00\n"  # refund line
    "007,2026-07-02,C01,womens,30.00\n"  # second line of order 007
)

ANALYSIS_CODE = """
import pandas as pd
df = ctx.datasets['sales']
df = df.assign(net_amount=df['net_amount'].astype(float))
orders = df.groupby('order_id').agg(
    lines=('order_id', 'size'),
    order_net=('net_amount', 'sum'),
).reset_index()
ctx.save_result('by_order', orders)
by_cat = df.groupby('category')['net_amount'].sum().reset_index()
ctx.save_result('by_category', by_cat)
total = pd.DataFrame({'total_net': [df['net_amount'].sum()]})
ctx.save_result('total', total)
"""


def _run(tmp_path: Path) -> dict[str, str]:
    csv = tmp_path / "sales.csv"
    csv.write_text(SALES_CSV, encoding="utf-8")
    result = execute_code(ANALYSIS_CODE, {"sales": str(csv)}, tmp_path / "art")
    assert result["status"] == "succeeded", result["error"]
    return {
        a["name"]: Path(a["path"]).read_text(encoding="utf8").strip()
        for a in result["artifacts"]
    }


def test_f02_f03_order_level_dedup_refund_and_leading_zero_correctness(tmp_path):
    artifacts = _run(tmp_path)
    # Hand-computed: order 007 = 100.50 + 30.00; order 008 = 50; order 009 = -20.
    assert artifacts["by_order"] == (
        "order_id,lines,order_net\n007,2,130.5\n008,1,50.0\n009,1,-20.0"
    )
    # Leading-zero ids survive as strings end to end (F02).
    assert artifacts["by_order"].startswith("order_id,lines,order_net\n007")


def test_f04_category_totals_reconcile_with_overall_total(tmp_path):
    artifacts = _run(tmp_path)
    # Hand-computed: womens = 100.50 - 20.00 + 30.00 = 110.50; mens = 50; total = 160.50.
    assert artifacts["by_category"] == "category,net_amount\nmens,50.0\nwomens,110.5"
    assert artifacts["total"] == "total_net\n160.5"


def test_f08_rerun_same_data_same_code_identical_artifacts(tmp_path):
    first = _run(tmp_path)
    second = _run(tmp_path)
    assert first == second


def test_duckdb_connection_is_hardened_against_extensions(tmp_path):
    csv = tmp_path / "s.csv"
    csv.write_text("a\n1\n", encoding="utf-8")
    hardened_sql = (
        "con = ctx.duckdb()\n"
        "rows = con.execute(\"select name, value from duckdb_settings() "
        "where name in ('autoload_known_extensions','autoinstall_known_extensions')\").fetchall()\n"
        "settings = dict(rows)\n"
        "assert settings['autoload_known_extensions'] == 'false'\n"
        "assert settings['autoinstall_known_extensions'] == 'false'\n"
    )
    result = execute_code(hardened_sql, {"s": str(csv)}, tmp_path / "art")
    assert result["status"] == "succeeded", result["error"]


def test_duckdb_cannot_install_remote_extensions_under_sandbox(tmp_path):
    """Protocol-level smoke: INSTALL requires network, which the isolation
    backend denies; inside plain pytest we assert the hardening flags make
    LOAD of a non-bundled extension fail. Full network denial is proven by the
    host-side sandbox self-check (P04)."""
    csv = tmp_path / "s.csv"
    csv.write_text("a\n1\n", encoding="utf-8")
    result = execute_code(
        "con = ctx.duckdb()\n"
        "try:\n"
        "    con.execute(\"LOAD httpfs\")\n"
        "    raise AssertionError('httpfs loaded')\n"
        "except Exception as exc:\n"
        "    session_ok = type(exc).__name__ != 'AssertionError'\n"
        "    assert session_ok\n",
        {"s": str(csv)},
        tmp_path / "art",
    )
    assert result["status"] == "succeeded", result["error"]


def test_protocol_shape_of_benchmark_run(tmp_path):
    artifacts = _run(tmp_path)
    assert set(artifacts) == {"by_order", "by_category", "total"}
    assert json.dumps(sorted(artifacts))  # artifacts are plain CSV text
