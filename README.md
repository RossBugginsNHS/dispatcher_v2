# GitHub Workflow Dispatcher

A GitHub App backend service for **cross-repository workflow dispatching**. When a workflow completes in a source repository, GitHub Workflow Dispatcher reads `dispatching.yml` configuration files, authorises eligible targets, and triggers matching workflows in those target repositories via the GitHub Actions workflow dispatch API.

This is a rewrite of dispatcher v1 focused exclusively on dispatching behaviour. All repository vending, provisioning, and Terraform-execution-from-webhooks behaviour has been removed.

---

## Table of Contents

- [Requirements](#requirements)
  - [Functional Requirements](#functional-requirements)
  - [Non-Functional Requirements](#non-functional-requirements)
- [How It Works](#how-it-works)
- [dispatching.yml Contract](#dispatchingyml-contract)
- [Architecture](#architecture)
  - [Lambda Functions](#lambda-functions)
  - [AWS Infrastructure](#aws-infrastructure)
  - [Event and Projection Model](#event-and-projection-model)
- [Admin Observability Dashboard](#admin-observability-dashboard)
- [Local Development](#local-development)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
  - [CI/CD Pipeline](#cicd-pipeline)
  - [Manual Dev Deploy](#manual-dev-deploy)
- [Infrastructure (Terraform)](#infrastructure-terraform)
- [Testing](#testing)
- [Repository Structure](#repository-structure)

---

## Requirements

### Functional Requirements

These requirements define what the system must do.

#### FR-01 — Cross-repository workflow dispatch
The service must trigger target workflows in other repositories when a source workflow run completes, using the GitHub Actions `workflow_dispatch` API.

#### FR-02 — Bilateral YAML authorisation
A dispatch must only proceed when **both** sides explicitly declare the relationship: the source repository's `dispatching.yml` must list the target in `outbound`, and the target repository's `dispatching.yml` must list the source in `inbound`. Either side may block the dispatch unilaterally by withholding or removing its entry.

#### FR-03 — Source conclusion filtering
Dispatches must only fire for workflow runs that completed with an explicitly permitted conclusion. The default permitted conclusion is `success`. Operators may extend this list (e.g. `success,skipped`) or clear it to allow all conclusions. Runs with any other conclusion (e.g. `failure`, `cancelled`) must be silently dropped without triggering any dispatch.

#### FR-04 — Source branch enforcement
By default, dispatches must only be triggered by runs on the source repository's default branch. This behaviour is configurable and can be disabled for testing environments.

#### FR-05 — Fork-sourced run rejection
Workflow runs originating from a fork (i.e. `head_repository` differs from the source repository) must be rejected to prevent untrusted contributors from influencing cross-repository dispatch.

#### FR-06 — Per-target ref override
Each outbound target in `dispatching.yml` may optionally specify a `ref` (branch, tag, or SHA) to dispatch to. When a `ref` is provided on a target, it overrides the source run's `head_branch`. When omitted, the source run's `head_branch` is used, falling back to `DEFAULT_DISPATCH_REF`.

#### FR-07 — Allowlist filtering with wildcard support
Operators may restrict which source repositories, target repositories, and source workflow files participate in dispatching using comma-separated allowlists. Entries support `*` wildcard patterns (e.g. `my-org/*` to allow all repositories in an organisation). An empty allowlist means all values are permitted.

#### FR-08 — Self-dispatch prevention
A workflow must not be able to trigger itself via its own `dispatching.yml` rules. The system must block any target that resolves to the same repository and workflow as the source.

#### FR-09 — Duplicate target suppression
If multiple outbound rules resolve to the same `owner/repo#workflow` combination, only the first occurrence is dispatched. Subsequent duplicates are silently denied.

#### FR-10 — Maximum targets per run
A single source workflow run must not dispatch to more than `DISPATCH_MAX_TARGETS_PER_RUN` targets (default 25). Targets exceeding this cap are denied.

#### FR-11 — Dispatch retry with exponential backoff
Transient failures from the GitHub API (HTTP 429, 5xx, network resets) must be retried up to `DISPATCH_MAX_RETRIES` times using exponential backoff. Permanent errors must be recorded and processing must continue for remaining targets.

#### FR-12 — Partial-failure tolerance
The failure of one dispatch target must not prevent other targets in the same run from being attempted.

#### FR-13 — Webhook signature verification
All incoming webhooks must be verified using HMAC-SHA256 against the configured `GITHUB_WEBHOOK_SECRET`. Requests with an invalid or missing signature must be rejected with `401 Unauthorized`.

#### FR-14 — Replay attack prevention
Duplicate webhook deliveries identified by `x-github-delivery` must be rejected with `409 Conflict` within a configurable replay window (default 10 minutes).

#### FR-15 — Rate limiting
The webhook endpoint must enforce a rate limit (default 100 requests per minute per source IP). Requests exceeding the limit must receive `429 Too Many Requests`.

#### FR-16 — Observability event stream
Every significant step in a dispatch (request accepted, plan created, target queued, trigger succeeded/failed) must be published as a structured CloudEvent to an EventBridge bus for downstream consumption and audit.

#### FR-17 — Admin observability dashboard
The system must serve a self-contained HTML dashboard with health status, funnel metrics, delivery latency percentiles, per-repo statistics, hourly trend charts, and a delivery journey explorer, backed by pre-computed DynamoDB projections.

#### FR-18 — Health endpoint
A `/health` endpoint must be available at all times and must return `{"status":"ok"}` with HTTP `200` to support load balancer and monitoring probes.

---

### Non-Functional Requirements

These requirements define how the system must perform and behave.

#### NFR-01 — Availability
The service must be highly available. Lambda-based deployment across AWS AZs provides automatic redundancy. The SQS buffers between stages decouple availability from upstream and downstream transient outages.

#### NFR-02 — Performance
- Ingress Lambda must respond within **500 ms** for valid payloads (signature verification + SQS enqueue).
- Planner and dispatcher Lambdas must process a standard workflow run (1–5 targets) end-to-end within **30 seconds** under normal GitHub API latency.
- Admin dashboard projections must be served from DynamoDB reads with **no runtime aggregation** — all metrics must be pre-computed at write time.

#### NFR-03 — Scalability
The asynchronous Lambda/SQS/EventBridge architecture must scale horizontally without code changes. SQS batch processing and Lambda concurrency scaling handle burst traffic automatically.

#### NFR-04 — Reliability
- Failed dispatch attempts must be retried with exponential backoff.
- Messages that exhaust all retries must be routed to a Dead Letter Queue (DLQ) for manual inspection and replay.
- No dispatch event must be permanently lost under transient AWS or GitHub API failures.

#### NFR-05 — Security — least-privilege
- GitHub App installation tokens must be scoped per installation.
- Lambda execution roles must follow least-privilege IAM principles.
- CI/CD workflow jobs must declare minimum token permissions.
- Credentials must never be committed to source; secrets must be stored in AWS Secrets Manager.

#### NFR-06 — Security — input validation
- All `dispatching.yml` files must be parsed through a strict Zod schema. Unknown or duplicate YAML keys must be rejected.
- Webhook payloads must be validated for required fields before any business logic is executed.
- Allowlists, guardrails, and inbound/outbound YAML rules provide layered defence-in-depth against misconfigured or malicious dispatch chains.

#### NFR-07 — Security — supply chain
- Docker base images must be pinned to immutable SHA256 digests.
- GitHub Actions must be pinned to full commit SHAs (not mutable tags).
- ECR image tag mutability must be set to `IMMUTABLE`.
- Dependabot must be configured for npm, Docker, GitHub Actions, and Terraform providers.

#### NFR-08 — Auditability
- Every dispatch fact must be persisted as an immutable CloudEvent in DynamoDB with a retention period.
- CloudWatch log groups for all Lambda functions must have explicit 90-day retention.
- API Gateway access logging must be enabled for HTTP-level audit.

#### NFR-09 — Maintainability
- The codebase must pass TypeScript strict-mode compilation with no type errors.
- ESLint and Prettier must pass cleanly on every commit.
- All public-facing behaviour changes must be accompanied by Vitest unit tests.
- Infrastructure must be managed exclusively through Terraform; no manual resource creation in AWS.

#### NFR-10 — Testability
- Core business logic (schema parsing, rule matching, authorisation, guardrail evaluation, dispatch execution) must be independently unit-testable without AWS or GitHub connectivity.
- Integration concerns (webhook verification, Lambda handlers) must be testable with lightweight mocks and Fastify `inject`.

#### NFR-11 — Observability
- Structured JSON logs (Pino) must be emitted at configurable log levels.
- Every webhook delivery must carry a `correlationId` (the GitHub delivery ID) propagated through all log lines.
- Admin dashboard must surface health status as green/amber/red based on configurable success-rate and latency thresholds.

#### NFR-12 — Configuration
- All runtime behaviour must be configurable through environment variables validated at startup.
- Default values must be safe for production use without explicit overrides.
- Sensitive values must never be logged.

---

## How It Works

1. A GitHub workflow completes in a **source repository**.
2. GitHub sends a `workflow_run` webhook to the dispatcher ingress endpoint.
3. The ingress Lambda verifies the webhook signature and enqueues the payload to an SQS queue.
4. The **planner** Lambda consumes the queue, reads `dispatching.yml` from the source repo, reads `dispatching.yml` from each candidate target repo to verify inbound permissions, and enqueues authorised dispatch work items.
5. The **dispatcher** Lambda consumes those work items and calls the GitHub Actions workflow dispatch API for each target, with retry/backoff.
6. Facts about each step (request accepted, plan created, targets queued, trigger succeeded/failed) are published to an EventBridge event bus.
7. The **facts processor** Lambda consumes EventBridge events and writes them into two DynamoDB tables (raw event store and pre-computed projections).
8. The **admin observability** Lambda serves a web dashboard and JSON APIs that read those projections to show health, funnel metrics, per-repo stats, hourly trends, and delivery timelines.

---

## dispatching.yml Contract

Each repository places a `dispatching.yml` file at the root of the default branch (or at `.github/dispatching.yml`). The schema supports two top-level keys: `outbound` and `inbound`.

```yaml
# Source repository: declares which target workflows to trigger
outbound:
  - source:
      workflow: ci.yml          # workflow in this repo that triggers dispatch
    targets:
      - repository: org/target-repo
        workflow: cd.yml        # workflow to trigger in the target repo
        ref: release            # optional: override the ref to dispatch to (defaults to source head_branch)

# Target repository: declares which sources are permitted to trigger it
inbound:
  - source:
      repository: org/source-repo
      workflow: ci.yml
    targets:
      - workflow: cd.yml
```

**Authorization is bilateral.** A dispatch only proceeds if:
- The source repo's `outbound` rule names the target repo and workflow.
- The target repo's `inbound` rule explicitly permits that source repo and workflow.

Missing or invalid `dispatching.yml` files are treated as having no rules (no-op, not an error).

### Per-target `ref` override

Each outbound target may include an optional `ref` field. When present, the dispatcher uses this ref instead of the source run's `head_branch` when calling `workflow_dispatch`. This is useful for pinning a deployment target to a stable release branch regardless of where CI ran.

---

## Architecture

```
GitHub webhook
      │
      ▼
┌─────────────────┐
│  ingress Lambda │  Verifies signature → SQS dispatch-requests
└─────────────────┘
      │
      ▼
┌─────────────────┐
│  planner Lambda │  Reads dispatching.yml (source + targets) → SQS dispatch-targets
└─────────────────┘
      │
      ▼
┌──────────────────┐
│ dispatcher Lambda│  Calls GitHub workflow_dispatch API (with retry)
└──────────────────┘
      │
      ▼ (all stages publish facts)
┌──────────────────────┐
│  EventBridge bus     │
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│ facts-processor      │  Writes raw events + updates projections → DynamoDB
│ Lambda               │
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  admin Lambda        │  Serves dashboard HTML + JSON APIs from DynamoDB
└──────────────────────┘
```

### Lambda Functions

| Function | Handler | Trigger | Purpose |
|---|---|---|---|
| `ingress` | `dist/lambda/ingress-handler.handler` | API Gateway (POST /webhooks/github) | Validates GitHub webhook HMAC; enqueues payload to `dispatch-requests` SQS queue |
| `planner` | `dist/lambda/planner-handler.handler` | SQS (`dispatch-requests`) | Reads `dispatching.yml` from source + target repos; authorises targets; enqueues work to `dispatch-targets` |
| `dispatcher` | `dist/lambda/dispatcher-handler.handler` | SQS (`dispatch-targets`) | Calls `workflow_dispatch` GitHub API for each authorised target; retries with exponential backoff |
| `facts-processor` | `dist/lambda/facts-processor-handler.handler` | EventBridge rule | Appends CloudEvent to the events DynamoDB table; updates pre-computed projections |
| `admin` | `dist/lambda/admin-observability-handler.handler` | API Gateway (`/admin/*`) | Serves the HTML dashboard and all `/admin/api/*` JSON endpoints |

All five functions use the **same Docker image** built from the repository root. Terraform sets the per-function entry point via `image_config.command`.

### AWS Infrastructure

| Resource | Purpose |
|---|---|
| ECR repository | Stores built Docker images; keeps the last 30 |
| API Gateway v2 (HTTP) | Routes `/webhooks/github`, `/health`, and `/admin/*` to the appropriate Lambda functions |
| SQS `dispatch-requests` | Buffer between ingress and planner (DLQ after 5 receives) |
| SQS `dispatch-targets` | Buffer between planner and dispatcher (DLQ after 5 receives) |
| EventBridge custom bus | `dispatch-facts` bus receives domain events from planner, dispatcher, and facts-processor |
| DynamoDB `dispatch-events` | Immutable append-only event store with GSI support for delivery-ID and repo lookups |
| DynamoDB `dispatch-projections` | Pre-computed read models: summary counters, per-repo stats, hourly buckets, delivery funnels |
| IAM role `{prefix}-lambda` | Shared execution role for all five Lambda functions |
| Secrets Manager | Stores GitHub webhook secret and app private key (managed or externally provided) |
| CloudWatch Log Groups | One per Lambda function |

### Event and Projection Model

Facts are structured as **CloudEvents** with `detail-type` values:

| Fact | When emitted |
|---|---|
| `dispatch.request.accepted` | Ingress has validated and enqueued a webhook |
| `dispatch.plan.created` | Planner has resolved authorised targets (0 or more) |
| `dispatch.target.queued` | A single dispatch work item has been enqueued |
| `dispatch.trigger.succeeded` | GitHub workflow_dispatch API call succeeded |
| `dispatch.trigger.failed` | All retry attempts for a dispatch exhausted |

The facts-processor writes each event to a DynamoDB table with a composite key `pk = EVENT#{type}#{hour}` / `sk = {deliveryId}#{eventId}`, and maintains pre-aggregated projections for:

- **Summary counters** — total events, accepted, plan created, queued, succeeded, failed
- **Per-repo statistics** — counts broken down by source repository
- **Hourly trend buckets** — counts bucketed by UTC hour for chart rendering
- **Delivery funnels** — per-delivery-id record tracking each stage timestamp and outcome

---

## Admin Observability Dashboard

The admin Lambda serves a self-contained dashboard at `/admin` (no external dependencies, pure HTML/CSS/JS).

### Dashboard Sections

- **Health banner** — green/amber/red status with human-readable reasons
- **Summary cards** — total events, accepted, queued targets, succeeded, failed
- **Delivery funnel bar chart** — shows drop-off at each pipeline stage
- **Delivery latency cards** — P50, P95, and average seconds from accepted to trigger
- **Hourly trend table** — succeeded and failed counts per UTC hour
- **Per-repo stats table** — success rate pill per source repository
- **Recent deliveries** — last N deliveries with source/target repo chip labels and status badges
- **Journey explorer** — enter a delivery ID to trace all events for a single dispatch

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Lambda liveness check (`{"status":"ok"}`) |
| `GET` | `/admin` | HTML dashboard |
| `GET` | `/admin/api/health` | JSON health report (status, reasons, checks, latency) |
| `GET` | `/admin/projections` | Full projections payload (summary, recentDeliveries, hourlyTrend, latency) |
| `GET` | `/admin/api/repos` | Per-repository statistics array |
| `GET` | `/admin/api/recent-events` | Raw recent CloudEvents |
| `GET` | `/admin/api/journey?deliveryId=<id>` | All events for a single delivery ID |

Health checks include: success rate, dispatch backlog depth, recent failures, data freshness, and latency threshold.

---

## Local Development

### Prerequisites

- Node.js 22 (see `mise.toml`)
- npm
- A GitHub App with a webhook secret and private key

> **Tool version management:** This project uses [`mise`](https://mise.jdx.dev/) for managing local tool versions.
> `mise` verifies tool downloads via checksums and fetches from official sources, providing stronger
> supply-chain guarantees than `asdf`. Install `mise` by following the
> [official installation guide](https://mise.jdx.dev/getting-started.html), then run `mise install`
> in the project root to install the pinned versions of Node.js and Terraform defined in `mise.toml`.

### Setup

```bash
git clone https://github.com/RossBugginsNHS/github-workflow-dispatcher
cd github-workflow-dispatcher
npm install
cp .env.example .env
# Edit .env with your GitHub App credentials and any optional settings
```

### Run in development mode

```bash
npm run dev
```

The Fastify server starts on `PORT` (default `3000`) with hot-reload via `tsx watch`.

Available local endpoints:

- `GET /health`
- `GET /version`
- `POST /webhooks/github`
- `GET /admin/installations`
- `GET /admin/logs`

> Note: The full async pipeline (SQS → EventBridge → DynamoDB) only runs in AWS. Locally, webhook events are handled synchronously by the in-process `WorkflowRunHandler` and an in-memory event store.

### Build

```bash
npm run build        # compiles TypeScript to dist/
npm run lint         # ESLint
npm run test         # Vitest (run once)
npm run test:watch   # Vitest (watch mode)
npm run format       # Prettier
```

---

## Environment Variables

All variables are validated at startup via `zod`. Unknown variables are ignored.

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port (local Fastify mode only) |
| `LOG_LEVEL` | No | `info` | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `APP_VERSION` | No | `local` | Build version string, injected by CI |
| `GITHUB_APP_ID` | Yes (runtime) | — | GitHub App numeric ID |
| `GITHUB_WEBHOOK_SECRET` | Conditional | — | Webhook HMAC secret (plain text, or set `_ARN` instead) |
| `GITHUB_WEBHOOK_SECRET_ARN` | Conditional | — | AWS Secrets Manager ARN for webhook secret |
| `GITHUB_APP_PRIVATE_KEY` | Conditional | — | GitHub App private key PEM (plain text, or set `_ARN` instead) |
| `GITHUB_APP_PRIVATE_KEY_ARN` | Conditional | — | AWS Secrets Manager ARN for private key |
| `DISPATCH_REQUESTS_QUEUE_URL` | Lambda only | — | SQS URL for the `dispatch-requests` queue |
| `DISPATCH_TARGETS_QUEUE_URL` | Lambda only | — | SQS URL for the `dispatch-targets` queue |
| `DISPATCH_FACTS_EVENT_BUS_NAME` | Lambda only | `default` | EventBridge bus name for fact publishing |
| `DISPATCH_EVENTS_TABLE_NAME` | Lambda only | — | DynamoDB table name for raw events |
| `DISPATCH_PROJECTIONS_TABLE_NAME` | Lambda only | — | DynamoDB table name for projections |
| `DEFAULT_DISPATCH_REF` | No | `main` | Git ref used for `workflow_dispatch` if the source run's branch is unavailable and no per-target `ref` is set |
| `CREATE_ISSUES` | No | `true` | Whether to create GitHub issues on dispatch failures (local mode) |
| `DISPATCH_MAX_RETRIES` | No | `2` | Number of retry attempts for a failing dispatch call |
| `DISPATCH_RETRY_BASE_DELAY_MS` | No | `200` | Base delay in ms for exponential backoff between retries |
| `ENFORCE_SOURCE_DEFAULT_BRANCH` | No | `true` | If `true`, only workflow runs on the source repository default branch are eligible for dispatch |
| `DISPATCH_MAX_TARGETS_PER_RUN` | No | `25` | Hard cap on authorized targets from one source workflow run (excess targets are denied) |
| `SOURCE_REPO_ALLOWLIST` | No | empty | Comma-separated allowlist of source repositories. Supports `*` wildcards (e.g. `my-org/*`). Empty means all repos are allowed. |
| `TARGET_REPO_ALLOWLIST` | No | empty | Comma-separated allowlist of target repositories. Supports `*` wildcards (e.g. `my-org/*`). Empty means all repos are allowed. |
| `SOURCE_WORKFLOW_ALLOWLIST` | No | empty | Comma-separated allowlist of source workflow file names. Supports `*` wildcards (e.g. `ci*`). Empty means all workflows are allowed. |
| `ALLOWED_SOURCE_CONCLUSIONS` | No | `success` | Comma-separated list of workflow run conclusions that are eligible to trigger dispatches (e.g. `success`, `success,skipped`). Empty means all conclusions are allowed. |
| `ADMIN_IP_ALLOWLIST` | No | empty | Comma-separated source IP allowlist for `/admin` and `/admin/api/*` Lambda endpoints |

For local use, copy `.env.example` to `.env` and fill in at minimum `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, and `GITHUB_APP_PRIVATE_KEY`.

### Security Guard Rails (PoC-safe defaults)

- Webhook processing rejects duplicate `x-github-delivery` values seen within a short replay window.
  - Current replay cache is in-memory per runtime instance; for stronger multi-instance guarantees, add a shared store (for example DynamoDB TTL).
- Dispatch planner enforces guard rails before authorization:
  - default-branch-only source runs (configurable),
  - fork-sourced run rejection (head repository differs from source repository),
  - conclusion filtering — only runs with permitted conclusions trigger dispatch (default: `success`),
  - optional source/target/workflow allowlists (exact match or `*` wildcard patterns),
  - self-dispatch block (`source repo + workflow` to itself),
  - duplicate target suppression,
  - maximum targets per run.
- Admin observability endpoints are intentionally unauthenticated in this PoC, but can be restricted with `ADMIN_IP_ALLOWLIST`.
  - IP allowlisting is a lightweight guard rail only; pair with API Gateway resource policies and/or AWS WAF for production-grade edge enforcement.

---

## Deployment

### CI/CD Pipeline

The GitHub Actions workflow at [.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml) runs on every push to `main` and on pull requests.

**Jobs:**

1. **quality** — `npm ci`, `npm run build`, `npm run lint`, `npm test`
2. **terraform-validate** — `terraform validate` for both `dev` and `prod` environments
3. **deploy-dev** — builds and pushes the Docker image to ECR (tagged with the commit SHA), then runs `terraform apply` for the `dev` environment (skipped on pull requests)
4. **deploy-prod** — same as dev, runs only when manually triggered via `workflow_dispatch` with `deploy_prod=true`

**Required GitHub Secrets / Variables:**

| Name | Type | Description |
|---|---|---|
| `AWS_ROLE_TO_ASSUME` | Secret | IAM role ARN for OIDC authentication |
| `AWS_REGION` | Variable | e.g. `eu-west-2` |
| `ECR_REPOSITORY_DEV` | Variable | ECR repo name for dev, e.g. `dispatcher-v2-dev-dispatcher` |
| `ECR_REPOSITORY_PROD` | Variable | ECR repo name for prod |
| `TF_STATE_BUCKET` | Variable | Terraform remote state S3 bucket name |
| `TF_STATE_REGION` | Variable | Region of the Terraform state bucket |

Set secrets and variables with the GitHub CLI:

```bash
gh secret set AWS_ROLE_TO_ASSUME --body "arn:aws:iam::<account>:role/<role>"
gh variable set AWS_REGION --body "eu-west-2"
gh variable set ECR_REPOSITORY_DEV --body "dispatcher-v2-dev-dispatcher"
gh variable set ECR_REPOSITORY_PROD --body "dispatcher-v2-prod-dispatcher"
gh variable set TF_STATE_BUCKET --body "<your-tf-state-bucket>"
gh variable set TF_STATE_REGION --body "eu-west-2"
```

Create the `dev` and `prod` environments (add manual review protection to `prod`):

```bash
gh api -X PUT repos/<owner>/github-workflow-dispatcher/environments/dev
gh api -X PUT repos/<owner>/github-workflow-dispatcher/environments/prod
```

### Manual Dev Deploy

The deploy script at `scripts/apply-dev-infra.sh` wraps the full build-push-apply cycle for local use.

```bash
# Full build + push + apply (interactive approval)
./scripts/apply-dev-infra.sh

# Plan only (no changes applied)
./scripts/apply-dev-infra.sh --plan-only

# Apply without interactive approval
./scripts/apply-dev-infra.sh --auto-approve

# Skip image build (use existing TF_VAR_container_image)
./scripts/apply-dev-infra.sh --skip-image-build --auto-approve
```

The script reads `AWS_PROFILE`, `AWS_REGION`, `AWS_ACCOUNT_ID`, `GITHUB_APP_ID`, `TF_STATE_BUCKET`, `TF_STATE_REGION`, `TF_VAR_github_app_id`, `TF_VAR_container_image`, `TF_VAR_lambda_image_uri`, and `LAMBDA_IMAGE_URI` from the environment or `.env`. If `TF_VAR_github_app_id` is not set, it falls back to `GITHUB_APP_ID`. If `TF_VAR_lambda_image_uri` is not set, it falls back to `LAMBDA_IMAGE_URI` (and then `TF_VAR_container_image`).

---

## Infrastructure (Terraform)

Infrastructure is managed with Terraform. The module lives at `infrastructure/terraform/modules/dispatcher_service/` and is instantiated by environment configs under `infrastructure/terraform/environments/`.

### Backend

State is stored in S3 with native S3 locking (`use_lockfile = true`). Backend configuration is in `backend.hcl` (gitignored). Copy `backend.hcl.example` and fill in your bucket name and region:

```bash
cp infrastructure/terraform/environments/dev/backend.hcl.example \
   infrastructure/terraform/environments/dev/backend.hcl
# edit backend.hcl
```

Bootstrap the S3 backend bucket (first time only):

```bash
cd infrastructure/terraform
bash bootstrap-backend.sh
```

### Key Module Variables

| Variable | Description |
|---|---|
| `project_name` | Name prefix for all resources, e.g. `dispatcher-v2` |
| `environment` | `dev` or `prod` |
| `container_image` | ECR image URI used for the ECS service (Fargate mode, if enabled) |
| `lambda_image_uri` | ECR image URI for all Lambda functions (defaults to `container_image`) |
| `github_app_id` | GitHub App ID passed to Lambda as environment variable |
| `create_managed_secrets` | If `true`, creates Secrets Manager secrets for webhook secret and private key |
| `github_webhook_secret_arn` | ARN of an externally managed Secrets Manager secret for the webhook secret |
| `github_app_private_key_arn` | ARN of an externally managed Secrets Manager secret for the private key |

### Terraform Validate

```bash
terraform -chdir=infrastructure/terraform/environments/dev init -backend=false
terraform -chdir=infrastructure/terraform/environments/dev validate

terraform -chdir=infrastructure/terraform/environments/prod init -backend=false
terraform -chdir=infrastructure/terraform/environments/prod validate
```

---

## Testing

Tests use [Vitest](https://vitest.dev/) and are colocated in `test/`.

```bash
npm test              # run all tests once
npm run test:watch    # watch mode
```

Test coverage includes:

| Test file | What it covers |
|---|---|
| `dispatching-schema.test.ts` | `dispatching.yml` YAML parsing, Zod schema validation, and optional `ref` field on outbound targets |
| `trigger-matcher.test.ts` | Outbound rule matching logic, including per-target `ref` passthrough |
| `authorization-service.test.ts` | Bilateral source/target authorization |
| `dispatch-guardrails.test.ts` | Source conclusion filtering, source/target allowlist wildcard matching, branch enforcement, fork rejection, duplicate/self/cap guardrails |
| `dispatch-service.test.ts` | `workflow_dispatch` API call with retry logic and per-target ref override |
| `webhook.test.ts` | Webhook signature verification, event routing, replay protection, and rate limiting |
| `content.test.ts` | `dispatching.yml` fetching from GitHub repository contents |
| `issue-service.test.ts` | GitHub issue creation on dispatch failure |
| `health.test.ts` | Health check computation from projection data |
| `replay-protection.test.ts` | In-memory replay detection with TTL expiry |
| `admin-observability-handler.test.ts` | `isAdminRequestAllowed` IP allowlist enforcement |

---

## Repository Structure

```
github-workflow-dispatcher/
├── src/
│   ├── config/
│   │   └── env.ts                     # Zod-validated environment schema
│   ├── domain/
│   │   ├── dispatching-schema/
│   │   │   └── schema.ts              # dispatching.yml Zod schema + parser
│   │   └── trigger-matcher/
│   │       └── match.ts               # Outbound rule matching
│   ├── github/
│   │   ├── content.ts                 # Fetch dispatching.yml from GitHub API
│   │   ├── replay-protection.ts       # In-memory duplicate delivery-ID detection (10-min TTL)
│   │   ├── types.ts                   # WorkflowRunPayload and event context types
│   │   └── webhook-handler.ts         # Fastify plugin: webhook verification + routing
│   ├── services/
│   │   ├── authorization-service.ts   # Bilateral inbound/outbound permission check
│   │   ├── dispatch-event-store.ts    # In-memory event store (local mode)
│   │   ├── dispatch-guardrails.ts     # Source + target guardrail evaluation and filtering
│   │   ├── dispatch-service.ts        # workflow_dispatch API call with retry
│   │   ├── issue-service.ts           # GitHub issue creation
│   │   └── workflow-run-handler.ts    # Orchestrates full dispatch flow (local mode)
│   ├── async/
│   │   ├── clients.ts                 # AWS SDK client factories (SQS, EventBridge, DynamoDB)
│   │   ├── cloudevents.ts             # CloudEvent type definitions
│   │   ├── contracts.ts               # SQS message types and DispatchFacts constants
│   │   └── event-store.ts             # DynamoDB read/write: events table, projections, health
│   ├── lambda/
│   │   ├── ingress-handler.ts         # Lambda: validate webhook, enqueue to SQS
│   │   ├── planner-handler.ts         # Lambda: resolve + authorise targets, enqueue work
│   │   ├── dispatcher-handler.ts      # Lambda: call GitHub workflow_dispatch API
│   │   ├── facts-processor-handler.ts # Lambda: persist EventBridge facts to DynamoDB
│   │   ├── admin-observability-handler.ts  # Lambda: dashboard HTML + admin JSON APIs
│   │   ├── github-app.ts              # GitHub App initialisation for Lambda context
│   │   └── runtime-secrets.ts         # Fetch secrets from Secrets Manager at cold start
│   ├── logger.ts
│   ├── server.ts                      # Fastify server builder (local mode)
│   └── index.ts                       # Entry point for local Fastify mode
├── test/                              # Vitest test files
├── infrastructure/
│   └── terraform/
│       ├── modules/
│       │   └── dispatcher_service/    # Reusable Terraform module (all AWS resources)
│       └── environments/
│           ├── dev/                   # Dev environment config + backend
│           └── prod/                  # Prod environment config + backend
├── scripts/
│   └── apply-dev-infra.sh             # Local dev build + push + deploy script
├── docs/
│   ├── aws-secrets-bootstrap.md       # Guide for bootstrapping Secrets Manager values
│   └── deployment-secrets.md          # GitHub secrets/variables setup reference
├── Dockerfile                         # Multi-stage build; Lambda runtime base image
├── .env.example                       # Template for local .env
└── PLAN.md                            # Original design plan and scope document
```


---

## How It Works

1. A GitHub workflow completes in a **source repository**.
2. GitHub sends a `workflow_run` webhook to the dispatcher ingress endpoint.
3. The ingress Lambda verifies the webhook signature and enqueues the payload to an SQS queue.
4. The **planner** Lambda consumes the queue, reads `dispatching.yml` from the source repo, reads `dispatching.yml` from each candidate target repo to verify inbound permissions, and enqueues authorised dispatch work items.
5. The **dispatcher** Lambda consumes those work items and calls the GitHub Actions workflow dispatch API for each target, with retry/backoff.
6. Facts about each step (request accepted, plan created, targets queued, trigger succeeded/failed) are published to an EventBridge event bus.
7. The **facts processor** Lambda consumes EventBridge events and writes them into two DynamoDB tables (raw event store and pre-computed projections).
8. The **admin observability** Lambda serves a web dashboard and JSON APIs that read those projections to show health, funnel metrics, per-repo stats, hourly trends, and delivery timelines.

---

## dispatching.yml Contract

Each repository places a `dispatching.yml` file at the root of the default branch. The schema supports two top-level keys: `outbound` and `inbound`.

```yaml
# Source repository: declares which target workflows to trigger
outbound:
  - source:
      workflow: ci.yml          # workflow in this repo that triggers dispatch
    targets:
      - repository: org/target-repo
        workflow: cd.yml        # workflow to trigger in the target repo

# Target repository: declares which sources are permitted to trigger it
inbound:
  - source:
      repository: org/source-repo
      workflow: ci.yml
    targets:
      - workflow: cd.yml
```

**Authorization is bilateral.** A dispatch only proceeds if:
- The source repo's `outbound` rule names the target repo and workflow.
- The target repo's `inbound` rule explicitly permits that source repo and workflow.

Missing or invalid `dispatching.yml` files are treated as having no rules (no-op, not an error).

---

## Architecture

```
GitHub webhook
      │
      ▼
┌─────────────────┐
│  ingress Lambda │  Verifies signature → SQS dispatch-requests
└─────────────────┘
      │
      ▼
┌─────────────────┐
│  planner Lambda │  Reads dispatching.yml (source + targets) → SQS dispatch-targets
└─────────────────┘
      │
      ▼
┌──────────────────┐
│ dispatcher Lambda│  Calls GitHub workflow_dispatch API (with retry)
└──────────────────┘
      │
      ▼ (all stages publish facts)
┌──────────────────────┐
│  EventBridge bus     │
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│ facts-processor      │  Writes raw events + updates projections → DynamoDB
│ Lambda               │
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  admin Lambda        │  Serves dashboard HTML + JSON APIs from DynamoDB
└──────────────────────┘
```

### Lambda Functions

| Function | Handler | Trigger | Purpose |
|---|---|---|---|
| `ingress` | `dist/lambda/ingress-handler.handler` | API Gateway (POST /webhooks/github) | Validates GitHub webhook HMAC; enqueues payload to `dispatch-requests` SQS queue |
| `planner` | `dist/lambda/planner-handler.handler` | SQS (`dispatch-requests`) | Reads `dispatching.yml` from source + target repos; authorises targets; enqueues work to `dispatch-targets` |
| `dispatcher` | `dist/lambda/dispatcher-handler.handler` | SQS (`dispatch-targets`) | Calls `workflow_dispatch` GitHub API for each authorised target; retries with exponential backoff |
| `facts-processor` | `dist/lambda/facts-processor-handler.handler` | EventBridge rule | Appends CloudEvent to the events DynamoDB table; updates pre-computed projections |
| `admin` | `dist/lambda/admin-observability-handler.handler` | API Gateway (`/admin/*`) | Serves the HTML dashboard and all `/admin/api/*` JSON endpoints |

All five functions use the **same Docker image** built from the repository root. Terraform sets the per-function entry point via `image_config.command`.

### AWS Infrastructure

| Resource | Purpose |
|---|---|
| ECR repository | Stores built Docker images; keeps the last 30 |
| API Gateway v2 (HTTP) | Routes `/webhooks/github`, `/health`, and `/admin/*` to the appropriate Lambda functions |
| SQS `dispatch-requests` | Buffer between ingress and planner (DLQ after 5 receives) |
| SQS `dispatch-targets` | Buffer between planner and dispatcher (DLQ after 5 receives) |
| EventBridge custom bus | `dispatch-facts` bus receives domain events from planner, dispatcher, and facts-processor |
| DynamoDB `dispatch-events` | Immutable append-only event store with GSI support for delivery-ID and repo lookups |
| DynamoDB `dispatch-projections` | Pre-computed read models: summary counters, per-repo stats, hourly buckets, delivery funnels |
| IAM role `{prefix}-lambda` | Shared execution role for all five Lambda functions |
| Secrets Manager | Stores GitHub webhook secret and app private key (managed or externally provided) |
| CloudWatch Log Groups | One per Lambda function |

### Event and Projection Model

Facts are structured as **CloudEvents** with `detail-type` values:

| Fact | When emitted |
|---|---|
| `dispatch.request.accepted` | Ingress has validated and enqueued a webhook |
| `dispatch.plan.created` | Planner has resolved authorised targets (0 or more) |
| `dispatch.target.queued` | A single dispatch work item has been enqueued |
| `dispatch.trigger.succeeded` | GitHub workflow_dispatch API call succeeded |
| `dispatch.trigger.failed` | All retry attempts for a dispatch exhausted |

The facts-processor writes each event to a DynamoDB table with a composite key `pk = EVENT#{type}#{hour}` / `sk = {deliveryId}#{eventId}`, and maintains pre-aggregated projections for:

- **Summary counters** — total events, accepted, plan created, queued, succeeded, failed
- **Per-repo statistics** — counts broken down by source repository
- **Hourly trend buckets** — counts bucketed by UTC hour for chart rendering
- **Delivery funnels** — per-delivery-id record tracking each stage timestamp and outcome

---

## Admin Observability Dashboard

The admin Lambda serves a self-contained dashboard at `/admin` (no external dependencies, pure HTML/CSS/JS).

### Dashboard Sections

- **Health banner** — green/amber/red status with human-readable reasons
- **Summary cards** — total events, accepted, queued targets, succeeded, failed
- **Delivery funnel bar chart** — shows drop-off at each pipeline stage
- **Delivery latency cards** — P50, P95, and average seconds from accepted to trigger
- **Hourly trend table** — succeeded and failed counts per UTC hour
- **Per-repo stats table** — success rate pill per source repository
- **Recent deliveries** — last N deliveries with source/target repo chip labels and status badges
- **Journey explorer** — enter a delivery ID to trace all events for a single dispatch

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Lambda liveness check (`{"status":"ok"}`) |
| `GET` | `/admin` | HTML dashboard |
| `GET` | `/admin/api/health` | JSON health report (status, reasons, checks, latency) |
| `GET` | `/admin/projections` | Full projections payload (summary, recentDeliveries, hourlyTrend, latency) |
| `GET` | `/admin/api/repos` | Per-repository statistics array |
| `GET` | `/admin/api/recent-events` | Raw recent CloudEvents |
| `GET` | `/admin/api/journey?deliveryId=<id>` | All events for a single delivery ID |

Health checks include: success rate, dispatch backlog depth, recent failures, data freshness, and latency threshold.

---

## Local Development

### Prerequisites

- Node.js 22 (see `mise.toml`)
- npm
- A GitHub App with a webhook secret and private key

> **Tool version management:** This project uses [`mise`](https://mise.jdx.dev/) for managing local tool versions.
> `mise` verifies tool downloads via checksums and fetches from official sources, providing stronger
> supply-chain guarantees than `asdf`. Install `mise` by following the
> [official installation guide](https://mise.jdx.dev/getting-started.html), then run `mise install`
> in the project root to install the pinned versions of Node.js and Terraform defined in `mise.toml`.

### Setup

```bash
git clone https://github.com/RossBugginsNHS/github-workflow-dispatcher
cd github-workflow-dispatcher
npm install
cp .env.example .env
# Edit .env with your GitHub App credentials and any optional settings
```

### Run in development mode

```bash
npm run dev
```

The Fastify server starts on `PORT` (default `3000`) with hot-reload via `tsx watch`.

Available local endpoints:

- `GET /health`
- `GET /version`
- `POST /webhooks/github`
- `GET /admin/installations`
- `GET /admin/logs`

> Note: The full async pipeline (SQS → EventBridge → DynamoDB) only runs in AWS. Locally, webhook events are handled synchronously by the in-process `WorkflowRunHandler` and an in-memory event store.

### Build

```bash
npm run build        # compiles TypeScript to dist/
npm run lint         # ESLint
npm run test         # Vitest (run once)
npm run test:watch   # Vitest (watch mode)
npm run format       # Prettier
```

---

## Environment Variables

All variables are validated at startup via `zod`. Unknown variables are ignored.

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port (local Fastify mode only) |
| `LOG_LEVEL` | No | `info` | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `APP_VERSION` | No | `local` | Build version string, injected by CI |
| `GITHUB_APP_ID` | Yes (runtime) | — | GitHub App numeric ID |
| `GITHUB_WEBHOOK_SECRET` | Conditional | — | Webhook HMAC secret (plain text, or set `_ARN` instead) |
| `GITHUB_WEBHOOK_SECRET_ARN` | Conditional | — | AWS Secrets Manager ARN for webhook secret |
| `GITHUB_APP_PRIVATE_KEY` | Conditional | — | GitHub App private key PEM (plain text, or set `_ARN` instead) |
| `GITHUB_APP_PRIVATE_KEY_ARN` | Conditional | — | AWS Secrets Manager ARN for private key |
| `DISPATCH_REQUESTS_QUEUE_URL` | Lambda only | — | SQS URL for the `dispatch-requests` queue |
| `DISPATCH_TARGETS_QUEUE_URL` | Lambda only | — | SQS URL for the `dispatch-targets` queue |
| `DISPATCH_FACTS_EVENT_BUS_NAME` | Lambda only | `default` | EventBridge bus name for fact publishing |
| `DISPATCH_EVENTS_TABLE_NAME` | Lambda only | — | DynamoDB table name for raw events |
| `DISPATCH_PROJECTIONS_TABLE_NAME` | Lambda only | — | DynamoDB table name for projections |
| `DEFAULT_DISPATCH_REF` | No | `main` | Git ref used for `workflow_dispatch` if the source run's branch is unavailable |
| `CREATE_ISSUES` | No | `true` | Whether to create GitHub issues on dispatch failures (local mode) |
| `DISPATCH_MAX_RETRIES` | No | `2` | Number of retry attempts for a failing dispatch call |
| `DISPATCH_RETRY_BASE_DELAY_MS` | No | `200` | Base delay in ms for exponential backoff between retries |
| `ENFORCE_SOURCE_DEFAULT_BRANCH` | No | `true` | If `true`, only workflow runs on the source repository default branch are eligible for dispatch |
| `DISPATCH_MAX_TARGETS_PER_RUN` | No | `25` | Hard cap on authorized targets from one source workflow run (excess targets are denied) |
| `SOURCE_REPO_ALLOWLIST` | No | empty | Comma-separated allowlist of source repositories (`org/repo`) allowed to trigger dispatches |
| `TARGET_REPO_ALLOWLIST` | No | empty | Comma-separated allowlist of target repositories (`org/repo`) eligible for workflow dispatch |
| `SOURCE_WORKFLOW_ALLOWLIST` | No | empty | Comma-separated allowlist of source workflow file names (for example `ci.yml`) |
| `ADMIN_IP_ALLOWLIST` | No | empty | Comma-separated source IP allowlist for `/admin` and `/admin/api/*` Lambda endpoints |

For local use, copy `.env.example` to `.env` and fill in at minimum `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, and `GITHUB_APP_PRIVATE_KEY`.

### Security Guard Rails (PoC-safe defaults)

- Webhook processing rejects duplicate `x-github-delivery` values seen within a short replay window.
  - Current replay cache is in-memory per runtime instance; for stronger multi-instance guarantees, add a shared store (for example DynamoDB TTL).
- Dispatch planner enforces guard rails before authorization:
  - default-branch-only source runs (configurable),
  - fork-sourced run rejection (head repository differs from source repository),
  - optional source/target/workflow allowlists,
  - self-dispatch block (`source repo + workflow` to itself),
  - duplicate target suppression,
  - maximum targets per run.
- Admin observability endpoints are intentionally unauthenticated in this PoC, but can be restricted with `ADMIN_IP_ALLOWLIST`.
  - IP allowlisting is a lightweight guard rail only; pair with API Gateway resource policies and/or AWS WAF for production-grade edge enforcement.

---

## Deployment

### CI/CD Pipeline

The GitHub Actions workflow at [.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml) runs on every push to `main` and on pull requests.

**Jobs:**

1. **quality** — `npm ci`, `npm run build`, `npm run lint`, `npm test`
2. **terraform-validate** — `terraform validate` for both `dev` and `prod` environments
3. **deploy-dev** — builds and pushes the Docker image to ECR (tagged with the commit SHA), then runs `terraform apply` for the `dev` environment (skipped on pull requests)
4. **deploy-prod** — same as dev, runs only when manually triggered via `workflow_dispatch` with `deploy_prod=true`

**Required GitHub Secrets / Variables:**

| Name | Type | Description |
|---|---|---|
| `AWS_ROLE_TO_ASSUME` | Secret | IAM role ARN for OIDC authentication |
| `AWS_REGION` | Variable | e.g. `eu-west-2` |
| `ECR_REPOSITORY_DEV` | Variable | ECR repo name for dev, e.g. `dispatcher-v2-dev-dispatcher` |
| `ECR_REPOSITORY_PROD` | Variable | ECR repo name for prod |
| `TF_STATE_BUCKET` | Variable | Terraform remote state S3 bucket name |
| `TF_STATE_REGION` | Variable | Region of the Terraform state bucket |

Set secrets and variables with the GitHub CLI:

```bash
gh secret set AWS_ROLE_TO_ASSUME --body "arn:aws:iam::<account>:role/<role>"
gh variable set AWS_REGION --body "eu-west-2"
gh variable set ECR_REPOSITORY_DEV --body "dispatcher-v2-dev-dispatcher"
gh variable set ECR_REPOSITORY_PROD --body "dispatcher-v2-prod-dispatcher"
gh variable set TF_STATE_BUCKET --body "<your-tf-state-bucket>"
gh variable set TF_STATE_REGION --body "eu-west-2"
```

Create the `dev` and `prod` environments (add manual review protection to `prod`):

```bash
gh api -X PUT repos/<owner>/github-workflow-dispatcher/environments/dev
gh api -X PUT repos/<owner>/github-workflow-dispatcher/environments/prod
```

### Manual Dev Deploy

The deploy script at `scripts/apply-dev-infra.sh` wraps the full build-push-apply cycle for local use.

```bash
# Full build + push + apply (interactive approval)
./scripts/apply-dev-infra.sh

# Plan only (no changes applied)
./scripts/apply-dev-infra.sh --plan-only

# Apply without interactive approval
./scripts/apply-dev-infra.sh --auto-approve

# Skip image build (use existing TF_VAR_container_image)
./scripts/apply-dev-infra.sh --skip-image-build --auto-approve
```

The script reads `AWS_PROFILE`, `AWS_REGION`, `AWS_ACCOUNT_ID`, `GITHUB_APP_ID`, `TF_STATE_BUCKET`, `TF_STATE_REGION`, `TF_VAR_github_app_id`, `TF_VAR_container_image`, `TF_VAR_lambda_image_uri`, and `LAMBDA_IMAGE_URI` from the environment or `.env`. If `TF_VAR_github_app_id` is not set, it falls back to `GITHUB_APP_ID`. If `TF_VAR_lambda_image_uri` is not set, it falls back to `LAMBDA_IMAGE_URI` (and then `TF_VAR_container_image`).

---

## Infrastructure (Terraform)

Infrastructure is managed with Terraform. The module lives at `infrastructure/terraform/modules/dispatcher_service/` and is instantiated by environment configs under `infrastructure/terraform/environments/`.

### Backend

State is stored in S3 with native S3 locking (`use_lockfile = true`). Backend configuration is in `backend.hcl` (gitignored). Copy `backend.hcl.example` and fill in your bucket name and region:

```bash
cp infrastructure/terraform/environments/dev/backend.hcl.example \
   infrastructure/terraform/environments/dev/backend.hcl
# edit backend.hcl
```

Bootstrap the S3 backend bucket (first time only):

```bash
cd infrastructure/terraform
bash bootstrap-backend.sh
```

### Key Module Variables

| Variable | Description |
|---|---|
| `project_name` | Name prefix for all resources, e.g. `dispatcher-v2` |
| `environment` | `dev` or `prod` |
| `container_image` | ECR image URI used for the ECS service (Fargate mode, if enabled) |
| `lambda_image_uri` | ECR image URI for all Lambda functions (defaults to `container_image`) |
| `github_app_id` | GitHub App ID passed to Lambda as environment variable |
| `create_managed_secrets` | If `true`, creates Secrets Manager secrets for webhook secret and private key |
| `github_webhook_secret_arn` | ARN of an externally managed Secrets Manager secret for the webhook secret |
| `github_app_private_key_arn` | ARN of an externally managed Secrets Manager secret for the private key |

### Terraform Validate

```bash
terraform -chdir=infrastructure/terraform/environments/dev init -backend=false
terraform -chdir=infrastructure/terraform/environments/dev validate

terraform -chdir=infrastructure/terraform/environments/prod init -backend=false
terraform -chdir=infrastructure/terraform/environments/prod validate
```

---

## Testing

Tests use [Vitest](https://vitest.dev/) and are colocated in `test/`.

```bash
npm test              # run all tests once
npm run test:watch    # watch mode
```

Test coverage includes:

| Test file | What it covers |
|---|---|
| `dispatching-schema.test.ts` | `dispatching.yml` YAML parsing and Zod schema validation |
| `trigger-matcher.test.ts` | Outbound rule matching logic |
| `authorization-service.test.ts` | Bilateral source/target authorization |
| `dispatch-guardrails.test.ts` | Source workflow run evaluation and per-target guardrail filtering |
| `dispatch-service.test.ts` | `workflow_dispatch` API call with retry logic |
| `webhook.test.ts` | Webhook signature verification and event routing |
| `content.test.ts` | `dispatching.yml` fetching from GitHub repository contents |
| `issue-service.test.ts` | GitHub issue creation on dispatch failure |
| `health.test.ts` | Health check computation from projection data |
| `replay-protection.test.ts` | In-memory replay detection with TTL expiry |
| `admin-observability-handler.test.ts` | `isAdminRequestAllowed` IP allowlist enforcement |

---

## Repository Structure

```
github-workflow-dispatcher/
├── src/
│   ├── config/
│   │   └── env.ts                     # Zod-validated environment schema
│   ├── domain/
│   │   ├── dispatching-schema/
│   │   │   └── schema.ts              # dispatching.yml Zod schema + parser
│   │   └── trigger-matcher/
│   │       └── match.ts               # Outbound rule matching
│   ├── github/
│   │   ├── content.ts                 # Fetch dispatching.yml from GitHub API
│   │   ├── replay-protection.ts       # In-memory duplicate delivery-ID detection (10-min TTL)
│   │   ├── types.ts                   # WorkflowRunPayload and event context types
│   │   └── webhook-handler.ts         # Fastify plugin: webhook verification + routing
│   ├── services/
│   │   ├── authorization-service.ts   # Bilateral inbound/outbound permission check
│   │   ├── dispatch-event-store.ts    # In-memory event store (local mode)
│   │   ├── dispatch-guardrails.ts     # Source + target guardrail evaluation and filtering
│   │   ├── dispatch-service.ts        # workflow_dispatch API call with retry
│   │   ├── issue-service.ts           # GitHub issue creation
│   │   └── workflow-run-handler.ts    # Orchestrates full dispatch flow (local mode)
│   ├── async/
│   │   ├── clients.ts                 # AWS SDK client factories (SQS, EventBridge, DynamoDB)
│   │   ├── cloudevents.ts             # CloudEvent type definitions
│   │   ├── contracts.ts               # SQS message types and DispatchFacts constants
│   │   └── event-store.ts             # DynamoDB read/write: events table, projections, health
│   ├── lambda/
│   │   ├── ingress-handler.ts         # Lambda: validate webhook, enqueue to SQS
│   │   ├── planner-handler.ts         # Lambda: resolve + authorise targets, enqueue work
│   │   ├── dispatcher-handler.ts      # Lambda: call GitHub workflow_dispatch API
│   │   ├── facts-processor-handler.ts # Lambda: persist EventBridge facts to DynamoDB
│   │   ├── admin-observability-handler.ts  # Lambda: dashboard HTML + admin JSON APIs
│   │   ├── github-app.ts              # GitHub App initialisation for Lambda context
│   │   └── runtime-secrets.ts         # Fetch secrets from Secrets Manager at cold start
│   ├── logger.ts
│   ├── server.ts                      # Fastify server builder (local mode)
│   └── index.ts                       # Entry point for local Fastify mode
├── test/                              # Vitest test files
├── infrastructure/
│   └── terraform/
│       ├── modules/
│       │   └── dispatcher_service/    # Reusable Terraform module (all AWS resources)
│       └── environments/
│           ├── dev/                   # Dev environment config + backend
│           └── prod/                  # Prod environment config + backend
├── scripts/
│   └── apply-dev-infra.sh             # Local dev build + push + deploy script
├── docs/
│   ├── aws-secrets-bootstrap.md       # Guide for bootstrapping Secrets Manager values
│   └── deployment-secrets.md          # GitHub secrets/variables setup reference
├── Dockerfile                         # Multi-stage build; Lambda runtime base image
├── .env.example                       # Template for local .env
└── PLAN.md                            # Original design plan and scope document
```
