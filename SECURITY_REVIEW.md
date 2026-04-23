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

## Needs decision

- **Mutual-consent hardening beyond bilateral YAML:**  
  add explicit source-target handshake identifiers/signatures or CODEOWNERS-enforced review for `dispatching.yml` changes.
- **Replay protection persistence across cold starts/instances:**  
  move delivery replay cache to DynamoDB with TTL for stronger distributed guarantees.
- **AWS SDK advisory response:**  
  decide whether to pin/downgrade to advisory-suggested versions versus waiting for upstream fixed line; document accepted risk window.
- **Workflow action SHA pinning policy:**  
  migrate all actions from tags to commit SHAs under an update process.

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
- Pin all GitHub Actions to immutable SHAs.
- Add secret scanning policy docs + gitleaks workflow/config if org policy requires repository-level enforcement.
