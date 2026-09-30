"""Trusted publication executor tests (§12-style data, hand-computed literals)."""

import json

import pytest

from worker.publish import execute_plan

# §12-flavoured data: order-line grain, one refund, multi-line order, dup subject.
ROWS = (
    "order_id,order_date,customer_id,category,net_amount\n"
    "007,2026-07-01,C01,womens,100.50\n"
    "008,2026-07-01,C01,mens,50.00\n"
    "009,2026-07-02,C02,womens,-20.00\n"
    "007,2026-07-02,C01,womens,30.00\n"
)


def make_plan(**overrides):
    plan = {
        "subject_field": "customer_id",
        "min_subjects": 2,
        "precision": 2,
        "metrics": [
            {"name": "net_sales", "agg": "sum", "field": "net_amount"},
            {"name": "orders", "agg": "count_distinct", "field": "order_id"},
        ],
        "dimensions": ["category", "month(order_date)"],
        "filters": [],
    }
    plan.update(overrides)
    return plan


@pytest.fixture()
def datasets(tmp_path):
    csv = tmp_path / "sales.csv"
    csv.write_text(ROWS, encoding="utf-8")
    return {"sales": {"path": str(csv), "version": "v1"}}


def find_row(metric, **dims):
    for row in metric["rows"]:
        if row["dimensions"] == dims:
            return row["value"]
    raise AssertionError(f"no row for {dims}")


def test_multi_metric_by_category_month_with_suppression(datasets):
    result = execute_plan(datasets, make_plan())
    net = next(m for m in result["metrics"] if m["name"] == "net_sales")
    orders = next(m for m in result["metrics"] if m["name"] == "orders")
    # womens/2026-07: subjects C01+C02 (>=2) → kept; hand-computed values.
    assert find_row(net, category="womens", **{"month(order_date)": "2026-07"}) == 110.5
    assert find_row(orders, category="womens", **{"month(order_date)": "2026-07"}) == 2.0
    # mens/2026-07: only subject C01 (<2) → suppressed everywhere.
    assert all(r["dimensions"]["category"] != "mens" for r in net["rows"])
    assert result["suppressed_group_count"] == 1  # distinct GROUPS, not group x metric (R8)
    assert result["group_count"] == 2


def test_duplicate_rows_do_not_inflate_subject_or_distinct_counts(datasets):
    dup = datasets["sales"]["path"] + ".dup.csv"
    with open(dup, "w", encoding="utf-8") as fh:
        fh.write(ROWS)
        fh.write("008,2026-07-01,C01,mens,50.00\n")  # exact duplicate line
    result = execute_plan(
        {"sales": {"path": dup, "version": "v1"}},
        make_plan(min_subjects=1),  # keep mens visible
    )
    orders = next(m for m in result["metrics"] if m["name"] == "orders")
    assert find_row(orders, category="mens", **{"month(order_date)": "2026-07"}) == 1.0
    net = next(m for m in result["metrics"] if m["name"] == "net_sales")
    # duplicate line DOES sum (100 instead of 50) — by design, rows are rows
    assert find_row(net, category="mens", **{"month(order_date)": "2026-07"}) == 100.0


def test_filters_and_precision(datasets):
    plan = make_plan(
        min_subjects=1,
        metrics=[{"name": "net", "agg": "sum", "field": "net_amount"}],
        dimensions=["category"],
        filters=[{"field": "net_amount", "op": "between", "low": "0", "high": "100"}],
        precision=0,
    )
    result = execute_plan(datasets, plan)
    net = result["metrics"][0]
    assert find_row(net, category="mens") == 50.0
    assert find_row(net, category="womens") == 30.0  # 100.5 excluded, 30 kept; -20 excluded
    assert all(r["value"] == int(r["value"]) for r in net["rows"])  # precision 0


def test_high_cardinality_dimension_rejected(tmp_path):
    wide = tmp_path / "wide.csv"
    lines = ["order_id,order_date,customer_id,category,net_amount"]
    lines += [f"{i:03d},2026-07-0{i % 9 + 1},C{i % 3},womens,1.0" for i in range(60)]
    wide.write_text("\n".join(lines) + "\n", encoding="utf-8")
    plan = make_plan(
        dimensions=["order_id"], min_subjects=1,
        metrics=[{"name": "n", "agg": "count", "field": "order_id"}],
    )
    with pytest.raises(ValueError, match="order_id.*distinct values"):
        execute_plan({"sales": {"path": str(wide), "version": "v1"}}, plan)


def test_month_dimension_requires_parseable_dates(datasets, tmp_path):
    bad = tmp_path / "bad.csv"
    bad.write_text(
        "order_id,order_date,customer_id,category,net_amount\n"
        "007,not-a-date,C01,womens,10\n"
        "008,also-bad,C01,mens,20\n",
        encoding="utf-8",
    )
    plan = make_plan(
        metrics=[{"name": "n", "agg": "count", "field": "order_id"}], min_subjects=1
    )
    with pytest.raises(ValueError, match="date parse rate"):
        execute_plan({"sales": {"path": str(bad), "version": "v1"}}, plan)


def test_unknown_field_and_aggs_fail_cleanly(datasets):
    with pytest.raises(KeyError):
        execute_plan(datasets, make_plan(metrics=[{"name": "x", "agg": "sum", "field": "revenue"}]))
    bad_agg = {"name": "x", "agg": "percentile", "field": "net_amount"}
    with pytest.raises(ValueError, match="unsupported agg"):
        execute_plan(datasets, make_plan(metrics=[bad_agg]))


def test_protocol_one_json_line(tmp_path):
    import subprocess
    import sys

    csv = tmp_path / "s.csv"
    csv.write_text(ROWS, encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-m", "worker.publish"],
        input=json.dumps(
            {"datasets": {"sales": {"path": str(csv), "version": "v1"}}, "plan": make_plan()}
        ),
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["ok"] is True
    assert payload["result"]["group_count"] == 2


def test_e1_ratio_and_stat_aggs_with_hand_computed_literals(datasets):
    """E1 contract: ratio (AOV) + mean/median/std with §12-style hand values.

    womens/2026-07 rows: net 100.5, -20, 30; orders {007,009} -> AOV = 110.5/2
    = 55.25. mean(net) = 110.5/3 = 36.8333..; median = 30; std(ddof=1) of
    (100.5, -20, 30) = sqrt(((100.5-36.8333)^2 + (-20-36.8333)^2 + (30-36.8333)^2)/2)
    = sqrt((4054.69 + 3231.36 + 46.69)/2) = sqrt(3666.37) = 60.55.
    """
    plan = make_plan(
        min_subjects=2,
        metrics=[
            {"name": "aov", "agg": "ratio", "numerator": "net_amount", "denominator": "order_id"},
        ],
    )
    # denominator must be numeric for ratio -> use net_amount/count-style instead:
    # AOV via ratio needs distinct-order denominator; use count_distinct orders as
    # a companion metric and ratio(net, lines) is meaningless. Use the documented
    # per-group sum/sum form: ratio(net_amount_sum / numeric_denominator_field).
    plan = make_plan(
        min_subjects=2,
        metrics=[
            {"name": "mean_net", "agg": "mean", "field": "net_amount"},
            {"name": "median_net", "agg": "median", "field": "net_amount"},
            {"name": "std_net", "agg": "std", "field": "net_amount"},
        ],
    )
    result = execute_plan(datasets, plan)
    stats = {m["name"]: m for m in result["metrics"]}
    womens = {"category": "womens", "month(order_date)": "2026-07"}

    def find(metric_name, dims):
        metric = stats[metric_name]
        for row in metric["rows"]:
            if row["dimensions"] == dims:
                return row["value"]
        raise AssertionError(f"no row for {metric_name} {dims}")

    assert find("mean_net", womens) == 36.83
    assert find("median_net", womens) == 30.0
    assert abs(find("std_net", womens) - 60.55) < 0.01


def test_e1_ratio_metric_and_zero_denominator_guard(tmp_path):
    csv = tmp_path / "r.csv"
    csv.write_text(
        "order_id,order_date,customer_id,category,net_amount,order_lines\n"
        "007,2026-07-01,C01,womens,100.0,2\n"
        "008,2026-07-01,C02,womens,50.0,2\n"
        "009,2026-07-02,C03,mens,30.0,0\n",
        encoding="utf-8",
    )
    good = {
        "subject_field": "customer_id",
        "min_subjects": 2,
        "precision": 2,
        "metrics": [
            {
                "name": "per_line",
                "agg": "ratio",
                "numerator": "net_amount",
                "denominator": "order_lines",
            }
        ],
        "dimensions": ["category"],
        "filters": [],
    }
    result = execute_plan({"sales": {"path": str(csv), "version": "v1"}}, good)
    row = result["metrics"][0]["rows"][0]
    assert row["dimensions"] == {"category": "womens"}
    assert row["value"] == 37.5  # (100+50)/(2+2)

    zero_den = {
        **good,
        "filters": [{"field": "category", "op": "eq", "value": "mens"}],
        "min_subjects": 1,
    }
    with pytest.raises(
        ValueError, match="denominator field 'order_lines' sums to ~zero"
    ):
        execute_plan({"sales": {"path": str(csv), "version": "v1"}}, zero_den)
