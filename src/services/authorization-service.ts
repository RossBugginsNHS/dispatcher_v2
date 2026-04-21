import { type FetchDispatchingConfigResult } from "../github/content.js";
import { normalizeWorkflowName, type ResolvedDispatchTarget } from "../domain/trigger-matcher/match.js";

export type DeniedDispatchTarget = {
  target: ResolvedDispatchTarget;
  reason: "missing_target_config" | "invalid_target_config" | "inbound_not_authorized";
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

    if (
      !isInboundAuthorized(
        targetConfig.config,
        sourceRepoFullName,
        sourceRepoName,
        sourceWorkflow,
        target.workflow,
      )
    ) {
      denied.push({
        target,
        reason: "inbound_not_authorized",
      });
      continue;
    }

    allowed.push(target);
  }

  return { allowed, denied };
}

function isInboundAuthorized(
  targetConfig: { inbound: Array<{ source: { repository: string; workflow: string }; targets: Array<{ workflow: string }> }> },
  sourceRepoFullName: string,
  sourceRepoName: string,
  sourceWorkflow: string,
  targetWorkflow: string,
): boolean {
  const normalizedSourceWorkflow = normalizeWorkflowName(sourceWorkflow);
  const normalizedTargetWorkflow = normalizeWorkflowName(targetWorkflow);

  return targetConfig.inbound.some((rule) => {
    const sourceRepositoryMatches =
      rule.source.repository === sourceRepoName || rule.source.repository === sourceRepoFullName;

    if (!sourceRepositoryMatches) {
      return false;
    }

    if (normalizeWorkflowName(rule.source.workflow) !== normalizedSourceWorkflow) {
      return false;
    }

    return rule.targets.some(
      (allowedTarget) => normalizeWorkflowName(allowedTarget.workflow) === normalizedTargetWorkflow,
    );
  });
}
