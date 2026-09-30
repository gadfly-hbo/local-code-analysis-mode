"""Sandbox escape self-check for the worker side.

Runs INSIDE the isolation backend as the probe subject: it attempts the real
escape channels (local TCP connect, read outside allowed paths, write outside
the run dir) and reports which ones were blocked. Outside a sandbox all three
attempts succeed, which is what the host-side unit test relies on.
"""

import json
import socket
import sys
from pathlib import Path


def _try_network_connect() -> bool:
    try:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
    except OSError:
        return False
    try:
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.settimeout(3)
        client.connect(("127.0.0.1", port))
        client.close()
        return True
    except OSError:
        return False
    finally:
        listener.close()


def _try_read(path: str) -> bool:
    try:
        return Path(path).read_text(encoding="utf-8").startswith("PROBE")
    except OSError:
        return False


def _try_write(path: str) -> bool:
    try:
        Path(path).write_text("PROBE-ESCAPED", encoding="utf-8")
        return True
    except OSError:
        return False


def run_checks(read_probe: str, write_probe: str, system_read_probe: str = "") -> dict:
    network_reached = _try_network_connect()
    read_succeeded = _try_read(read_probe)
    write_succeeded = _try_write(write_probe)
    system_read_succeeded = _try_read(system_read_probe) if system_read_probe else False
    return {
        "network_reached": network_reached,
        "read_succeeded": read_succeeded,
        "write_succeeded": write_succeeded,
        "system_read_succeeded": system_read_succeeded,
        "network_blocked": not network_reached,
        "read_blocked": not read_succeeded,
        "write_blocked": not write_succeeded,
        "system_read_blocked": not system_read_succeeded,
    }


def main() -> None:
    request = json.load(sys.stdin)
    report = run_checks(
        request["read_probe"], request["write_probe"], request.get("system_read_probe", "")
    )
    report["passed"] = (
        report["network_blocked"]
        and report["read_blocked"]
        and report["write_blocked"]
        and report["system_read_blocked"]
    )
    sys.stdout.write(json.dumps(report) + "\n")


if __name__ == "__main__":
    main()
