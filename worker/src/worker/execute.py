"""Restricted execution of model-generated analysis code.

Contract: the host passes {code, datasets: {alias: path}, run_dir} on stdin.
Generated code sees ONLY the ctx object (lazy pandas dataset handles, artifact
savers). The manifest — one JSON line on stdout — reports artifacts and a
STRUCTURED error (kind + whitelisted detail). stdout/stderr produced by the
code are captured into the local run log and never leave the machine.
"""

import contextlib
import io
import json
import sys
import traceback
from pathlib import Path

import pandas as pd


class _DatasetAccessor:
    def __init__(self, paths: dict[str, str]):
        self._paths = paths
        self._loaded: set[str] = set()

    def __getitem__(self, alias: str) -> pd.DataFrame:
        if alias not in self._paths:
            raise KeyError(alias)
        self._loaded.add(alias)
        from worker.readers import read_any

        return read_any(self._paths[alias])

    def __contains__(self, alias: object) -> bool:
        return alias in self._paths

    def __iter__(self):
        return iter(self._paths)


class Ctx:
    """The ONLY handle generated code receives for data access and outputs."""

    def __init__(self, datasets: dict[str, str], artifacts_dir: Path):
        self.datasets = _DatasetAccessor(datasets)
        self._artifacts_dir = artifacts_dir
        self.manifest: list[dict] = []

    def duckdb(self):
        """Hardened DuckDB connection: extension autoload/autoinstall disabled
        (proposal §8.3). Remote sources stay unreachable via the sandbox anyway.
        """
        import duckdb

        con = duckdb.connect(":memory:")
        con.execute("SET autoload_known_extensions = false")
        con.execute("SET autoinstall_known_extensions = false")
        return con

    def _artifact_path(self, name: str, suffix: str) -> Path:
        # Model-controlled name: identifier hygiene only (the sandbox write
        # scope is the real containment; this prevents path games).
        import re

        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}", name):
            raise ValueError("invalid artifact name")
        return self._artifacts_dir / f"{name}{suffix}"

    def save_result(self, name: str, df: pd.DataFrame) -> None:
        self._artifacts_dir.mkdir(parents=True, exist_ok=True)
        path = self._artifact_path(name, ".csv")
        df.to_csv(path, index=False)
        self.manifest.append({"name": name, "type": "table", "path": str(path)})

    def save_chart(self, name: str, figure) -> None:
        self._artifacts_dir.mkdir(parents=True, exist_ok=True)
        path = self._artifact_path(name, ".png")
        figure.savefig(path)
        self.manifest.append({"name": name, "type": "chart", "path": str(path)})


def classify_error(exc: BaseException) -> dict:
    """Structural diagnostics whitelist (G6): never include cell values.

    Runtime failures carry only the exception CLASS NAME — structural, no values.
    """
    if isinstance(exc, SyntaxError):
        return {"kind": "syntax", "detail": f"line {exc.lineno}: {exc.msg}"}
    if isinstance(exc, ModuleNotFoundError):
        return {"kind": "missing_lib", "detail": exc.name or "unknown"}
    if isinstance(exc, KeyError):
        return {"kind": "keyerror", "detail": str(exc.args[0]) if exc.args else ""}
    return {"kind": "runtime", "detail": type(exc).__name__}


def execute_code(code: str, datasets: dict[str, str], artifacts_dir: Path) -> dict:
    ctx = Ctx(datasets, artifacts_dir)
    capture = io.StringIO()
    error = None
    try:
        with (
            contextlib.redirect_stdout(capture),
            contextlib.redirect_stderr(capture),
        ):
            exec(compile(code, "<analysis-code>", "exec"), {"ctx": ctx})  # noqa: S102
    except BaseException as exc:  # noqa: BLE001 - classified below; values never travel
        error = classify_error(exc)
        traceback.print_exc(file=capture)
    return {
        "status": "failed" if error else "succeeded",
        "artifacts": ctx.manifest,
        "loaded_datasets": sorted(ctx.datasets._loaded),  # noqa: SLF001
        "error": error,
        "stdout_local": capture.getvalue(),
    }


def main() -> None:
    request = json.load(sys.stdin)
    run_dir = Path(request["run_dir"])
    result = execute_code(request["code"], request["datasets"], run_dir / "artifacts")
    (run_dir / "run.log").write_text(result.pop("stdout_local"), encoding="utf-8")
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
