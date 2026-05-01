import { type FetchDispatchingConfigResult } from "../github/content.js";
import { normalizeWorkflowName, type ResolvedDispatchTarget } from "../domain/trigger-matcher/match.js";

export type DeniedDispatchTarget = {
  target: ResolvedDispatchTarget;
  reason:
    | "missing_target_config"
    | "invalid_target_config"
    | "inbound_not_authorized"
    | "inputs_not_accepted"
    | "inputs_template_error"
    | "target_repo_not_allowlisted"
    | "self_dispatch_blocked"
    | "duplicate_target"
    | "max_targets_exceeded";
};

export async function authorizeDispatchTargets(
  candidates: ResolvedDispatchTarget[],
  sourceRepoFullName: string,
  sourceRepoName: string,
  sourceWorkflow: string,
  loadTargetConfig: (owner: string, repo: string) => Promise<FetchDispatchingConfigResult>,
): Promise<{ allowed: ResolvedDispatchTarget[]; denied: DeniedDispatchTarget[] }> {
  const allowed: ResolvedDispatchTarget[] = [];
  const denied: DeniedDispatchTarget[] = [];

  for (const target of candidates) {
    const targetConfig = await loadTargetConfig(target.owner, target.repo);

    if (!targetConfig.found) {
      denied.push({
        target,
        reason: targetConfig.reason === "missing" ? "missing_target_config" : "invalid_target_config",
      });
      continue;
    }

    const authResult = checkInboundAuthorization(
      targetConfig.config,
      sourceRepoFullName,
      sourceRepoName,
      sourceWorkflow,
      target.workflow,
      target.inputs,
    );

    if (authResult !== "authorized") {
      denied.push({ target, reason: authResult });
      continue;
    }

    allowed.push(target);
  }

  return { allowed, denied };
}

type AuthorizationResult = "authorized" | "inbound_not_authorized" | "inputs_not_accepted";

function checkInboundAuthorization(
  targetConfig: {
    inbound: Array<{
      source: { repository: string; workflow: string };
      targets: Array<{ workflow: string; accept_inputs?: string[] }>;
    }>;
  },
  sourceRepoFullName: string,
  sourceRepoName: string,
  sourceWorkflow: string,
  targetWorkflow: string,
  sentInputs: Record<string, string> | undefined,
): AuthorizationResult {
  const normalizedSourceWorkflow = normalizeWorkflowName(sourceWorkflow);
  const normalizedTargetWorkflow = normalizeWorkflowName(targetWorkflow);

  for (const rule of targetConfig.inbound) {
    const sourceRepositoryMatches =
      rule.source.repository === sourceRepoName || rule.source.repository === sourceRepoFullName;

    if (!sourceRepositoryMatches) {
      continue;
    }

    if (normalizeWorkflowName(rule.source.workflow) !== normalizedSourceWorkflow) {
      continue;
    }

    const matchingTarget = rule.targets.find(
      (allowedTarget) => normalizeWorkflowName(allowedTarget.workflow) === normalizedTargetWorkflow,
    );

    if (!matchingTarget) {
      continue;
    }

    // Rule found — check inputs acceptance
    const sentKeys = sentInputs !== undefined ? Object.keys(sentInputs) : [];

    if (sentKeys.length > 0) {
      // Inputs are being sent: the target must explicitly declare accept_inputs
      if (matchingTarget.accept_inputs === undefined) {
        return "inputs_not_accepted";
      }

      const acceptedSet = new Set(matchingTarget.accept_inputs);
      for (const key of sentKeys) {
        if (!acceptedSet.has(key)) {
          return "inputs_not_accepted";
        }
      }
    }

    return "authorized";
  }

  return "inbound_not_authorized";
}
