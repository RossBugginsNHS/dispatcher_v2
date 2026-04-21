export interface WorkflowRunPayload {
  installation?: { id: number };
  repository: {
    name: string;
    owner: { login: string };
  };
  workflow_run: {
    name: string | null;
    path: string;
    conclusion: string | null;
  };
}
