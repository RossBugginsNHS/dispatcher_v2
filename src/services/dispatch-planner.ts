import { resolveInputs, type SourceContext } from "../domain/template-resolver/resolve.js";
import { type ResolvedDispatchTarget } from "../domain/trigger-matcher/match.js";
import { type FetchDispatchingConfigResult } from "../github/content.js";
import type { WorkflowRunPayload } from "../github/types.js";
import { authorizeDispatchTargets, type DeniedDispatchTarget } from "./authorization-service.js";
import { filterTargetsWithGuardrails, type GuardrailSettings } from "./dispatch-guardrails.js";

export type { SourceContext };

type PlanLogger = {
  warn(obj: object, msg: string): void;
};

export type PlanDispatchesInput = {
  candidates: ResolvedDispatchTarget[];
  sourceContext: SourceContext;
  sourceRepoFullName: string;
  sourceRepoName: string;
  sourceWorkflow: string;
  guardrailSettings: GuardrailSettings;
  loadTargetConfig: (owner: string, repo: string) => Promise<FetchDispatchingConfigResult>;
  log: PlanLogger;
};

export type PlanDispatchesResult = {
  allowed: ResolvedDispatchTarget[];
  denied: DeniedDispatchTarget[];
};

/**
 * Builds a SourceContext from the workflow_run portion of a GitHub webhook payload.
 * Used by both the server-mode handler and the Lambda planner to produce the same
 * context object from the same raw payload fields.
 */
export function buildSourceContext(
  payload: WorkflowRunPayload,
  sourceRepoFullName: string,
  sourceWorkflow: string,
): SourceContext {
  return {
    sha: payload.workflow_run.head_sha ?? "",
    head_branch: payload.workflow_run.head_branch ?? "",
    run_id: String(payload.workflow_run.id ?? ""),
    run_url: payload.workflow_run.html_url ?? "",
    repo: sourceRepoFullName,
    workflow: sourceWorkflow,
  };
}

/**
 * Core dispatch planning logic shared between the server-mode workflow-run handler and
 * the Lambda planner handler.
 *
 * Given a list of candidate dispatch targets (from outbound rule matching) and the
 * surrounding context, this function:
 *   1. Resolves template inputs against the source context.
 *   2. Filters targets using guardrail policies.
 *   3. Authorizes targets by checking inbound rules in the target repositories.
 *   4. Returns the final allowed and denied target lists.
 */
export async function planDispatches(input: PlanDispatchesInput): Promise<PlanDispatchesResult> {
  const { candidates, sourceContext, sourceRepoFullName, sourceRepoName, sourceWorkflow, guardrailSettings, loadTargetConfig, log } =
    input;

  // Resolve template inputs; targets whose inputs cannot be resolved are denied immediately.
  const resolvedCandidates: ResolvedDispatchTarget[] = [];
  const templateErrors: Array<{ target: ResolvedDispatchTarget; reason: string }> = [];

  for (const target of candidates) {
    const hasInputs = target.inputs !== undefined && Object.keys(target.inputs).length > 0;

    if (!hasInputs) {
      resolvedCandidates.push({
        owner: target.owner,
        repo: target.repo,
        workflow: target.workflow,
        ...(target.ref !== undefined ? { ref: target.ref } : {}),
      });
      continue;
    }

    const resolution = resolveInputs(target.inputs!, sourceContext);
    if ("error" in resolution) {
      templateErrors.push({ target, reason: resolution.error });
    } else {
      resolvedCandidates.push({ ...target, inputs: resolution.resolved });
    }
  }

  for (const { target, reason } of templateErrors) {
    log.warn({ target, reason }, "Dispatch denied: template resolution failed for target inputs");
  }

  const targetGuardrails = filterTargetsWithGuardrails(
    resolvedCandidates,
    sourceRepoFullName,
    sourceWorkflow,
    guardrailSettings,
  );

  const authorization = await authorizeDispatchTargets(
    targetGuardrails.allowed,
    sourceRepoFullName,
    sourceRepoName,
    sourceWorkflow,
    loadTargetConfig,
  );

  const templateDenied = templateErrors.map(({ target }) => ({
    target,
    reason: "inputs_template_error" as const,
  }));

  return {
    allowed: authorization.allowed,
    denied: [...templateDenied, ...targetGuardrails.denied, ...authorization.denied],
  };
}
