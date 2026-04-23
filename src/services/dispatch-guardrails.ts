import { normalizeWorkflowName, type ResolvedDispatchTarget } from "../domain/trigger-matcher/match.js";
import type { WorkflowRunPayload } from "../github/types.js";

export type GuardrailSettings = {
  enforceSourceDefaultBranch: boolean;
  maxTargetsPerRun: number;
  sourceRepoAllowlist: string;
  targetRepoAllowlist: string;
  sourceWorkflowAllowlist: string;
};

export type SourceGuardrailDeniedReason =
  | "source_not_default_branch"
  | "source_workflow_not_allowlisted"
  | "source_repo_not_allowlisted"
  | "source_from_fork";

export type TargetGuardrailDeniedReason =
  | "target_repo_not_allowlisted"
  | "self_dispatch_blocked"
  | "duplicate_target"
  | "max_targets_exceeded";

export type GuardrailDeniedTarget = {
  target: ResolvedDispatchTarget;
  reason: TargetGuardrailDeniedReason;
};

export function evaluateSourceWorkflowRun(
  payload: WorkflowRunPayload,
  settings: GuardrailSettings,
): { allowed: true } | { allowed: false; reason: SourceGuardrailDeniedReason } {
  const sourceRepoFullName = `${payload.repository.owner.login}/${payload.repository.name}`.toLowerCase();
  const sourceWorkflow = normalizeWorkflowName(payload.workflow_run.path).toLowerCase();

  if (settings.enforceSourceDefaultBranch) {
    const headBranch = payload.workflow_run.head_branch;
    const defaultBranch = payload.repository.default_branch;
    if (!headBranch || !defaultBranch || headBranch !== defaultBranch) {
      return { allowed: false, reason: "source_not_default_branch" };
    }
  }

  if (!isAllowed(sourceRepoFullName, settings.sourceRepoAllowlist)) {
    return { allowed: false, reason: "source_repo_not_allowlisted" };
  }

  if (!isAllowed(sourceWorkflow, settings.sourceWorkflowAllowlist)) {
    return { allowed: false, reason: "source_workflow_not_allowlisted" };
  }

  const headRepository = payload.workflow_run.head_repository?.full_name?.toLowerCase();
  if (headRepository && headRepository !== sourceRepoFullName) {
    return { allowed: false, reason: "source_from_fork" };
  }

  return { allowed: true };
}

export function filterTargetsWithGuardrails(
  candidates: ResolvedDispatchTarget[],
  sourceRepoFullName: string,
  sourceWorkflow: string,
  settings: GuardrailSettings,
): { allowed: ResolvedDispatchTarget[]; denied: GuardrailDeniedTarget[] } {
  const allowed: ResolvedDispatchTarget[] = [];
  const denied: GuardrailDeniedTarget[] = [];
  const seen = new Set<string>();
  const normalizedSourceRepo = sourceRepoFullName.toLowerCase();
  const normalizedSourceWorkflow = normalizeWorkflowName(sourceWorkflow).toLowerCase();

  for (const target of candidates) {
    const normalizedTargetRepo = `${target.owner}/${target.repo}`.toLowerCase();
    const normalizedTargetWorkflow = normalizeWorkflowName(target.workflow).toLowerCase();
    const uniqueKey = `${normalizedTargetRepo}#${normalizedTargetWorkflow}`;

    if (!isAllowed(normalizedTargetRepo, settings.targetRepoAllowlist)) {
      denied.push({ target, reason: "target_repo_not_allowlisted" });
      continue;
    }

    if (seen.has(uniqueKey)) {
      denied.push({ target, reason: "duplicate_target" });
      continue;
    }

    if (normalizedTargetRepo === normalizedSourceRepo && normalizedTargetWorkflow === normalizedSourceWorkflow) {
      denied.push({ target, reason: "self_dispatch_blocked" });
      continue;
    }

    if (allowed.length >= settings.maxTargetsPerRun) {
      denied.push({ target, reason: "max_targets_exceeded" });
      continue;
    }

    seen.add(uniqueKey);
    allowed.push(target);
  }

  return { allowed, denied };
}

function isAllowed(value: string, rawAllowlist: string): boolean {
  const allowlist = parseAllowlist(rawAllowlist);
  if (allowlist.size === 0) {
    return true;
  }
  return allowlist.has(value.toLowerCase());
}

function parseAllowlist(rawAllowlist: string): Set<string> {
  return new Set(
    rawAllowlist
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}
