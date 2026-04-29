# SECURITY REVIEW

## Executive summary (top 5 risks)

1. **High — Dispatch process abuse via untrusted source runs**  
   Without branch/fork trust checks, a low-trust contributor could influence `dispatching.yml`-driven fan-out.  
   **Fix applied:** source default-branch enforcement + fork-source rejection guardrail.
2. **High — Dispatch YAML can drive excessive or unsafe fan-out**  
   No hard cap/self-loop checks previously allowed noisy or recursive dispatch chains.  
   **Fix applied:** max-target cap, duplicate suppression, self-dispatch blocking.
3. **High — Missing allowlist controls for source/target/workflow trust boundaries**  
   Bilateral YAML auth existed, but no operator-enforced repository/workflow allowlists.  
   **Fix applied:** configurable source repo, target repo, and source workflow allowlists.
4. **Medium — Webhook replay risk**  
   Valid signed payloads could be replayed using the same delivery ID.  
   **Fix applied:** duplicate delivery rejection (short in-memory replay window).
5. **Medium — CI/CD privilege and deployment-scope hardening gaps**  
   Workflow-level permissions and deploy branch constraints were broader than needed.  
   **Fix applied:** per-job least-privilege permissions, `persist-credentials: false`, and `main`-ref deploy gating.

---

## Threat model snapshot

### Externally reachable attack surface

- `POST /webhooks/github` (Fastify local + Lambda ingress)
- `GET /health`
- Admin endpoints: `/admin`, `/admin/projections`, `/admin/api/*`
- GitHub Actions CI/CD workflow execution paths (`.github/workflows/ci-cd.yml`)

### Privileged operations

- GitHub App installation token minting (`src/lambda/github-app.ts`)
- Reading `dispatching.yml` from source/target repositories (`src/github/content.ts`)
- Triggering `workflow_dispatch` in target repositories (`src/services/dispatch-service.ts`, `src/lambda/dispatcher-handler.ts`)
- Infrastructure deployment via Terraform in CI

### Trust boundaries

- **GitHub → ingress:** HMAC webhook signature + delivery ID trust
- **Source repo YAML → planner:** source-controlled outbound rules
- **Planner → target repos:** target inbound permissions + operator policy controls
- **Default branch vs PR/fork refs:** now explicitly constrained with guardrails
- **Admin API consumers → projections/events data:** no auth by design (PoC), now optional IP allowlist

---

## Findings

### 1) Source workflow trust boundary was too weak
- **Severity:** High  
- **Category:** Process/YAML  
- **Evidence:**  
  - `src/services/workflow-run-handler.ts` (source guardrail evaluation added at handler entry)  
  - `src/services/dispatch-guardrails.ts` (`evaluateSourceWorkflowRun`)  
- **Exploit scenario:** workflow runs from non-default branches or fork contexts can influence dispatch behavior.  
- **Impact:** unauthorized cross-repo dispatch planning/triggering.  
- **Fix:** enforce default-branch source runs (configurable), source allowlist, workflow allowlist, and fork-source rejection.  
- **Verification:** run `test/dispatch-guardrails.test.ts` and validate non-default/fork payloads are rejected.
- **Status:** **Fix applied**

### 2) YAML-driven dispatch fan-out could be abused
- **Severity:** High  
- **Category:** Process/YAML  
- **Evidence:**  
  - `src/services/dispatch-guardrails.ts` (`filterTargetsWithGuardrails`)  
  - `src/lambda/planner-handler.ts` (guardrail filtering before authorization)  
- **Exploit scenario:** attacker-controlled outbound entries can create duplicate/self/oversized target sets.  
- **Impact:** recursive dispatch loops, operational DoS, noisy queue growth.  
- **Fix:** target dedupe, self-dispatch block, max targets per run, optional target allowlist.  
- **Verification:** run `test/dispatch-guardrails.test.ts` and inspect denied reasons for duplicates/self/cap violations.
- **Status:** **Fix applied**

### 3) Dispatch schema parsing accepted unknown structure
- **Severity:** Medium  
- **Category:** Process/YAML  
- **Evidence:**  
  - `src/domain/dispatching-schema/schema.ts` (all objects now `.strict()`, YAML parse `uniqueKeys: true`)  
  - `test/dispatching-schema.test.ts` (unknown/duplicate-key rejection tests)  
- **Exploit scenario:** extra fields or duplicate keys can hide malicious intent or create parser confusion.  
- **Impact:** config ambiguity and policy bypass risk.  
- **Fix:** strict schema + duplicate-key rejection.  
- **Verification:** run `test/dispatching-schema.test.ts`.
- **Status:** **Fix applied**

### 4) Webhook replay acceptance
- **Severity:** Medium  
- **Category:** Webhook  
- **Evidence:**  
  - `src/github/replay-protection.ts`  
  - `src/github/webhook-handler.ts` and `src/lambda/ingress-handler.ts` return `409` on duplicate delivery IDs  
  - `test/webhook.test.ts` replay test
- **Exploit scenario:** re-submit a previously signed webhook body/headers.  
- **Impact:** repeated queueing/planning/dispatch attempts.  
- **Fix:** in-process replay window cache keyed by delivery ID.  
- **Verification:** run `test/webhook.test.ts` and confirm second identical delivery gets `409`.
- **Status:** **Fix applied**

### 5) CI/CD permissions and deployment scope
- **Severity:** Medium  
- **Category:** CI/CD  
- **Evidence:** `.github/workflows/ci-cd.yml`  
- **Exploit scenario:** over-broad token usage or deploy from non-main refs in manual dispatch.  
- **Impact:** unintended infra changes / increased token misuse blast radius.  
- **Fix:** per-job permissions, checkout credential persistence disabled, deploy jobs constrained to `refs/heads/main`.  
- **Verification:** inspect workflow YAML and run CI on PR/main.
- **Status:** **Fix applied**

### 6) Admin portal has no authentication (accepted PoC risk)
- **Severity:** Medium  
- **Category:** AuthZ  
- **Evidence:**  
  - `README.md` local/admin endpoint docs  
  - `src/lambda/admin-observability-handler.ts` (serves admin UI/APIs without identity auth)
- **Exploit scenario:** public endpoint exposure reveals operational telemetry.  
- **Impact:** information disclosure and potential abuse reconnaissance.  
- **Fix:** accepted for PoC; added optional `ADMIN_IP_ALLOWLIST` guardrail.  
- **Verification:** set `ADMIN_IP_ALLOWLIST` and confirm non-allowlisted source IP returns 403.
- **Status:** **Fix applied (guard rail) / accepted risk remains**

### 7) Dependency advisory posture (AWS SDK transitive advisory)
- **Severity:** Medium  
- **Category:** Supply chain  
- **Evidence:** `npm audit --json` (24 moderate findings tied to AWS SDK package graph).  
- **Exploit scenario:** vulnerable transitive XML builder path in affected advisory chain.  
- **Impact:** supply-chain risk if vulnerable code path is reachable.  
- **Fix:** updated direct AWS SDK clients to latest patch in this repo and added Dependabot automation.  
- **Verification:** run `npm outdated`, `npm audit --json`, and monitor Dependabot alerts/PRs.
- **Status:** **Partial fix applied / Needs decision for advisory strategy**

---

## Fixes applied

- Dispatch guardrail policy module added and integrated in planner + local workflow handler.
- Strict dispatching YAML parsing/validation with duplicate key rejection.
- Webhook replay protection (duplicate delivery IDs).
- Ingress payload validation hardened (invalid JSON/payload shape handling).
- Optional admin IP allowlist support.
- CI workflow least-privilege improvements.
- Dependabot configuration added.
- README updated with security guardrails and new env vars.
- **GitHub Actions pinned to commit SHAs** (supply-chain hardening).
- **ECR image tag mutability set to IMMUTABLE** (container image integrity).
- **SQS server-side encryption enabled** (data-at-rest protection).
- **DynamoDB point-in-time recovery, encryption, and deletion protection enabled** (data protection).
- **CloudWatch Logs IAM scoped to specific log group patterns** (least privilege).
- **Explicit CloudWatch Log Groups with 90-day retention** (cost control + audit).
- **API Gateway access logging enabled** (HTTP-level audit trail).

## Needs decision

- **Mutual-consent hardening beyond bilateral YAML:**  
  add explicit source-target handshake identifiers/signatures or CODEOWNERS-enforced review for `dispatching.yml` changes.
- **Replay protection persistence across cold starts/instances:**  
  move delivery replay cache to DynamoDB with TTL for stronger distributed guarantees.
- **AWS SDK advisory response:**  
  decide whether to pin/downgrade to advisory-suggested versions versus waiting for upstream fixed line; document accepted risk window.
- **Workflow action SHA pinning policy:**  
  ~~migrate all actions from tags to commit SHAs under an update process.~~  
  **Resolved:** all actions in CI/CD workflow now pinned to commit SHAs with tag comments.

---

### 8) GitHub Actions pinned to mutable tags (supply-chain risk)
- **Severity:** High  
- **Category:** CI/CD / Supply chain  
- **Evidence:** `.github/workflows/ci-cd.yml` previously used `@v4` / `@v3` / `@v2` tags.  
- **Exploit scenario:** tag hijacking or tag force-push by a compromised upstream action repo could inject malicious code into CI/CD pipelines.  
- **Impact:** arbitrary code execution in the CI environment with access to OIDC credentials and deployment infrastructure.  
- **Fix:** all actions pinned to full 40-character commit SHAs with version comments for maintainability.  
- **Verification:** inspect `.github/workflows/ci-cd.yml` — all `uses:` references contain commit SHAs.
- **Status:** **Fix applied**

### 9) ECR image tag mutability allows tag overwriting
- **Severity:** High  
- **Category:** Infrastructure / Container supply chain  
- **Evidence:** `infrastructure/terraform/modules/dispatcher_service/main.tf` `aws_ecr_repository.app` previously set `image_tag_mutability = "MUTABLE"`.  
- **Exploit scenario:** attacker with ECR push access overwrites an existing image tag with a compromised image.  
- **Impact:** Lambda functions load tampered container images on next cold start.  
- **Fix:** set `image_tag_mutability = "IMMUTABLE"` to prevent tag overwriting.  
- **Verification:** inspect Terraform plan for `image_tag_mutability = "IMMUTABLE"`.
- **Status:** **Fix applied**

### 10) SQS queues lack server-side encryption
- **Severity:** Medium  
- **Category:** Infrastructure / Data at rest  
- **Evidence:** `aws_sqs_queue` resources for dispatch-requests, dispatch-targets, and their DLQs had no encryption configured.  
- **Exploit scenario:** if queue data is accessed via a compromised IAM credential, message contents (workflow payloads) are readable in plaintext.  
- **Impact:** information disclosure of dispatch payloads and metadata.  
- **Fix:** enabled `sqs_managed_sse_enabled = true` on all four queues.  
- **Verification:** inspect Terraform plan for SSE configuration on SQS resources.
- **Status:** **Fix applied**

### 11) DynamoDB tables lack point-in-time recovery and deletion protection
- **Severity:** Medium  
- **Category:** Infrastructure / Data protection  
- **Evidence:** `aws_dynamodb_table` resources for dispatch-events and dispatch-projections had no PITR or deletion protection.  
- **Exploit scenario:** accidental `terraform destroy` or `DeleteTable` API call permanently deletes audit data.  
- **Impact:** loss of dispatch event history and audit trail.  
- **Fix:** enabled `point_in_time_recovery`, `server_side_encryption`, and `deletion_protection_enabled` on both tables.  
- **Verification:** inspect Terraform plan for PITR, SSE, and deletion protection settings.
- **Status:** **Fix applied**

### 12) CloudWatch Logs IAM policy overly broad
- **Severity:** Medium  
- **Category:** Infrastructure / IAM  
- **Evidence:** Lambda IAM policy allowed `logs:*` on `arn:aws:logs:*:*:*`.  
- **Exploit scenario:** compromised Lambda function could write to or create arbitrary log groups across the entire account.  
- **Impact:** log pollution, cost escalation, and potential log-based attack obfuscation.  
- **Fix:** scoped logs IAM to `arn:aws:logs:{region}:{account}:log-group:/aws/lambda/{prefix}-*` pattern.  
- **Verification:** inspect Terraform plan for narrowed CloudWatch Logs resource ARNs.
- **Status:** **Fix applied**

### 13) No CloudWatch Log Groups with retention or API Gateway access logging
- **Severity:** Medium  
- **Category:** Infrastructure / Audit  
- **Evidence:** Lambda functions auto-created log groups with no retention limit; API Gateway had no access logging configured.  
- **Exploit scenario:** unbounded log storage costs; no HTTP-level audit trail for investigating suspicious requests.  
- **Impact:** cost escalation and reduced forensic capability.  
- **Fix:** added explicit CloudWatch Log Groups with configurable retention (default 90 days) for all five Lambda functions and API Gateway access logs. Enabled API Gateway access logging with structured JSON format.  
- **Verification:** inspect Terraform plan for log group resources and API Gateway stage `access_log_settings`.
- **Status:** **Fix applied**

---

## Verification steps

1. `npm run build`
2. `npx vitest run test/dispatching-schema.test.ts test/dispatch-guardrails.test.ts test/webhook.test.ts`
3. `npm run lint` *(currently fails due pre-existing unrelated lint errors in `src/async/event-store.ts` and `src/lambda/facts-processor-handler.ts`)*
4. Validate CI workflow conditions and job permissions in `.github/workflows/ci-cd.yml`
5. Optional manual check: set `ADMIN_IP_ALLOWLIST=127.0.0.1` in Lambda-equivalent event tests and confirm access control behavior

---

## Follow-up backlog

- Add persistent replay protection store (DynamoDB TTL keyed by `x-github-delivery`).
- Enforce `dispatching.yml` CODEOWNERS + protected branch review policy.
- Add explicit source/target relationship registry (mutual-consent handshake).
- Add workflow allowlist by immutable workflow IDs (not file-name only).
- Add dispatch rate limiting per source repo/workflow/time window.
- Add secret scanning policy docs + gitleaks workflow/config if org policy requires repository-level enforcement.
- Add admin portal authentication beyond IP allowlist (e.g., Cognito, API key, or IAM auth on API Gateway).
