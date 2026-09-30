import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);

// Known-good literal: sha256 of this exact fixture content, computed
// independently with `shasum -a 256` — not recomputed by the code under test.
const FIXTURE_CSV = "order_id,amount\nA001,100\nA002,200\n";
const FIXTURE_SHA256 =
  "dc4a27491bb2f101baa9dc3c349b113d7ac6da5368af02d083200eabe99f1ff3";

function runCli(
  args: string[],
  cwd: string,
): { stdout: string; status: number } {
  try {
    return {
      stdout: execFileSync(tsxBin, [cliPath, ...args], {
        cwd,
        encoding: "utf8",
      }),
      status: 0,
    };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", status: err.status ?? 1 };
  }
}

function newWorkspaceDir(): string {
  return mkdtempSync(join(tmpdir(), "xanthil-test-"));
}

test("init creates the workspace layout and re-init keeps existing data", () => {
  const cwd = newWorkspaceDir();
  runCli(["init"], cwd);
  for (const rel of [
    "db.sqlite",
    "datasets",
    "artifacts",
    "runs",
    "logs/egress",
  ]) {
    expect(existsSync(join(cwd, ".xanthil", rel)), rel).toBe(true);
  }

  // Register something, then re-init: the registration must survive.
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, FIXTURE_CSV);
  runCli(["register", csv, "--alias", "sales"], cwd);
  runCli(["init"], cwd);
  const listing = JSON.parse(runCli(["datasets"], cwd).stdout);
  expect(listing).toHaveLength(1);
});

test("register records the dataset with the content-hash version", () => {
  const cwd = newWorkspaceDir();
  runCli(["init"], cwd);
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, FIXTURE_CSV);

  const out = JSON.parse(
    runCli(["register", csv, "--alias", "sales"], cwd).stdout,
  );
  expect(out.alias).toBe("sales");
  expect(out.version).toBe(FIXTURE_SHA256);
  expect(out.dataset_id).toMatch(/^ds_/);
  expect(out.uri).toBe("dataset://sales");
});

test("re-registering identical content is idempotent; changed content creates a new version", () => {
  const cwd = newWorkspaceDir();
  runCli(["init"], cwd);
  const csv = join(cwd, "sales.csv");
  writeFileSync(csv, FIXTURE_CSV);
  runCli(["register", csv, "--alias", "sales"], cwd);
  runCli(["register", csv, "--alias", "sales"], cwd);

  let listing = JSON.parse(runCli(["datasets"], cwd).stdout);
  expect(listing[0]?.versions).toBe(1);

  writeFileSync(csv, `${FIXTURE_CSV}A003,300\n`);
  runCli(["register", csv, "--alias", "sales"], cwd);
  listing = JSON.parse(runCli(["datasets"], cwd).stdout);
  expect(listing[0]?.versions).toBe(2);
  expect(listing[0]?.current_version).not.toBe(FIXTURE_SHA256);
});

test("register rejects a missing file and init-less directories fail fast", () => {
  const cwd = newWorkspaceDir();
  const missing = runCli(
    ["register", join(cwd, "nope.csv"), "--alias", "ghost"],
    cwd,
  );
  expect(missing.status).not.toBe(0);

  runCli(["init"], cwd);
  const noInit = runCli(["datasets"], newWorkspaceDir());
  expect(noInit.status).not.toBe(0);
});
