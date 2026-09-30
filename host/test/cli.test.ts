import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const hostDir = fileURLToPath(new URL("..", import.meta.url));
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);

function runCli(args: string[]): string {
  return execFileSync(
    tsxBin,
    [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...args],
    {
      cwd: hostDir,
      encoding: "utf8",
    },
  );
}

test("CLI --version prints the package version", () => {
  expect(runCli(["--version"]).trim()).toBe("0.1.0");
});

test("CLI --help mentions the tool name and default privacy mode", () => {
  const help = runCli(["--help"]);
  expect(help).toContain("xanthil");
  expect(help).toContain("mode S");
});
