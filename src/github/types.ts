export interface WorkflowRunPayload {
  installation?: { id: number };
  repository: {
    name: string;
    owner: { login: string };
  };
  workflow_run: {
    id?: number;
    name: string | null;
    path: string;
    html_url?: string;
    head_branch?: string | null;
    conclusion: string | null;
  };
}
