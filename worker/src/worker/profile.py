"""One-shot profiling of a local CSV for the Xanthil host.

Reads a JSON request from stdin ({alias, path}) and answers with exactly one
JSON line on stdout: {profile, card_draft}. The profile stays local; only the
stats-free schema card draft may ever travel toward the model egress gateway.
"""

import json
import sys

import pandas as pd

_INTEGER_RE = r"-?\d+"
_NUMBER_RE = r"-?\d+(\.\d+)?"
_LEADING_ZERO_RE = r"0\d+"


def profile_csv(path: str) -> dict:
    df = pd.read_csv(path, dtype=str)
    columns = []
    for col in df.columns:
        series = df[col].dropna()
        has_values = len(series) > 0
        all_numeric = (
            bool(series.str.fullmatch(_NUMBER_RE).all()) if has_values else False
        )
        all_integer = bool(series.str.fullmatch(_INTEGER_RE).all()) if has_values else False
        inferred = "string"
        if all_numeric:
            inferred = "integer" if all_integer else "number"
        columns.append(
            {
                "name": str(col),
                "inferred_type": inferred,
                "null_count": int(df[col].isna().sum()),
                "distinct_count": int(series.nunique()),
                "leading_zero_candidate": (
                    bool(series.str.fullmatch(_LEADING_ZERO_RE).any()) if has_values else False
                ),
                "all_numeric_strings": all_numeric,
            }
        )
    return {
        "row_count": int(len(df)),
        "scanned": "full",
        "is_sampled": False,
        "columns": columns,
    }


def schema_card_draft(alias: str, profile: dict) -> dict:
    columns = {}
    for col in profile["columns"]:
        # Leading-zero ids must survive as strings even when every value looks numeric.
        col_type = "string" if col["leading_zero_candidate"] else col["inferred_type"]
        columns[col["name"]] = {"type": col_type, "semantics": ""}
    return {
        "dataset": alias,
        "grain": "",
        "columns": columns,
        "unique_keys": [],
        "notes": [],
    }


def main() -> None:
    request = json.load(sys.stdin)
    profile = profile_csv(request["path"])
    draft = schema_card_draft(request["alias"], profile)
    sys.stdout.write(json.dumps({"profile": profile, "card_draft": draft}) + "\n")


if __name__ == "__main__":
    main()
