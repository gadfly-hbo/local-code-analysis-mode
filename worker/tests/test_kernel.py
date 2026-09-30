import json
import subprocess
import sys

from worker.kernel import method_execute


def test_execute_reuses_loaded_dataset_across_calls_and_tracks_loads(tmp_path):
    csv = tmp_path / "s.csv"
    csv.write_text("a,b\n1,x\n2,y\n", encoding="utf-8")
    import hashlib

    version = hashlib.sha256(csv.read_bytes()).hexdigest()
    datasets = {"sales": {"path": str(csv), "version": version}}
    (tmp_path / "run1").mkdir()
    (tmp_path / "run2").mkdir()

    first = method_execute(
        {
            "code": "session['seen'] = len(ctx.datasets['sales'])",
            "datasets": datasets,
            "run_dir": str(tmp_path / "run1"),
        }
    )
    assert first["status"] == "succeeded"
    assert first["dataset_loads"]["sales"] == 1

    second = method_execute(
        {
            "code": "assert session['seen'] == len(ctx.datasets['sales'])",
            "datasets": datasets,
            "run_dir": str(tmp_path / "run2"),
        }
    )
    assert second["status"] == "succeeded"
    assert second["dataset_loads"]["sales"] == 2  # handle reused, load_count bumped


def test_version_drift_refuses_execution(tmp_path):
    csv = tmp_path / "s.csv"
    csv.write_text("a\n1\n", encoding="utf-8")
    import hashlib

    version = hashlib.sha256(csv.read_bytes()).hexdigest()
    datasets = {"sales": {"path": str(csv), "version": version}}
    (tmp_path / "run1").mkdir()
    first = method_execute(
        {
            "code": "ctx.datasets['sales']",
            "datasets": datasets,
            "run_dir": str(tmp_path / "run1"),
        }
    )
    assert first["status"] == "succeeded"

    csv.write_text("a\n1\n2\n", encoding="utf-8")  # file changed, expected version stale
    (tmp_path / "run2").mkdir()
    result = method_execute(
        {
            "code": "ctx.datasets['sales']",
            "datasets": datasets,
            "run_dir": str(tmp_path / "run2"),
        }
    )
    assert result["status"] == "failed"
    assert result["error"]["kind"] == "runtime"  # drift surfaces as opaque failure, never values


def test_kernel_daemon_protocol_over_stdio(tmp_path):
    csv = tmp_path / "s.csv"
    csv.write_text("a\n1\n", encoding="utf-8")
    import hashlib

    version = hashlib.sha256(csv.read_bytes()).hexdigest()
    run1 = tmp_path / "run1"
    run1.mkdir()
    proc = subprocess.Popen(
        [sys.executable, "-m", "worker.kernel"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        def call(payload: dict) -> dict:
            proc.stdin.write(json.dumps(payload) + "\n")
            proc.stdin.flush()
            return json.loads(proc.stdout.readline())

        hello = call({"id": 1, "method": "health", "params": {}})
        assert hello["ok"] is True

        exec1 = call(
            {
                "id": 2,
                "method": "execute",
                "params": {
                    "code": "session['rows'] = len(ctx.datasets['sales'])",
                    "datasets": {"sales": {"path": str(csv), "version": version}},
                    "run_dir": str(run1),
                },
            }
        )
        assert exec1["ok"] is True
        assert exec1["result"]["status"] == "succeeded"

        health = call({"id": 3, "method": "health", "params": {}})
        assert health["result"]["datasets"]["sales"]["version"] == version
        assert health["result"]["session_keys"] == ["rows"]

        bogus = call({"id": 4, "method": "nope", "params": {}})
        assert bogus["ok"] is False
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
