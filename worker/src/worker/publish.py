"""Trusted publication executor (mode A, proposal §6.7).

Executes a USER-APPROVED PublicationPlan directly from the registered data
files with fixed templates. It never runs model-generated code and never
trusts arbitrary Python outputs: everything the model can receive in mode A
is recomputed here, inside the sandbox, from the same immutable data version.

Request (stdin): {datasets: {alias: {path, version}}, plan: {...}}
Response (stdout, one JSON line):
  {ok: true, result: {metrics, groups, suppressed_group_count, ...}}
  {ok: false, error: {kind, detail}}   # validation failures, never cell values
"""

from __future__ import annotations

import json
import sys

import pandas as pd

from worker.readers import read_any

MAX_DIMENSION_CARDINALITY = 50
AGGS = ("sum", "count", "count_distinct", "avg")


def _dimension_frame(df: pd.DataFrame, dimension: str) -> pd.Series:
    if "(" in dimension and dimension.endswith(")"):
        fn, arg = dimension[:-1].split("(", 1)
        if fn != "month":
            raise ValueError(f"unsupported derived dimension '{dimension}' (only month())")
        if arg not in df.columns:
            raise KeyError(arg)
        parsed = pd.to_datetime(df[arg], errors="coerce")
        bad = int(parsed.isna().sum())
        if bad > 0:
            rate = bad / max(len(parsed), 1)
            if rate > 0.01:
                raise ValueError(f"dimension '{dimension}': date parse rate below 99%")
            parsed = parsed.dropna()
        return parsed.dt.strftime("%Y-%m").reindex(df.index)
    if dimension not in df.columns:
        raise KeyError(dimension)
    return df[dimension]


def _apply_filters(df: pd.DataFrame, filters: list[dict]) -> pd.DataFrame:
    for f in filters:
        field, op = f["field"], f["op"]
        if field not in df.columns:
            raise KeyError(field)
        col = df[field]
        if op == "eq":
            df = df[col == f["value"]]
        elif op == "in":
            values = set(f["values"])
            df = df[col.isin(values)]
        elif op == "between":
            low, high = f["low"], f["high"]
            numeric = pd.to_numeric(col, errors="coerce")
            df = df[(numeric >= float(low)) & (numeric <= float(high))]
        else:
            raise ValueError(f"unsupported filter op '{op}'")
    return df


def execute_plan(datasets: dict[str, dict], plan: dict) -> dict:
    if len(datasets) != 1:
        raise ValueError("mode A publications support exactly one dataset in M2")
    alias, spec = next(iter(datasets.items()))
    df = read_any(spec["path"])
    for column in [plan["subject_field"]] + [m["field"] for m in plan["metrics"] if m["field"]]:
        if column not in df.columns and column is not None:
            raise KeyError(column)

    df = _apply_filters(df, plan.get("filters", []))

    dim_series = {d: _dimension_frame(df, d) for d in plan["dimensions"]}
    for name, series in dim_series.items():
        cardinality = int(series.nunique())
        if cardinality > MAX_DIMENSION_CARDINALITY:
            raise ValueError(
                f"dimension '{name}' has {cardinality} distinct values"
                f" (max {MAX_DIMENSION_CARDINALITY}) — too identifying to publish"
            )

    grouped = df.groupby(list(dim_series.values()) or None, dropna=False)
    subject_field = plan["subject_field"]
    min_subjects = int(plan.get("min_subjects", 5))
    precision = int(plan.get("precision", 2))

    metrics_out = []
    suppressed_keys: set[tuple] = set()
    for metric in plan["metrics"]:
        rows = []
        for key, group in grouped:
            subjects = int(group[subject_field].nunique())
            if subjects < min_subjects:
                keys = key if isinstance(key, tuple) else (key,)
                suppressed_keys.add(tuple(str(k) for k in keys))
                continue
            agg = metric["agg"]
            if agg == "count":
                value = float(len(group))
            elif metric["field"] not in group.columns:
                raise KeyError(metric["field"])
            elif agg == "count_distinct":
                value = float(group[metric["field"]].nunique())
            else:
                numeric = pd.to_numeric(group[metric["field"]], errors="coerce")
                if agg == "sum":
                    value = float(numeric.sum())
                elif agg == "avg":
                    value = float(numeric.mean())
                else:
                    raise ValueError(f"unsupported agg '{agg}'")
            keys = key if isinstance(key, tuple) else (key,)
            dims = {
                name: str(v)
                for name, v in zip(plan["dimensions"], keys, strict=False)
            }
            rows.append({"dimensions": dims, "value": round(value, precision)})
        metrics_out.append({"name": metric["name"], "rows": rows})

    return {
        "dataset": alias,
        "metrics": metrics_out,
        "group_count": int(grouped.ngroups),
        "suppressed_group_count": len(suppressed_keys),
        "subject_field": subject_field,
        "min_subjects": min_subjects,
        "precision": precision,
    }


def main() -> None:
    request = json.load(sys.stdin)
    try:
        result = execute_plan(request["datasets"], request["plan"])
        sys.stdout.write(json.dumps({"ok": True, "result": result}) + "\n")
    except KeyError as exc:
        detail = str(exc.args[0])
        payload = {"ok": False, "error": {"kind": "unknown_field", "detail": detail}}
        sys.stdout.write(json.dumps(payload) + "\n")
    except ValueError as exc:
        payload = {"ok": False, "error": {"kind": "invalid_plan", "detail": str(exc)}}
        sys.stdout.write(json.dumps(payload) + "\n")
    except Exception as exc:  # noqa: BLE001 - opaque class name only, never values
        payload = {"ok": False, "error": {"kind": "runtime", "detail": type(exc).__name__}}
        sys.stdout.write(json.dumps(payload) + "\n")


if __name__ == "__main__":
    main()
