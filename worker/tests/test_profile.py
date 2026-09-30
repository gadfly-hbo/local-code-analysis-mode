import json
import subprocess
import sys
from pathlib import Path

from worker.profile import profile_csv, schema_card_draft


def write_csv(path: Path, content: str) -> str:
    path.write_text(content, encoding="utf-8")
    return str(path)


def test_leading_zero_ids_are_flagged_and_preserved_as_string(tmp_path):
    csv = write_csv(
        tmp_path / "orders.csv",
        "order_id,amount\n007,100\n008,200\n",
    )
    profile = profile_csv(csv)
    order_id = next(c for c in profile["columns"] if c["name"] == "order_id")
    assert profile["row_count"] == 2
    assert order_id["leading_zero_candidate"] is True
    assert order_id["all_numeric_strings"] is True

    draft = schema_card_draft("orders", profile)
    assert draft["columns"]["order_id"]["type"] == "string"


def test_pure_numeric_column_infers_number_and_mixed_column_stays_string(tmp_path):
    csv = write_csv(tmp_path / "mix.csv", "qty,label\n3,a\n4,4x\n")
    profile = profile_csv(csv)
    by_name = {c["name"]: c for c in profile["columns"]}
    assert by_name["qty"]["inferred_type"] == "integer"
    assert by_name["label"]["inferred_type"] == "string"


def test_schema_card_draft_carries_no_statistics(tmp_path):
    csv = write_csv(tmp_path / "orders.csv", "order_id,amount\n007,100\n008,200\n")
    profile = profile_csv(csv)
    draft = schema_card_draft("orders", profile)
    dumped = json.dumps(draft)
    for banned in ("row_count", "null_count", "distinct", "sample", "is_sampled"):
        assert banned not in dumped


def test_worker_protocol_answers_one_json_line_on_stdout(tmp_path):
    csv = write_csv(tmp_path / "orders.csv", "order_id,amount\n007,100\n")
    result = subprocess.run(
        [sys.executable, "-m", "worker.profile"],
        input=json.dumps({"alias": "orders", "path": csv}),
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["profile"]["row_count"] == 1
    assert payload["card_draft"]["dataset"] == "orders"
