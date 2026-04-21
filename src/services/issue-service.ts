import type { FastifyBaseLogger } from "fastify";

import type { DeniedDispatchTarget } from "./authorization-service.js";
import type { DispatchExecutionResult } from "./dispatch-service.js";

export interface IssueClient {
  issues: {
    create(params: {
      owner: string;
      repo: string;
      title: string;
      body: string;
    }): Promise<unknown>;
  };
}

type DispatchIssueInput = {
  owner: string;
  repo: string;
  sourceWorkflow: string;
  sourceWorkflowPath: string;
  sourceRunId?: number;
  sourceRunUrl?: string;
  denied: DeniedDispatchTarget[];
  dispatches: DispatchExecutionResult[];
};

export async function createDispatchResultIssue(
  client: IssueClient,
  input: DispatchIssueInput,
  log: FastifyBaseLogger,
): Promise<void> {
  const successCount = input.dispatches.filter((result) => result.status === "success").length;
  const failedCount = input.dispatches.filter((result) => result.status === "failed").length;
  const deniedCount = input.denied.length;

  const title = `Dispatch results: ${input.sourceWorkflow} (success=${successCount}, failed=${failedCount}, denied=${deniedCount})`;
  const body = buildIssueBody(input);

  await client.issues.create({
    owner: input.owner,
    repo: input.repo,
    title,
    body,
  });

  log.info(
    {
      owner: input.owner,
      repo: input.repo,
      sourceWorkflow: input.sourceWorkflow,
      successCount,
      failedCount,
      deniedCount,
    },
    "Created dispatch result issue",
  );
}

function buildIssueBody(input: DispatchIssueInput): string {
  const lines: string[] = [];

  lines.push("## Source Workflow");
  lines.push(`- Workflow: ${input.sourceWorkflow}`);
  lines.push(`- Path: ${input.sourceWorkflowPath}`);
  if (input.sourceRunId !== undefined) {
    lines.push(`- Run ID: ${input.sourceRunId}`);
  }
  if (input.sourceRunUrl) {
    lines.push(`- Run URL: ${input.sourceRunUrl}`);
  }
  lines.push("");

  lines.push("## Dispatch Outcomes");
  if (input.dispatches.length === 0) {
    lines.push("- No dispatches attempted.");
  } else {
    for (const dispatch of input.dispatches) {
      const targetLabel = `${dispatch.target.owner}/${dispatch.target.repo} :: ${dispatch.target.workflow}`;
      if (dispatch.status === "success") {
        lines.push(`- SUCCESS ${targetLabel} (attempts=${dispatch.attempts})`);
      } else {
        lines.push(`- FAILED ${targetLabel} (attempts=${dispatch.attempts})`);
      }
    }
  }
  lines.push("");

  lines.push("## Authorization Denials");
  if (input.denied.length === 0) {
    lines.push("- None");
  } else {
    for (const denial of input.denied) {
      const targetLabel = `${denial.target.owner}/${denial.target.repo} :: ${denial.target.workflow}`;
      lines.push(`- DENIED ${targetLabel} (${denial.reason})`);
    }
  }

  return lines.join("\n");
}
