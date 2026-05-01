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
- **Status:** **Fix applied** (extended by Finding 17)

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
- **Replaced asdf with mise for local tool version management** (supply-chain hardening — see finding 14).
- **Pinned Docker base images to SHA256 digests** (supply-chain hardening — see finding 15).
- **Added Dependabot tracking for Docker images and Terraform providers** (supply-chain hardening — see findings 15 and 16).

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

### 14) Local tool version manager (asdf) lacks supply-chain verification
- **Severity:** Low  
- **Category:** Developer environment / Supply chain  
- **Evidence:** `.tool-versions` file in repository root used by asdf.  
- **Exploit scenario:** asdf downloads plugin definitions from arbitrary GitHub repositories without checksum or signature verification. A compromised plugin source or a plugin source change could cause a developer to silently install a tampered tool binary. This is a local developer workstation risk but can propagate to supply-chain attacks if a developer builds and pushes artefacts from a compromised environment.  
- **Impact:** silent installation of tampered Node.js or Terraform binaries on developer machines.  
- **Fix:** replaced asdf with [`mise`](https://mise.jdx.dev/), which verifies tool downloads via checksums and fetches binaries directly from official distribution sources rather than through mutable plugin registries. Pinned tool versions are now declared in `mise.toml`. Dependabot is configured to track updates to `mise.toml`. The existing `.tool-versions` file is retained unchanged; `mise` reads it automatically and will honour either file, so both remain in sync by sharing the same version values.  
- **Verification:** install `mise` locally, run `mise install` in the project root, and confirm the correct versions of Node.js and Terraform are installed; confirm `mise doctor` reports no trust issues.
- **Status:** **Fix applied**

### 15) Dockerfile base images use mutable tags (supply-chain risk)
- **Severity:** High  
- **Category:** Container / Supply chain  
- **Evidence:** `Dockerfile` — `FROM node:22-alpine` (Docker Hub) and `FROM public.ecr.aws/lambda/nodejs:22` (ECR Public) both referenced by mutable floating tags.  
- **Exploit scenario:** a tag (e.g. `:22-alpine`) can be silently overwritten on Docker Hub or ECR Public. A compromised maintainer or a registry hack that replaces the tag would cause the next `docker build` to pull a tampered image containing backdoored binaries, without any alert or integrity check failure.  
- **Impact:** arbitrary code execution inside the build or Lambda runtime environment, potentially exfiltrating secrets, tokens, or producing a backdoored application artefact.  
- **Fix:** pinned both base images to immutable SHA256 digests in `Dockerfile`. Added `docker` ecosystem to `dependabot.yml` so Dependabot opens automated PRs when new versions are released, at which point digests can be re-evaluated and updated.  
  - `node:22-alpine` → `node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f`  
  - `public.ecr.aws/lambda/nodejs:22` → `public.ecr.aws/lambda/nodejs:22@sha256:68eea3ead8b4675c0dace6dd8e22a799758b93f69a5b0dae61f043be620c7d6d`  
- **Verification:** `grep '@sha256:' Dockerfile` — all `FROM` lines must contain a digest.
- **Status:** **Fix applied**

### 16) Terraform provider versions not locked with checksums
- **Severity:** Medium  
- **Category:** Infrastructure / Supply chain  
- **Evidence:** `infrastructure/terraform/*/versions.tf` uses loose constraints (`~> 5.0`) and no `.terraform.lock.hcl` is committed to the repository.  
- **Exploit scenario:** `terraform init` resolves the latest patch version of the AWS provider satisfying `~> 5.0` at run time and does not verify against a previously audited checksum. A compromised version in the HashiCorp registry (or a BGP/DNS hijack during init) could supply a tampered provider binary without detection.  
- **Impact:** malicious provider code executes with full AWS credentials during `terraform plan` / `terraform apply`, enabling credential theft or infrastructure sabotage.  
- **Fix:** run `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64` in each environment and module directory and commit the generated `.terraform.lock.hcl` files. Added `terraform` ecosystem entries to `dependabot.yml` for all three Terraform roots so provider version bumps are tracked automatically.  
- **Verification:** confirm `.terraform.lock.hcl` exists in each Terraform root; verify CI `terraform init` output shows "Using previously-installed" rather than resolving fresh versions.
- **Status:** **Partially applied (Dependabot tracking added; lock files still need to be generated and committed — see follow-up backlog)**

### 17) Fork detection was fail-open when `head_repository` is absent
- **Severity:** Medium  
- **Category:** Process / Fork trust  
- **Evidence:** `src/services/dispatch-guardrails.ts` (`evaluateSourceWorkflowRun`)  
- **Exploit scenario:**  
  The original fork check only blocked runs where `workflow_run.head_repository.full_name` was **present and different** from the source repository. If `head_repository` (or its `full_name` sub-field) was absent from the payload — which can occur in certain GitHub API edge cases — the fork check was silently bypassed. When combined with `ENFORCE_SOURCE_DEFAULT_BRANCH=false` (a configuration operators may choose for testing environments), an attacker who crafted a valid HMAC-signed payload (i.e., had access to the webhook secret, representing a separate compromise, or if GitHub itself sent a payload without the field) with no `head_repository` field could potentially trigger dispatch evaluation as if the run originated from the source repo's default branch.  

  **Layered context — why is this still a concern even with HMAC validation?**  
  HMAC validation confirms the payload came from GitHub's servers with the correct secret. However, it does **not** guarantee that every optional field within the payload is present; GitHub may omit `head_repository` in undocumented edge cases or future API changes. Relying solely on the presence/absence check (fail-open semantics) creates a brittle trust assumption.

- **Impact:** Fork-sourced runs could bypass fork detection if `head_repository` is absent from the payload and default-branch enforcement is disabled. Combined with a bilateral YAML authorization check this would still require the target repo's `inbound` config to list the attacker's fork — making direct cross-repo dispatch exploitation unlikely but not impossible in misconfigured environments.  
- **Fix:** Changed fork detection to **fail-closed**: the guardrail now returns `source_head_repository_unverifiable` if `head_repository` or its `full_name` is absent, rather than silently allowing the run. The check now requires `head_repository.full_name` to be **explicitly present and equal** to the source repository full name.  
  ```typescript
  // Before (fail-open)
  if (headRepository && headRepository !== sourceRepoFullName) {
    return { allowed: false, reason: "source_from_fork" };
  }

  // After (fail-closed)
  if (!headRepository) {
    return { allowed: false, reason: "source_head_repository_unverifiable" };
  }
  if (headRepository !== sourceRepoFullName) {
    return { allowed: false, reason: "source_from_fork" };
  }
  ```
- **Verification:** run `npx vitest run test/dispatch-guardrails.test.ts` — tests for `source_head_repository_unverifiable` (absent `head_repository`, absent `full_name` sub-field, and absent `head_repository` with `enforceSourceDefaultBranch: false`) must all pass.
- **Status:** **Fix applied**

---

## Fork security: complete threat model

The following summarises every identified fork-related attack vector and its mitigation.

| Attack vector | Mitigation |
|---|---|
| Fork installs the GitHub App and sends its own webhook events | HMAC signature binds events to the registered webhook secret — only GitHub can produce valid signatures. Bilateral YAML auth then requires the **target** repo's `inbound` rules to list the fork's identity, which they will not. |
| Fork opens a PR to the upstream repo; PR triggers an upstream workflow run | The `head_repository` in the resulting `workflow_run.completed` event will be the **fork's repo**, not the upstream. The guardrail rejects this with `source_from_fork`. |
| Fork opens a PR to the upstream repo; upstream workflow runs on default branch (merge commit / PR-merge triggers) | `head_repository` will still reflect the fork's repo for any run triggered by or attributed to fork code. The guardrail rejects this with `source_from_fork`. |
| `head_repository` is absent or its `full_name` is missing from the payload | The guardrail now rejects this with `source_head_repository_unverifiable` (fail-closed). Previously this was silently allowed (fail-open). |
| Workflow runs on a non-default branch (e.g., a feature branch pushed to the upstream) | Rejected with `source_not_default_branch` (default behaviour, configurable). |
| Malicious `dispatching.yml` in a fork's PR modifies the upstream config | `dispatching.yml` is always fetched from the **default branch** of the source repo via `repos.getContent` (no `ref` parameter), so PR branch changes to `dispatching.yml` have no effect until merged and reviewed. |
| Fork's branch name is used as `dispatchRef` for target repos | The fork check blocks the run before `dispatchRef` is ever used. Additionally, target repos specify their own `ref` overrides in `dispatching.yml`. |
| Compromised fork manipulates target fan-out size | All target guardrails (self-dispatch block, duplicate suppression, max-targets cap) apply regardless of source. Bilateral auth provides a final gate. |

---

## Verification steps

1. `npm run build`
2. `npx vitest run test/dispatching-schema.test.ts test/dispatch-guardrails.test.ts test/webhook.test.ts`
3. `npm run lint` — passes cleanly (unnecessary type assertions in `src/async/event-store.ts` and `src/lambda/facts-processor-handler.ts` have been resolved)
4. Validate CI workflow conditions and job permissions in `.github/workflows/ci-cd.yml`
5. Optional manual check: set `ADMIN_IP_ALLOWLIST=127.0.0.1` in Lambda-equivalent event tests and confirm access control behavior
6. `grep '@sha256:' Dockerfile` — all `FROM` lines must contain a digest (Finding 15 verification)

---

## Follow-up backlog

- **Commit Terraform provider lock files** — run `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64` in `infrastructure/terraform/modules/dispatcher_service`, `environments/dev`, and `environments/prod`, then commit the `.terraform.lock.hcl` files to the repository to enforce checksum-verified provider downloads in CI.
- Add persistent replay protection store (DynamoDB TTL keyed by `x-github-delivery`).
- Enforce `dispatching.yml` CODEOWNERS + protected branch review policy.
- Add explicit source/target relationship registry (mutual-consent handshake).
- Add workflow allowlist by immutable workflow IDs (not file-name only).
- Add dispatch rate limiting per source repo/workflow/time window.
- Add secret scanning policy docs + gitleaks workflow/config if org policy requires repository-level enforcement.
- Add admin portal authentication beyond IP allowlist (e.g., Cognito, API key, or IAM auth on API Gateway).
