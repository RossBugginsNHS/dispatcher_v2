# dispatcher_v2 Plan (TypeScript, Dispatching Only)

## 1. Goal and Scope

Build a new TypeScript version of dispatcher that keeps **dispatching** behavior from v1 and removes **all vending/provisioning** behavior.

Primary runtime model for v2:
- Run as a GitHub App backend for [org-repo-workflows-runner-alpha](https://github.com/apps/org-repo-workflows-runner-alpha).
- Deploy the service to AWS using Terraform-managed infrastructure.

### In Scope
- GitHub App webhook intake and validation.
- Handling `workflow_run` completed events.
- Reading `dispatching.yml` from source and target repositories.
- Matching outbound rules from source to inbound permissions in target.
- Triggering target workflows via GitHub Actions workflow dispatch.
- Recording success/failure outcomes (issue creation and/or logs).

### Out of Scope (Do Not Implement)
- `vending.yml` handling.
- Repository/team creation and management workflows.
- Terraform execution from webhook events.
- Any auto-repo creation demo logic from v1.

Note:
- Terraform **is required** for infrastructure deployment in this project.
- Terraform **must not** be triggered from runtime webhook handlers.
- AWS account IDs, role names/ARNs, and any deployment identity details are treated as sensitive operational data and must not be committed to source, plan documents, or checked-in configuration files.

## 2. Source of Truth from v1

Dispatching logic to carry forward is centered around:
- Workflow completion handling.
- Parsing and applying `dispatching.yml` rules.
- Cross-repo authorization through target `inbound` rules.
- Dispatch + issue side effects.

Anything related to `ProcessPushWebhookAsync` vending behavior and TF orchestration is intentionally excluded.

## 3. Target Architecture (v2)

## Runtime and Stack
- Node.js + TypeScript (strict mode).
- Fastify (preferred) or Express.
- GitHub APIs:
  - `@octokit/webhooks` for webhook verification.
  - `@octokit/app` for app auth and installation tokens.
  - `@octokit/rest` for contents, actions dispatch, and issues.
- YAML parsing with schema validation (e.g., `yaml` + `zod`).

## Suggested Module Structure
- `src/config/*`
- `src/github/auth/*`
- `src/github/webhook/*`
- `src/domain/dispatching-schema/*`
- `src/domain/trigger-matcher/*`
- `src/services/trigger-service/*`
- `src/services/dispatch-service/*`
- `src/services/issue-service/*`
- `src/app/*`

## 4. Configuration Contract

Environment variables (initial):
- `PORT`
- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG` (set to `org-repo-workflows-runner-alpha`)
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY` (PEM content)
- `LOG_LEVEL`
- `NODE_ENV`

Optional:
- `DEFAULT_DISPATCH_REF` (default `main`)
- `CREATE_ISSUES` (`true`/`false`)

Runtime configuration notes:
- Webhook endpoint path: `/webhooks/github`.
- GitHub App webhook URL must point to the AWS-hosted HTTPS endpoint using that path.
- Use AWS Secrets Manager or SSM Parameter Store for app secret/private key in deployed environments.

## 5. dispatching.yml Contract to Support

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: my-target-repo
        workflow: cd.yml

inbound:
  - source:
      repository: my-source-repo
      workflow: ci.yml
    targets:
      - workflow: cd.yml
```

Rules:
- Source repo defines outbound mappings.
- Target repo must explicitly allow inbound from that source repo/workflow to that target workflow.
- If target inbound does not allow it, dispatch must not run.

## 6. Delivery Milestones

## Milestone A: Project Foundation
Deliver:
- TS project scaffold with strict typing.
- Lint/format/test/build scripts.
- Health endpoint and structured logger.
- Dockerfile and `.env.example`.

Acceptance:
- `npm run build` passes.
- `npm test` passes.
- Local server starts cleanly.

## Milestone B: GitHub App Plumbing
Deliver:
- Webhook endpoint with signature validation.
- Route only `workflow_run` completed events to handler.
- Installation client creation from app credentials.

Acceptance:
- Invalid signature rejected.
- Valid payload accepted.
- Completed workflow event reaches service layer.

## Milestone C: Config Retrieval and Validation
Deliver:
- Fetch `dispatching.yml` from repository default branch.
- Parse YAML and validate schema using zod.
- Graceful behavior when file missing/invalid.

Acceptance:
- Valid config parsed and returned.
- Missing config handled as no-op.
- Invalid config produces clear log/error outcome.

## Milestone D: Trigger Matching and Authorization
Deliver:
- Match source workflow run to outbound entries.
- For each target, load target `dispatching.yml` inbound rules.
- Evaluate allow/deny decision.

Acceptance:
- Allowed targets are correctly identified.
- Denied targets are blocked with explicit reason.

## Milestone E: Execute Side Effects
Deliver:
- Dispatch target workflows using Actions API.
- Create issue/log records for success and denied/failure outcomes.
- Continue processing remaining targets on partial failure.

Acceptance:
- One target failure does not stop others.
- Dispatch uses correct owner/repo/workflow/ref.
- Success/failure outputs are auditable.

## Milestone F: Hardening and Release Readiness
Deliver:
- Correlation IDs and structured event logs.
- Retry/backoff for transient GitHub failures.
- CI pipeline with lint/typecheck/test/build.

Acceptance:
- CI green on pull requests.
- Container image builds and runs.
- End-to-end webhook test succeeds.

## Milestone G: AWS Terraform Infrastructure and Deployment
Deliver:
- Terraform project under `infrastructure/terraform`.
- Environment folders for at least `dev` and `prod` using shared modules.
- AWS hosting stack for a containerized webhook service (ECS Fargate + ALB recommended).
- Secure secret delivery for `GITHUB_WEBHOOK_SECRET` and `GITHUB_APP_PRIVATE_KEY`.
- HTTPS endpoint and DNS target for GitHub webhook configuration.
- CI deployment workflow for `terraform fmt`, `terraform validate`, `terraform plan`, and approved `terraform apply`.

Suggested AWS resources:
- ECR repository for service image.
- ECS cluster/service/task definition.
- Application Load Balancer + target group + listener.
- ACM certificate + Route53 record.
- IAM roles/policies for task execution and secret access.
- CloudWatch log group and retention settings.

Acceptance:
- `terraform validate` passes in each environment.
- `terraform plan` is clean/reviewable.
- Service is reachable via HTTPS endpoint.
- GitHub App webhook delivery to `/webhooks/github` succeeds from GitHub.
- Secrets are not hardcoded in Terraform state or source files.
- AWS account and role values are supplied only at runtime via local shell environment or CI secrets/variables, not in repository files.

## 7. Testing Strategy

## Unit Tests
- `dispatching.yml` schema validation.
- Outbound-to-inbound matching logic.
- Allow/deny decision matrix.

## Integration Tests
- Webhook verification + event routing.
- Mocked Octokit interactions for content fetch, dispatch, issues.

## Regression Guards
- Assert no vending-related routes/modules/config are present.
- Assert push-event vending behavior is absent.

## 8. AI Execution Workflow

Use small bounded prompts and verify each step before continuing.

Loop per task:
1. Ask AI for one milestone slice only.
2. Run lint/typecheck/tests.
3. Review generated changes for scope drift.
4. Merge only if dispatch-only constraints are preserved.

Reusable guardrail text for every AI prompt:
- "Implement dispatching only."
- "Do not add vending features."
- "Do not run Terraform/provisioning logic from webhook runtime code."
- "Terraform is allowed only for deployment infrastructure under infrastructure/terraform."

## 9. Suggested Prompt Sequence

1. "Scaffold a production-ready TypeScript webhook service with strict TS, linting, tests, Docker, and health endpoint. No business logic yet."
2. "Add GitHub webhook verification and route only workflow_run completed events to handler."
3. "Implement dispatching.yml fetch/parse/validation with zod and unit tests."
4. "Implement outbound/inbound authorization matching across source/target repos."
5. "Implement dispatch execution and issue creation with partial-failure tolerance."
6. "Add CI workflow for lint, typecheck, unit/integration tests, and build."
7. "Generate AWS Terraform for deploying the service (ECR, ECS Fargate, ALB, ACM/Route53, IAM, secrets integration) with dev/prod environments."
8. "Add deployment pipeline for image publish plus terraform validate/plan/apply with approval gates."

## 10. Definition of Done

- Feature parity with v1 dispatching behavior only.
- No vending/provisioning code paths exist.
- End-to-end dispatch from source workflow completion to target workflow trigger works.
- CI is green and deployment artifact (container) is ready.
- Service is deployed on AWS through Terraform-managed infrastructure.
- GitHub App `org-repo-workflows-runner-alpha` is configured to deliver webhooks successfully to the deployed endpoint.

---

## 11. Dashboard Data Policy (Mandatory)

To keep the admin dashboard fast and reliable at scale:

- Dashboard APIs must not perform runtime aggregations in the request path.
- Aggregations must be precomputed at write-time (projection updates) or via scheduled rollups.
- Dashboard endpoints must query only event-log indexes or projection keys.
- Any endpoint that merges buckets, scans-and-aggregates, or computes grouped metrics on read is a defect.

Immediate remediation requirement:

- Replace any remaining runtime aggregation paths with projection-backed reads before release.
