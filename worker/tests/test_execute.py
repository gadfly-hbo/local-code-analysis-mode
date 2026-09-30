import json
import subprocess
import sys
from pathlib import Path

from worker.execute import execute_code


def test_execute_code_runs_analysis_and_saves_artifact(tmp_path):
    csv = tmp_path / "sales.csv"
    csv.write_text("category,net_amount\nwomens,100\nmens,50\nwomens,25\n", encoding="utf-8")
    code = (
        "import pandas as pd\n"
        "df = ctx.datasets['sales']\n"
        "totals = (\n"
        "    df.assign(net_amount=df['net_amount'].astype(float))\n"
        "      .groupby('category')['net_amount'].sum().reset_index()\n"
        ")\n"
        "ctx.save_result('by_category', totals)\n"
    )
    result = execute_code(code, {"sales": str(csv)}, tmp_path / "artifacts")

    assert result["status"] == "succeeded"
    assert result["loaded_datasets"] == ["sales"]
    artifact = Path(result["artifacts"][0]["path"])
    assert artifact.read_text(encoding="utf-8").strip() == (
        "category,net_amount\nmens,50.0\nwomens,125.0"
    )


def test_print_of_dataframe_stays_in_local_log(tmp_path):
    csv = tmp_path / "sales.csv"
    csv.write_text("order_id,amount\nSECRET-007,100\n", encoding="utf-8")
    code = "df = ctx.datasets['sales']\nprint(df)\nctx.save_result('x', df)"
    result = execute_code(code, {"sales": str(csv)}, tmp_path / "artifacts")

    assert result["status"] == "succeeded"
    assert "SECRET-007" in result["stdout_local"]


def test_error_classification_whitelist(tmp_path):
    csv = tmp_path / "s.csv"
    csv.write_text("a,b\n1,2\n", encoding="utf-8")

    syntax = execute_code("def broken(:\n", {"s": str(csv)}, tmp_path / "a")
    assert syntax["error"]["kind"] == "syntax"
    assert "1" in syntax["error"]["detail"]

    missing = execute_code(
        "import nonexistent_pkg_xyz\n", {"s": str(csv)}, tmp_path / "b"
    )
    assert missing["error"]["kind"] == "missing_lib"
    assert missing["error"]["detail"] == "nonexistent_pkg_xyz"

    keyerr = execute_code("d = {}\nd['revenue']", {"s": str(csv)}, tmp_path / "c")
    assert keyerr["error"]["kind"] == "keyerror"
    assert keyerr["error"]["detail"] == "revenue"

    runtime = execute_code("1/0", {"s": str(csv)}, tmp_path / "d")
    assert runtime["error"]["kind"] == "runtime"
    assert runtime["error"]["kind"] == "runtime"
    assert runtime["error"]["detail"] == "ZeroDivisionError"  # class name only, no values


def test_unknown_dataset_alias_raises_keyerror(tmp_path):
    result = execute_code("df = ctx.datasets['ghost']", {}, tmp_path / "a")
    assert result["error"]["kind"] == "keyerror"
    assert result["error"]["detail"] == "ghost"


def test_protocol_one_json_line_with_local_run_log(tmp_path):
    csv = tmp_path / "s.csv"
    csv.write_text("a\n1\n", encoding="utf-8")
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    code = "df = ctx.datasets['sales']\nprint('LEAK-MARK')\nctx.save_result('r', df)"
    proc = subprocess.run(
        [sys.executable, "-m", "worker.execute"],
        input=json.dumps({"code": code, "datasets": {"sales": str(csv)}, "run_dir": str(run_dir)}),
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["status"] == "succeeded"
    assert "stdout_local" not in payload
    assert "LEAK-MARK" in (run_dir / "run.log").read_text(encoding="utf-8")
