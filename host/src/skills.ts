/**
 * Parameterized analysis skills (E2): local, deterministic generators that
 * produce AnalysisTaskSpecs WITHOUT any model call. Specs enter the SAME
 * awaiting_confirmation → confirm → run lifecycle as model-generated ones —
 * no second code-generation path, no new IO surface.
 */

import type { SchemaCard } from "./profiler.ts";
import type { AnalysisTaskSpec } from "./tasks.ts";
import { UserError } from "./workspace.ts";

export interface SkillParam {
  name: string;
  required: boolean;
}

export interface Skill {
  name: string;
  description: string;
  params: SkillParam[];
  generate(input: {
    alias: string;
    card: SchemaCard;
    params: Record<string, string>;
  }): AnalysisTaskSpec;
}

function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (!value || value.trim().length === 0) {
    throw new UserError(`skill param "${name}" is required`);
  }
  return value.trim();
}

function columnOf(card: SchemaCard, name: string): { type: string } {
  const col = card.columns[name];
  if (!col) {
    throw new UserError(`skill param references unknown column "${name}"`);
  }
  return col;
}

const monthlyCompare: Skill = {
  name: "monthly_compare",
  description:
    "monthly totals + distinct-order counts + month-over-month deltas for one value field",
  params: [
    { name: "date_field", required: true },
    { name: "value_field", required: true },
    { name: "order_field", required: false },
  ],
  generate({ alias, card, params }) {
    const dateField = requireParam(params, "date_field");
    const valueField = requireParam(params, "value_field");
    const orderField = params.order_field?.trim() || "";
    columnOf(card, dateField);
    columnOf(card, valueField);
    if (orderField) {
      columnOf(card, orderField);
    }
    const code = [
      "import pandas as pd",
      `df = ctx.datasets['${alias}']`,
      `df = df.assign(_m = pd.to_datetime(df['${dateField}'], errors='coerce').dt.strftime('%Y-%m'))`,
      `g = df.groupby('_m')`,
      `out = g.agg(total=('${valueField}', lambda s: pd.to_numeric(s, errors='coerce').sum())).reset_index()`,
      orderField
        ? `out['orders'] = g['${orderField}'].nunique().values`
        : `out['orders'] = g.size().values`,
      `out['delta'] = out['total'].diff()`,
      "ctx.save_result('monthly_compare', out)",
    ].join("\n");
    return {
      goal: "[skill:monthly_compare] per-month totals, order counts and deltas",
      assumptions: [
        `months derived from ${dateField} (rows failing date parse are dropped)`,
        `totals sum ${valueField} as numbers`,
      ],
      code,
      validation_checks: [
        "month buckets cover the full date range",
        "delta of first month is undefined",
      ],
    };
  },
};

const categoryContribution: Skill = {
  name: "category_contribution",
  description:
    "category totals, share of grand total, and rank for one value field",
  params: [
    { name: "category_field", required: true },
    { name: "value_field", required: true },
  ],
  generate({ alias, card, params }) {
    const categoryField = requireParam(params, "category_field");
    const valueField = requireParam(params, "value_field");
    columnOf(card, categoryField);
    columnOf(card, valueField);
    const code = [
      "import pandas as pd",
      `df = ctx.datasets['${alias}']`,
      `df = df.assign(_v = pd.to_numeric(df['${valueField}'], errors='coerce'))`,
      `out = df.groupby('${categoryField}')['_v'].sum().reset_index()`,
      "grand = out['_v'].sum()",
      "out['share'] = out['_v'] / grand",
      "out['rank'] = out['_v'].rank(ascending=False, method='min').astype(int)",
      "ctx.save_result('category_contribution', out)",
    ].join("\n");
    return {
      goal: "[skill:category_contribution] totals, share and rank by category",
      assumptions: [`shares computed against the grand total of ${valueField}`],
      code,
      validation_checks: [
        "shares sum to ~1.0",
        "rank ties resolved by min method",
      ],
    };
  },
};

export const SKILLS: Skill[] = [monthlyCompare, categoryContribution];

export function listSkills(): {
  name: string;
  description: string;
  params: SkillParam[];
}[] {
  return SKILLS.map(({ name, description, params }) => ({
    name,
    description,
    params,
  }));
}

export function runSkill(input: {
  name: string;
  alias: string;
  card: SchemaCard;
  params: Record<string, string>;
}): AnalysisTaskSpec {
  const skill = SKILLS.find((s) => s.name === input.name);
  if (!skill) {
    throw new UserError(
      `unknown skill "${input.name}" (available: ${SKILLS.map((s) => s.name).join(", ")})`,
    );
  }
  return skill.generate(input);
}
