/**
 * Workspace policy (E3): Host-enforced organizational floors. Absent file =
 * unrestricted (back-compat). The policy lives under the workspace (inside
 * /Users) so the sandbox's read-deny already keeps workers away from it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { UserError, type Workspace } from "./workspace.ts";

export interface WorkspacePolicy {
  allowed_target_models?: string[];
  min_subjects_floor?: number;
  max_metrics_per_plan?: number;
  banned_dimensions?: string[];
  require_checks_on_approve?: boolean;
}

export function policyPath(ws: Workspace): string {
  return join(ws.root, "policy.yaml");
}

export function loadPolicy(ws: Workspace): WorkspacePolicy | null {
  try {
    return loadPolicyStrict(ws);
  } catch {
    // Caller-side leniency for the SHOW command; enforcement call sites use
    // loadPolicyStrict so broken policies fail closed (P1).
    return null;
  }
}

/** Strict loader: a PRESENT but broken policy file throws (fail-closed). */
export function loadPolicyStrict(ws: Workspace): WorkspacePolicy | null {
  let raw: string;
  try {
    raw = readFileSync(policyPath(ws), "utf8");
  } catch {
    return null; // no policy = unrestricted
  }
  let parsed: WorkspacePolicy | null;
  try {
    parsed = YAML.parse(raw) as WorkspacePolicy | null;
  } catch (error) {
    throw new UserError(
      `policy: policy.yaml is not valid YAML (${String(error).slice(0, 120)}) — refusing to continue with an unreadable policy`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return {};
  }
  return parsed;
}

export function policyVersion(ws: Workspace): string | null {
  const policy = loadPolicy(ws);
  if (policy === null) {
    return null;
  }
  return `pol_${createHash("sha256")
    .update(canonicalYaml(policy))
    .digest("hex")
    .slice(0, 8)}`;
}

function canonicalYaml(policy: WorkspacePolicy): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(policy).sort()) {
    const value = (policy as Record<string, unknown>)[key];
    sorted[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  return YAML.stringify(sorted);
}

/** Enforce plan-level floors; throws UserError with a `policy:` prefix. */
export function enforcePolicyOnPlan(
  ws: Workspace,
  input: {
    target_model: string;
    min_subjects: number;
    metrics: unknown[];
    dimensions: string[];
  },
): void {
  const policy = loadPolicyStrict(ws);
  if (policy === null) {
    return;
  }
  if (
    Array.isArray(policy.allowed_target_models) &&
    policy.allowed_target_models.length > 0 &&
    !policy.allowed_target_models.includes(input.target_model)
  ) {
    throw new UserError(
      `policy: target_model "${input.target_model}" is not in the workspace allowlist`,
    );
  }
  if (
    typeof policy.min_subjects_floor === "number" &&
    input.min_subjects < policy.min_subjects_floor
  ) {
    throw new UserError(
      `policy: min_subjects ${input.min_subjects} is below the workspace floor ${policy.min_subjects_floor}`,
    );
  }
  if (
    typeof policy.max_metrics_per_plan === "number" &&
    input.metrics.length > policy.max_metrics_per_plan
  ) {
    throw new UserError(
      `policy: plan has ${input.metrics.length} metrics, max is ${policy.max_metrics_per_plan}`,
    );
  }
  for (const dimension of input.dimensions) {
    const plain = dimension.includes("(")
      ? dimension.slice(dimension.indexOf("(") + 1, -1)
      : dimension;
    if (policy.banned_dimensions?.includes(plain)) {
      throw new UserError(
        `policy: dimension "${dimension}" is banned in this workspace`,
      );
    }
  }
}
