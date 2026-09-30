import json
import subprocess
import sys
from pathlib import Path

from worker.sandbox_check import run_checks


def test_outside_sandbox_all_escape_channels_succeed(tmp_path):
    read_probe = tmp_path / "probe.txt"
    read_probe.write_text("PROBE-secret-material", encoding="utf-8")
    write_probe = str(tmp_path / "escaped.txt")

    report = run_checks(str(read_probe), write_probe)
    # Outside a sandbox nothing is blocked — the probes must actually work,
    # otherwise "blocked: true" inside the sandbox would be a false pass.
    assert report["network_reached"] is True
    assert report["read_succeeded"] is True
    assert report["write_succeeded"] is True
    assert report["network_blocked"] is False
    assert Path(write_probe).read_text(encoding="utf-8") == "PROBE-ESCAPED"


def test_protocol_answers_one_json_line_on_stdout(tmp_path):
    read_probe = tmp_path / "probe.txt"
    read_probe.write_text("PROBE-x", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-m", "worker.sandbox_check"],
        input=json.dumps({"read_probe": str(read_probe), "write_probe": str(tmp_path / "w.txt")}),
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert set(payload) >= {
        "network_blocked",
        "read_blocked",
        "write_blocked",
        "passed",
    }
