"""Persistent analysis kernel (M1): NDJSON-over-stdio daemon.

One request per line: {id, method, params}; one response per line: {id, ok, result|error}.
The variable namespace and loaded dataset handles persist across execute calls
(F05). Dataset content versions are tracked: a changed file invalidates its
handle and a mismatch with the expected version refuses execution (F06).

The kernel is a LONG-RUNNING worker process: it must be spawned inside the
isolation backend and never sees model credentials.
"""

import hashlib
import json
import sys
import time
from pathlib import Path

import pandas as pd

from worker.execute import Ctx, classify_error

_SESSION: dict[str, object] = {}
_DATASETS: dict[str, dict] = {}  # alias -> {path, version, frame}


def _file_version(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _load_dataset(alias: str, path: str, version: str) -> dict:
    current = _file_version(path)
    if current != version:
        raise ValueError(f"version drift for dataset '{alias}'")
    entry = _DATASETS.get(alias)
    if entry and entry["version"] == version and entry["path"] == path:
        entry["load_count"] += 1
        return entry
    frame = pd.read_csv(path, dtype=str)
    entry = {"path": path, "version": version, "frame": frame, "load_count": 1}
    _DATASETS[alias] = entry
    return entry


class _KernelDatasets:
    """Lazy accessor bound to one execute call's expected versions."""

    def __init__(self, datasets: dict[str, dict]):
        self._specs = datasets

    def __getitem__(self, alias: str) -> pd.DataFrame:
        if alias not in self._specs:
            raise KeyError(alias)
        spec = self._specs[alias]
        return _load_dataset(alias, spec["path"], spec["version"])["frame"]


def method_execute(params: dict) -> dict:
    run_dir = Path(params["run_dir"])
    ctx = Ctx(params["datasets"], run_dir / "artifacts")
    accessor = _KernelDatasets(params["datasets"])
    ctx.datasets = accessor  # type: ignore[assignment]
    import contextlib
    import io
    import traceback

    capture = io.StringIO()
    error = None
    started = time.monotonic()
    try:
        with (
            contextlib.redirect_stdout(capture),
            contextlib.redirect_stderr(capture),
        ):
            code = compile(params["code"], "<analysis-code>", "exec")
            exec(code, {"ctx": ctx, "session": _SESSION})  # noqa: S102
    except BaseException as exc:  # noqa: BLE001
        error = classify_error(exc)
        traceback.print_exc(file=capture)
    (run_dir / "run.log").write_text(capture.getvalue(), encoding="utf-8")
    return {
        "status": "failed" if error else "succeeded",
        "artifacts": ctx.manifest,
        "error": error,
        "dataset_loads": {
            alias: _DATASETS.get(alias, {}).get("load_count", 0)
            for alias in params["datasets"]
        },
        "duration_ms": int((time.monotonic() - started) * 1000),
    }


def method_health(_params: dict) -> dict:
    return {
        "pid": __import__("os").getpid(),
        "datasets": {
            alias: {"version": e["version"], "load_count": e["load_count"]}
            for alias, e in _DATASETS.items()
        },
        "session_keys": sorted(_SESSION.keys()),
    }


METHODS = {"execute": method_execute, "health": method_health}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            handler = METHODS.get(request.get("method"))
            if handler is None:
                raise ValueError(f"unknown method {request.get('method')}")
            result = handler(request.get("params", {}))
            response = {"id": request.get("id"), "ok": True, "result": result}
        except BaseException as exc:  # noqa: BLE001
            response = {"id": request.get("id", None), "ok": False, "error": classify_error(exc)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
