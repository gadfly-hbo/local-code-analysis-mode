/** parseTaskSpec extraction hardening: real GLM replies arrive as markdown with
 * code fences, prose around JSON, and dict literals — the parser must survive. */
import { expect, test } from "vitest";
import { parseTaskSpec } from "../src/tasks.ts";

const VALID = {
  goal: "g",
  assumptions: ["a"],
  code: "pass",
  validation_checks: [],
};

test("plain JSON and extra keys: extra keys are dropped, not fatal", () => {
  const spec = parseTaskSpec(
    JSON.stringify({ ...VALID, net_sales: 123, example: true }),
  );
  expect(spec.goal).toBe("g");
  expect(Object.keys(spec).sort()).toEqual([
    "assumptions",
    "code",
    "goal",
    "validation_checks",
  ]);
});

test("prose around JSON: outermost brace span still wins when it has a code key", () => {
  const spec = parseTaskSpec(
    `Here is the plan:\n\n${JSON.stringify(VALID)}\n\nGood luck.`,
  );
  expect(spec.code).toBe("pass");
});

test("fenced ```json block inside prose is extracted", () => {
  const spec = parseTaskSpec(
    `## 思路\nblah\n\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\n\n## 说明`,
  );
  expect(spec.goal).toBe("g");
});

test("single python fence: accepted as code with disclosure marker", () => {
  const spec = parseTaskSpec(
    `## 实现\n\n\`\`\`python\nimport pandas as pd\ndf = ctx.datasets['sales']\n\`\`\`\n`,
  );
  expect(spec.code).toContain("ctx.datasets");
  expect(spec.assumptions[0]).toMatch(/review the code/);
});

test("multiple python fences: FIRST block taken with disclosure", () => {
  const spec = parseTaskSpec(
    `\`\`\`python\ndf = ctx.datasets['sales']\n\`\`\`\n\n## 等价 DuckDB 写法(可选)\n\`\`\`python\nimport duckdb\n\`\`\``,
  );
  expect(spec.code).toBe("df = ctx.datasets['sales']");
  expect(spec.assumptions[0]).toContain("2 code blocks");
});

test("python dict literal in code does NOT masquerade as the spec", () => {
  // No python fence, no valid spec JSON — only prose with a dict literal.
  expect(() =>
    parseTaskSpec(`结果 .round({"net_sales": 2}) 即可，无需其他步骤。`),
  ).toThrow(/did not return a JSON/);
});
