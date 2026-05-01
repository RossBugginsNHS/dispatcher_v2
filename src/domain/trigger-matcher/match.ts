import type { DispatchingConfig } from "../dispatching-schema/schema.js";

export type ResolvedDispatchTarget = {
  owner: string;
  repo: string;
  workflow: string;
  ref?: string;
  inputs?: Record<string, string>;
};

export function matchOutboundTargets(
  config: DispatchingConfig,
  sourceOwner: string,
  workflowPath: string,
): ResolvedDispatchTarget[] {
  const sourceWorkflow = normalizeWorkflowName(workflowPath);

  return config.outbound
    .filter((rule) => normalizeWorkflowName(rule.source.workflow) === sourceWorkflow)
    .flatMap((rule) =>
      rule.targets.map((target) => {
        const { owner, repo } = parseRepositoryRef(target.repository, sourceOwner);
        return {
          owner,
          repo,
          workflow: normalizeWorkflowName(target.workflow),
          ...(target.ref !== undefined ? { ref: target.ref } : {}),
          ...(target.inputs !== undefined ? { inputs: target.inputs } : {}),
        };
      }),
    );
}

export function normalizeWorkflowName(workflow: string): string {
  const segments = workflow.split("/").filter(Boolean);
  if (segments.length === 0) {
    return workflow;
  }
  return segments[segments.length - 1];
}

function parseRepositoryRef(repository: string, defaultOwner: string): { owner: string; repo: string } {
  const parts = repository.split("/").filter(Boolean);

  if (parts.length === 2) {
    return { owner: parts[0], repo: parts[1] };
  }

  return {
    owner: defaultOwner,
    repo: repository,
  };
}
