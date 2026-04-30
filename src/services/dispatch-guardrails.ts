import { normalizeWorkflowName, type ResolvedDispatchTarget } from "../domain/trigger-matcher/match.js";
import type { WorkflowRunPayload } from "../github/types.js";

const allowlistCache = new Map<string, Set<string>>();
const ALLOWLIST_CACHE_MAX_SIZE = 16;

export type GuardrailSettings = {
  enforceSourceDefaultBranch: boolean;
  maxTargetsPerRun: number;
  sourceRepoAllowlist: string;
  targetRepoAllowlist: string;
  sourceWorkflowAllowlist: string;
  allowedSourceConclusions: string;
};

export type SourceGuardrailDeniedReason =
  | "source_not_default_branch"
  | "source_workflow_not_allowlisted"
  | "source_repo_not_allowlisted"
  | "source_from_fork"
  | "source_conclusion_not_allowed";

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

  const conclusion = payload.workflow_run.conclusion?.toLowerCase() ?? "";
  if (!isAllowed(conclusion, settings.allowedSourceConclusions)) {
    return { allowed: false, reason: "source_conclusion_not_allowed" };
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

    if (isSelfDispatch(normalizedSourceRepo, normalizedSourceWorkflow, normalizedTargetRepo, normalizedTargetWorkflow)) {
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
  const normalizedValue = value.toLowerCase();
  for (const pattern of allowlist) {
    if (matchesPattern(normalizedValue, pattern)) {
      return true;
    }
  }
  return false;
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return value === pattern;
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function isSelfDispatch(
  sourceRepo: string,
  sourceWorkflow: string,
  targetRepo: string,
  targetWorkflow: string,
): boolean {
  return sourceRepo === targetRepo && sourceWorkflow === targetWorkflow;
}

function parseAllowlist(rawAllowlist: string): Set<string> {
  const normalized = rawAllowlist.trim();
  const cached = allowlistCache.get(normalized);
  if (cached) {
    return cached;
  }

  const parsed = new Set(
    rawAllowlist
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowlistCache.size >= ALLOWLIST_CACHE_MAX_SIZE) {
    allowlistCache.clear();
  }
  allowlistCache.set(normalized, parsed);
  return parsed;
}
