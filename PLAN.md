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

## 11. Phase 4 — Rich Admin Portal + Observability

### Context

Following successful deployment of the async pipeline (CloudEvents, DynamoDB event store, basic admin Lambda), the admin portal needs to become a genuine operational health + MI/BI tool.

### Goals

1. **Rich admin dashboard** — health banner, dispatch funnel, per-repo stats, recent events feed, journey explorer, container version display.
2. **Container version in events** — `appversion` field added to all CloudEvents; shown in the UI and queryable.
3. **Event journey tracing** — search any `deliveryId` to see its full event timeline with traceparent links.
4. **Health signals from event ratios** — GREEN/AMBER/RED derived from success rate and pipeline staleness, not raw infra metrics.
5. **AWS X-Ray active tracing** — all 6 Lambda functions + IAM permissions.
6. **CloudWatch dashboard** — Lambda duration/errors, SQS depth, DynamoDB ops; low-level infrastructure view.
7. **API Gateway access logging** — structured access logs to CloudWatch.

### Implementation Tasks

#### Task 1 — `appversion` in CloudEvents
- Add `appversion?: string` to the `CloudEvent` type in `src/async/cloudevents.ts`.
- Auto-populate from `process.env.APP_VERSION ?? "unknown"` in `makeCloudEvent`.
- Terraform: extract image tag from `var.lambda_image_uri` as `local.lambda_image_tag`; inject as `APP_VERSION` into every Lambda environment block.

#### Task 2 — GSI2 on `dispatch_events` for deliveryId journey queries
- Add `gsi2pk = "delivery#<deliveryId>"` and `gsi2sk = "<time>#<eventId>"` to `StoredDispatchEvent`.
- Populate these in `appendDispatchEvent`.
- Terraform: add `gsi2pk`/`gsi2sk` attributes and a new GSI (`gsi2`) to `aws_dynamodb_table.dispatch_events`. DynamoDB supports adding GSIs without table recreation.

#### Task 3 — Event-store enrichment
- `readRecentEvents(ddb, eventsTableName, limit)` — query GSI1 (`gsi1pk = "all"`, ScanIndexForward=false, Limit=N) to return the latest N events.
- `readJourneyByDeliveryId(ddb, eventsTableName, deliveryId)` — query GSI2 (`gsi2pk = "delivery#<id>"`) to return all events for a delivery in time order.
- `updateDispatchProjections` enrichment — additionally write:
  - `pk = "delivery#<deliveryId>", sk = "funnel"` with stage flags and timestamps for funnel tracking.
  - `pk = "hour#<YYYYMMDDHH>", sk = "global"` with per-type counters for hourly rate calculation.
- `readHourlyStats(ddb, projectionsTableName, hours)` — read recent hourly buckets.
- `readPerRepoStats(ddb, projectionsTableName)` — Scan projections table filtering `begins_with(pk, "repo#")`.
- `computeHealthStatus(summary, hourlyStats)` — pure function deriving GREEN/AMBER/RED from success rate and recency.

#### Task 4 — New admin API endpoints (`admin-observability-handler.ts`)
- Route: `GET /admin/api/{proxy+}` handled by same Lambda.
- `GET /admin/api/health` → `{ status, reasons, successRate, eventsLastHour, lastEventAt }`.
- `GET /admin/api/summary` → extended summary with hourly stats.
- `GET /admin/api/repos` → per-repo stats array.
- `GET /admin/api/recent-events` → last 50 events (via GSI1).
- `GET /admin/api/journey?deliveryId=xxx` → all events for that delivery (via GSI2).
- Lambda also needs `DISPATCH_EVENTS_TABLE_NAME` env var (add to Terraform).

#### Task 5 — Rich admin UI
HTML served from `GET /admin`:
- Health status banner (colour-coded with reason text).
- Key metrics row: requests accepted, plans created, targets queued, succeeded, failed, success rate %.
- Dispatch funnel bar chart (stage counts as percentage of requests).
- Per-repo table: last-seen time, total events, success rate, version.
- Recent events feed with event type badge, repo, version, traceparent, time.
- Journey explorer: free-text deliveryId input → timeline of events.
- Container version info panel.
- Auto-refresh every 30 s (toggle).

#### Task 6 — Terraform: X-Ray active tracing
- Add `tracing_config { mode = "Active" }` block to all 6 Lambda functions.
- Add X-Ray IAM statement to `lambda_runtime` policy:
  `xray:PutTraceSegments`, `xray:PutTelemetryRecords`, `xray:GetSamplingRules`, `xray:GetSamplingTargets`.

#### Task 7 — Terraform: CloudWatch log groups + dashboard
- Explicit `aws_cloudwatch_log_group` for each Lambda (`/aws/lambda/<name>`, 30-day retention).
- `aws_cloudwatch_dashboard` with widgets: Lambda invocations+errors, Lambda duration p50/p99, SQS queue depths (4 queues), DynamoDB read/write ops, API GW 4xx/5xx.
- API Gateway access log group + `access_log_settings` on the `$default` stage.

#### Task 8 — API Gateway route for `/admin/api/*`
- Add `GET /admin/api/{proxy+}` route pointing to existing `lambda_admin_observability` integration.
- Add Lambda permission with `source_arn = .../*/GET/admin/api/*`.

#### Task 9 — Deploy
1. `npm run build` — verify clean compile.
2. `terraform validate` in dev environment.
3. `./scripts/apply-dev-infra.sh` — deploy all changes.
4. Smoke-test new endpoints: `/admin`, `/admin/api/health`, `/admin/api/summary`, `/admin/api/recent-events`.

### Acceptance Criteria

- `GET /admin` returns rich HTML dashboard; health banner shows GREEN/AMBER/RED.
- `GET /admin/api/health` returns `{ status: "green"|"amber"|"red"|"unknown", ... }`.
- `GET /admin/api/journey?deliveryId=<id>` returns ordered event list after next real dispatch.
- All Lambda functions appear in X-Ray Service Map after invocation.
- CloudWatch dashboard exists and displays Lambda/SQS/DynamoDB metrics.
- CloudEvents contain `appversion` field matching deployed image tag.
- No breaking changes to existing endpoints or event schema.

---

## 12. Phase 5 — Interactive Dashboard Product Plan (Operational + MI)

### Why this phase

The dashboard now exposes meaningful data, but it still behaves like a static readout. Next step is to make it decision-oriented:
- Fast triage for operators asking "is dispatch working right now?"
- Fast drilldown for managers asking "what is trending by repo/team over time?"

### Product split: two clear modes

#### A. Operations Mode (real-time reliability)
Primary question: **Is the pipeline healthy right now?**

Core indicators (top of page):
- Health status (GREEN/AMBER/RED) with explicit reason chips.
- Last event recency and event throughput (5m, 15m, 60m).
- Dispatch success rate and failure rate (rolling 60m).
- Stall detectors:
  - requests accepted minus plans created
  - queued targets minus triggered outcomes
- Error budget panel: failed triggers in last 15m/60m.

Core interactions:
- Click source repo to filter all widgets/tables.
- Click target repo to filter all widgets/tables.
- Click event type badges to toggle event-type filters.
- Click health reason chip to open pre-filtered recent events list.
- Click a recent event row to open delivery journey side panel.

#### B. Management Intelligence Mode (trends and planning)
Primary question: **What changed across repos and time?**

Core visuals:
- Time-series trend for requests, plans, queued, succeeded, failed.
- Conversion funnel trend (hourly buckets).
- Top movers table (largest increase/decrease in traffic or failure rate).
- Repository leaderboard by:
  - volume
  - success rate
  - median completion time (when available)
- Version split chart (`appversion`) to detect version-linked regressions.

Core interactions:
- Time range selector: 15m, 1h, 6h, 24h, 7d.
- Group by selector: source repo, target repo, workflow.
- Compare mode: pin two repos or two versions.
- Export current filtered view as JSON/CSV.

### Data discipline and API contract direction

Current state (confirmed):
- Event log reads: `recent-events`, `journey`.
- Projection reads: `health/summary`, `repos`, `failures`, `top repos`.
- Some lightweight runtime aggregation still happens:
  - minute-bucket merge in `readTopReposLastMinutes`
  - scan + sort in `readPerRepoStats`

Target rule for Phase 5:
- **No runtime aggregations in dashboard request paths**.
- Keep APIs query-only over pre-aggregated partitions/items.
- Move all aggregation logic to write-time projection updates or scheduled rollups.
- If any endpoint still aggregates at request time, that is treated as a defect and must be remediated before release.

Required projection additions:
- `pk=window#<range>#<dimension>`, `sk=<key>` style materialized counters.
- `pk=trend#hour#<dimension>`, `sk=<timestamp>` for graph points.
- `pk=repo#<name>`, `sk=kpi#<window>` for hot KPIs.
- Optional: dedicated projection table if partition pressure increases.

### Interaction model (UI behavior spec)

Global filter state:
- `sourceRepo[]`
- `targetRepo[]`
- `eventType[]`
- `status[]` (success/failed/other)
- `timeRange`

Rules:
- Any click creates or refines global filter state.
- All widgets subscribe to the same filter state.
- URL query string mirrors filters for shareable views.
- "Reset filters" always one click away.

### API roadmap

#### Keep
- `GET /admin/api/health`
- `GET /admin/api/recent-events`
- `GET /admin/api/journey?deliveryId=...`

#### Add (phase 5)
- `GET /admin/api/filters/options` (repos, workflows, event types)
- `GET /admin/api/trends?range=...&groupBy=...&filters=...`
- `GET /admin/api/funnel?range=...&filters=...`
- `GET /admin/api/repos/kpis?range=...&sort=...&filters=...`
- `GET /admin/api/events/search?...` (server-side pagination + filters)

All new endpoints should read from event log indexes or projection items only, with no full-table scans in normal traffic.

### Delivery plan

1. **Phase 5A: UX skeleton + shared filters**
- Add filter bar and interactive click-to-filter behavior.
- Wire existing endpoints to respect filters where possible.

2. **Phase 5B: Projection-first analytics backend**
- Add new projection shapes and update writer path.
- Add trend/funnel KPI endpoints backed by projection keys.

3. **Phase 5C: Operations/MI mode split**
- Add mode toggle tabs.
- Curate cards and tables separately for each mode.

4. **Phase 5D: Performance and quality**
- API p95 target for dashboard reads.
- Synthetic tests for filter combinations.
- Verify no endpoint performs unbounded scan in hot paths.

### Definition of Useful Dashboard (Phase 5 DoD)

- Operator can identify failing repo/version and open related journey in under 3 clicks.
- Manager can compare two repos or versions over selected range in under 4 clicks.
- Dashboard state is shareable via URL with full filters.
- Dashboard APIs remain stable under load without runtime heavy aggregation.
- Operational and MI views are visibly distinct and purpose-focused.
