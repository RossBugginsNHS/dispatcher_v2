#!/usr/bin/env python3
"""
Creates the 16 feature enhancement issues in GitHub and updates FEATURES.md
with references to each issue.

Usage:
    GH_TOKEN=<token-with-issues-write> python3 scripts/create-feature-issues.py

The script is idempotent: it checks for an existing open issue with the same
title before creating a new one.
"""

import json
import os
import re
import subprocess
import sys

REPO = os.environ.get("REPO", "RossBugginsNHS/github-workflow-dispatcher")
GH_TOKEN = os.environ.get("GH_TOKEN", "")

FEATURES_MD = os.path.join(os.path.dirname(__file__), "..", "FEATURES.md")

# ---------------------------------------------------------------------------
# Issue definitions
# ---------------------------------------------------------------------------

ISSUES: list[dict] = [
    {
        "key": "1",
        "title": "Feature: Workflow Inputs Passthrough",
        "body": """\
## Summary

Allow outbound rules to map source workflow run metadata (SHA, branch, run ID, \
run URL) to named inputs in the target workflow using a lightweight template syntax.

## Motivation

Today the dispatcher triggers target workflows but passes no context from the source \
run. Target workflows often need to know which commit SHA is being deployed, the \
source run URL for audit links, or a custom value set by the operator.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: org/target-repo
        workflow: cd.yml
        inputs:
          git_sha: "{{ source.sha }}"
          triggered_by_run: "{{ source.run_url }}"
          environment: production
```

Supported template variables: `source.sha`, `source.head_branch`, `source.run_id`, \
`source.run_url`, `source.repo`, `source.workflow`. Literal string values are also valid.

## Constraints

- GitHub workflow dispatch inputs must be strings; no nested objects.
- Unknown template variables must cause the dispatch to be denied with a clear reason logged.
- Schema validation via Zod must enforce the `inputs` map is `Record<string, string>`.

## Acceptance Criteria

- [ ] `inputs` field is supported on outbound targets in the `dispatching.yml` schema (validated via Zod)
- [ ] Template variables are resolved at dispatch time from the source workflow run payload
- [ ] Literal string values in inputs are passed through unchanged
- [ ] Unknown template variables cause the dispatch to be denied with a logged reason
- [ ] Resolved inputs are passed to `createWorkflowDispatch` as the `inputs` parameter
- [ ] Unit tests cover template resolution, unknown variable handling, and literal passthrough
""",
    },
    {
        "key": "2",
        "title": "Feature: Dispatch Chains and Sequencing",
        "body": """\
## Summary

Allow a `dispatching.yml` to declare that a set of target workflows must be triggered \
**in order** — each subsequent target only starts after the previous one completes \
successfully.

## Motivation

A common CI/CD pattern is: build → integration-test → deploy-staging → smoke-test → \
deploy-prod. Today the dispatcher fires all targets concurrently. There is no way to \
wait for intermediate results before proceeding.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: build.yml
    chain:
      - repository: org/target-repo
        workflow: integration-test.yml
      - repository: org/target-repo
        workflow: deploy-staging.yml
      - repository: org/target-repo
        workflow: smoke-test.yml
      - repository: org/target-repo
        workflow: deploy-prod.yml
```

Each step waits for a `workflow_run.completed` event from the previous step before \
proceeding. This builds on the existing dispatcher event model.

## Architecture Notes

- Chain state is persisted in DynamoDB, keyed on the original delivery ID.
- A failed step stops the chain and records the stopping reason.
- A new CloudEvent fact type `dispatch.chain.aborted` is emitted when a chain halts.

## Acceptance Criteria

- [ ] `chain` field is supported as an alternative to `targets` in outbound rules
- [ ] Each chain step waits for the previous `workflow_run.completed` event before proceeding
- [ ] A failed step stops the chain; remaining steps are not executed
- [ ] Chain state is persisted in DynamoDB with the original delivery ID as the partition key
- [ ] `dispatch.chain.aborted` CloudEvent is emitted on chain failure
- [ ] Inbound authorization is still evaluated for each chain step before dispatch
- [ ] Unit tests cover sequential execution, failure-stops-chain, and authorization per step
""",
    },
    {
        "key": "3",
        "title": "Feature: Conditional Dispatch Rules",
        "body": """\
## Summary

Allow outbound rules to include a `conditions` block that must evaluate to true before \
a target is dispatched.

## Motivation

Some teams only want to deploy to production when the source workflow ran against a tagged \
commit. Others want to skip dispatch if the source run relates to a `docs/` change only, \
or if a specific label is on the triggering pull request.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: ci.yml
    conditions:
      - "{{ source.head_branch }} == main"
      - "{{ source.event }} == push"
    targets:
      - repository: org/target-repo
        workflow: cd.yml
```

Conditions are evaluated against safe, read-only source-run context variables before \
the inbound authorization check.

## Constraints

- Only a minimal, safe expression language is supported: equality checks (`==`, `!=`), \
`startsWith`, `contains`. No arbitrary code execution.
- Failed conditions are logged with a clear reason and counted in `dispatch.plan.created` \
facts as `conditions_not_met`.
- All conditions in the list must pass (AND semantics).

## Acceptance Criteria

- [ ] `conditions` field is supported on outbound rules in the schema (validated via Zod)
- [ ] Supported operators: `==`, `!=`, `startsWith(...)`, `contains(...)`
- [ ] Available context: `source.head_branch`, `source.event`, `source.sha`, `source.repo`, `source.workflow`
- [ ] Conditions are evaluated before inbound authorization
- [ ] Failed conditions produce a `conditions_not_met` denial reason in the event store
- [ ] Unknown operators or template variables cause a schema validation error at parse time
- [ ] Unit tests cover each operator, AND semantics, unknown variable handling
""",
    },
    {
        "key": "4",
        "title": "Feature: Approval Gates Before Dispatch",
        "body": """\
## Summary

Allow targets to declare that a human approval is required before the workflow dispatch \
API is called.

## Motivation

For production deployments, teams often need a named person or team to sign off before a \
deployment begins. An explicit gate at the dispatcher level means the approval is tracked \
in the dispatcher's audit trail, not buried inside the target workflow's environment settings.

## Proposed Mechanism

- When a target has `require_approval: true`, the dispatcher creates a GitHub issue asking a \
designated reviewer to approve.
- The reviewer approves by posting `/approve` or reacting with 👍.
- The dispatcher listens for `issue_comment` events from the GitHub App and resumes the \
queued dispatch when approval is detected.
- A configurable timeout auto-denies the dispatch if no approval arrives.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: org/target-repo
        workflow: deploy-prod.yml
        require_approval:
          reviewers:
            - team: org/platform-team
          timeout_hours: 24
```

## Architecture Notes

- Pending approvals stored in DynamoDB with a TTL matching the timeout.
- A new Lambda (`approvals-handler`) listens for `issue_comment` events and resolves or \
expires pending approval records.
- New CloudEvent fact types: `dispatch.approval.requested`, `dispatch.approval.granted`, \
`dispatch.approval.expired`.

## Acceptance Criteria

- [ ] `require_approval` field is supported on outbound targets in the schema
- [ ] An approval-request GitHub issue is created in the source repo when a gate is triggered
- [ ] The `issue_comment` webhook event is routed to the approvals handler
- [ ] `/approve` command or 👍 reaction from an authorized reviewer resumes the dispatch
- [ ] Timeout expiry auto-denies the dispatch and closes the approval issue
- [ ] All approval lifecycle events are emitted to EventBridge
- [ ] Unit tests cover approval, rejection, timeout, and unauthorized reviewer paths
""",
    },
    {
        "key": "5",
        "title": "Feature: Time-Window Guards (No-Deploy Windows)",
        "body": """\
## Summary

Allow outbound rules or global configuration to define time windows during which dispatch \
is permitted. Dispatches outside those windows are deferred or denied.

## Motivation

Many organisations have "no-deploy Fridays" or maintenance blackout windows. Currently a \
pipeline triggered at 23:55 on Friday would dispatch to production without any time-based check.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: org/target-repo
        workflow: deploy-prod.yml
        dispatch_window:
          timezone: Europe/London
          allow:
            - days: [Mon, Tue, Wed, Thu]
              from: "09:00"
              to: "17:00"
          deny_outside_window: defer   # or "reject"
```

`defer` places the dispatch in a pending queue and retries when the next allowed window \
opens. `reject` denies the dispatch immediately with a logged reason.

## Architecture Notes

- A scheduled Lambda (CloudWatch Events) runs every minute to check for deferred dispatches \
that can now be released.
- Deferred dispatch records stored in DynamoDB with the earliest-eligible-dispatch timestamp \
as a sort key.
- Time zone handling uses the IANA tz database.

## Acceptance Criteria

- [ ] `dispatch_window` field is supported on outbound targets in the schema
- [ ] Dispatches within the allowed window proceed normally
- [ ] `defer` mode stores the dispatch in DynamoDB and a scheduled Lambda releases it when the window opens
- [ ] `reject` mode denies the dispatch immediately with an `outside_dispatch_window` reason
- [ ] Timezone support covers all IANA tz identifiers
- [ ] The scheduled Lambda runs at least every 5 minutes and processes deferred items in order
- [ ] Unit tests cover in-window, out-of-window, defer, reject, and DST boundary edge cases
""",
    },
    {
        "key": "6",
        "title": "Feature: Deployment Environment Promotion Pipeline",
        "body": """\
## Summary

Provide a first-class concept of **environments** (dev → staging → prod) with guardrails \
that prevent promotion if a lower environment is in a failing state.

## Motivation

Today there is no mechanism to block a production dispatch if the staging deployment \
recently failed. Environment promotion pipelines are a common pattern that the dispatcher \
is well-positioned to support natively using its own DynamoDB projections.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: org/target-repo
        workflow: deploy-prod.yml
        environment: production
        promote_from:
          environment: staging
          must_be_healthy: true
          healthy_window_minutes: 60
```

## Architecture Notes

- The dispatcher checks the DynamoDB projections for the most recent dispatch to the \
`staging` environment for this repository.
- If the most recent dispatch is a failure, or is older than `healthy_window_minutes`, \
the production dispatch is denied.
- This creates a data-driven promotion gate with no external tooling required.
- Environment names are stored as metadata on dispatch records and projection keys.

## Acceptance Criteria

- [ ] `environment` and `promote_from` fields are supported on outbound targets in the schema
- [ ] Production dispatch is denied if staging's most recent dispatch was a failure
- [ ] Production dispatch is denied if staging's most recent dispatch is older than `healthy_window_minutes`
- [ ] Denial reason `promotion_gate_failed` is recorded in the event store
- [ ] Environment metadata is stored on all dispatch facts and projection records
- [ ] Unit tests cover healthy promotion, failure block, stale window block, and missing staging data
""",
    },
    {
        "key": "7",
        "title": "Feature: Rollback Trigger on Target Failure",
        "body": """\
## Summary

Allow an outbound rule to declare a rollback workflow that is automatically dispatched \
when a target workflow run fails.

## Motivation

When a deployment fails, the team usually wants to trigger a rollback as fast as possible. \
Today this requires a separate pipeline or manual intervention.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: org/target-repo
        workflow: deploy-prod.yml
        on_failure:
          workflow: rollback-prod.yml
          inputs:
            reason: "Automatic rollback triggered by dispatcher"
```

## Architecture Notes

- The dispatcher already listens for `workflow_run.completed` events. The rollback is \
triggered when a monitored target workflow run completes with conclusion `failure`.
- Loop-prevention: rollback workflows must not themselves trigger further rollbacks or \
dispatch chains.
- A new fact type `dispatch.rollback.triggered` is emitted.
- Rollback workflows are subject to the same inbound authorization rules as regular \
dispatch targets.

## Acceptance Criteria

- [ ] `on_failure` field is supported on outbound targets in the schema
- [ ] A rollback dispatch is triggered when the target workflow run concludes with `failure`
- [ ] Rollback workflows go through inbound authorization in the target repo
- [ ] Loop prevention blocks rollback workflows from triggering further rollbacks
- [ ] `dispatch.rollback.triggered` CloudEvent is emitted
- [ ] `inputs` on `on_failure` support the same template syntax as regular target inputs
- [ ] Unit tests cover rollback trigger, loop prevention, authorization, and input resolution
""",
    },
    {
        "key": "8",
        "title": "Feature: Notifications (Slack / Teams / Outbound Webhook)",
        "body": """\
## Summary

Allow outbound rules or global configuration to specify notification targets that receive \
a message when a dispatch succeeds, fails, or is denied.

## Motivation

Today the only side-effect of a dispatch outcome is a GitHub issue. Many teams prefer Slack \
or Microsoft Teams notifications, or want to call a custom webhook (e.g. PagerDuty, Opsgenie, \
Statuspage).

## Proposed `dispatching.yml` Extension

```yaml
notifications:
  on_success:
    - type: slack
      webhook_secret: SLACK_WEBHOOK_SECRET   # AWS Secrets Manager secret name
      message: "Dispatched {{ source.workflow }} to {{ target.workflow }} successfully"
  on_failure:
    - type: teams
      webhook_secret: TEAMS_WEBHOOK_SECRET
    - type: webhook
      url: https://hooks.example.com/dispatcher-alert
      method: POST
```

## Architecture Notes

- Notification delivery is handled by a new `notifications-handler` Lambda triggered by \
the EventBridge facts bus, keeping the main dispatch path clean.
- Secrets for notification webhooks must be stored in AWS Secrets Manager and never appear \
in `dispatching.yml` in plaintext.
- Notification failures must not block or retry the dispatch itself.
- Message templates support the same `{{ source.* }}` / `{{ target.* }}` syntax as workflow inputs.

## Acceptance Criteria

- [ ] `notifications` top-level key is supported in the `dispatching.yml` schema
- [ ] Supported types: `slack`, `teams`, `webhook`
- [ ] `webhook_secret` references are resolved from AWS Secrets Manager at delivery time
- [ ] Message templates are resolved using source/target context variables
- [ ] A new `notifications-handler` Lambda subscribes to the EventBridge facts bus
- [ ] Notification delivery failures are logged but do not affect dispatch outcomes
- [ ] Unit tests cover Slack, Teams, generic webhook, template resolution, and secret fetch failure
""",
    },
    {
        "key": "9",
        "title": "Feature: Additional Trigger Events (release, push tag, schedule)",
        "body": """\
## Summary

Extend the dispatcher to react to GitHub events beyond `workflow_run.completed`, including \
`push` (to a tagged ref), `release.published`, `pull_request.merged`, and `schedule`.

## Motivation

Many teams want to trigger a CD workflow when a semantic version tag is pushed, not just \
when a CI workflow passes. Others want a nightly rollup build dispatched on a schedule.

## Proposed `dispatching.yml` Extension

```yaml
triggers:
  - event: release
    action: published
    targets:
      - repository: org/target-repo
        workflow: publish-packages.yml
        inputs:
          version: "{{ release.tag_name }}"

  - event: schedule
    cron: "0 2 * * 1-5"   # 02:00 UTC Mon-Fri
    targets:
      - repository: org/target-repo
        workflow: nightly-integration.yml
```

## Architecture Notes

- The ingress Lambda's webhook router handles additional event types alongside `workflow_run`.
- Scheduled triggers require a CloudWatch Events rule per cron entry, created by Terraform. \
They are not applied dynamically at runtime.
- All new trigger types go through the same inbound authorization and guardrail pipeline.

## Supported Events (initial set)

| Event | Action | Context variables |
|---|---|---|
| `release` | `published` | `release.tag_name`, `release.name`, `release.body` |
| `push` | tag ref only | `push.ref`, `push.sha`, `push.repo` |
| `schedule` | cron | `schedule.cron` |

## Acceptance Criteria

- [ ] `triggers` top-level key is supported in the `dispatching.yml` schema alongside `outbound`/`inbound`
- [ ] `release.published` events are routed through the dispatcher pipeline
- [ ] `push` events on tag refs are routed through the dispatcher pipeline
- [ ] `schedule` entries generate Terraform CloudWatch Event rules (not runtime dynamic scheduling)
- [ ] All new trigger types pass through inbound authorization
- [ ] Context variables for each event type are available for template resolution in `inputs`
- [ ] Unit tests cover each new event type's routing and context variable mapping
""",
    },
    {
        "key": "10",
        "title": "Feature: Dry-Run / Preview Mode",
        "body": """\
## Summary

Add a dry-run mode triggered by the `X-Dispatcher-Dry-Run: true` request header that \
evaluates the full dispatch plan (authorization, guardrails, matching) but does not call \
the GitHub API or produce any side effects.

## Motivation

Operators adding new `dispatching.yml` rules want to validate them against a real payload \
before enabling them. There is currently no way to do this without risking an unintended dispatch.

## Behaviour

- In dry-run mode the service evaluates the full pipeline (guardrails, config fetch, \
matching, authorization) and returns the planned actions in the response body.
- No `workflow_dispatch` API calls are made.
- No GitHub issues are created.
- A `dispatch.plan.dryrun` CloudEvent is emitted to EventBridge for audit purposes.
- The `X-Dispatcher-Dry-Run: true` header approach is safer than a query parameter.

## Use Cases

- Validate a new `dispatching.yml` rule in a CI check before merging.
- Debug unexpected dispatch behaviour in a staging environment.
- Demonstrate what would be dispatched for a given payload without affecting production.

## Acceptance Criteria

- [ ] `X-Dispatcher-Dry-Run: true` header is detected in the ingress handler
- [ ] Full pipeline evaluation (guardrails, config, matching, authorization) runs normally
- [ ] No `workflow_dispatch` API call is made in dry-run mode
- [ ] Response body includes the full dispatch plan: allowed targets, denied targets, denial reasons
- [ ] `dispatch.plan.dryrun` CloudEvent is emitted with the plan details
- [ ] Dry-run requests are clearly marked in structured logs and the admin dashboard
- [ ] Unit tests cover dry-run path versus live path for the same payload
""",
    },
    {
        "key": "11",
        "title": "Feature: Gradual Rollout (Canary Dispatch)",
        "body": """\
## Summary

Allow an outbound rule to specify that only a percentage of eligible dispatch events \
should actually trigger the target workflow, enabling canary or staged rollout of new \
pipeline relationships.

## Motivation

When introducing a new cross-repo dispatch rule, teams may want to observe the behaviour \
for 10% of builds before rolling it out to 100%. This mirrors the concept of feature \
flags applied to dispatch rules.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: org/target-repo
        workflow: cd.yml
        rollout_percentage: 10
```

## Implementation Notes

- The dispatcher hashes the source `run_id` modulo 100 and compares it to the rollout \
percentage. This gives a deterministic, reproducible result for any given run.
- `rollout_percentage: 100` is equivalent to no rollout gate (default behaviour).
- `rollout_percentage: 0` effectively disables the rule without removing it.
- Canary skips emit a `dispatch.target.canary_skipped` fact for tracking adoption over time.

## Acceptance Criteria

- [ ] `rollout_percentage` field (integer 0-100) is supported on outbound targets in the schema
- [ ] The in/out decision is deterministic: same `run_id` always produces the same result
- [ ] `dispatch.target.canary_skipped` CloudEvent is emitted for skipped targets
- [ ] `rollout_percentage: 100` passes all runs (backward compatible default)
- [ ] The admin dashboard surfaces canary skip rates alongside normal deny rates
- [ ] Unit tests cover boundary values (0, 1, 50, 99, 100) and determinism
""",
    },
    {
        "key": "12",
        "title": "Feature: Multi-Organisation Support",
        "body": """\
## Summary

Allow the dispatcher to cross GitHub organisation boundaries — dispatching from a workflow \
in `org-a/repo` to a workflow in `org-b/repo`, provided both repositories' `dispatching.yml` \
files permit it and the GitHub App is installed in both organisations.

## Motivation

Large enterprises often have separate GitHub organisations for different business units that \
still need coordinated delivery pipelines.

## Implementation Notes

- The dispatcher already uses per-installation Octokit clients. The primary change is ensuring \
that the GitHub App is installed in all participating organisations and that installation ID \
lookup covers both organisations.
- The `dispatching.yml` outbound `repository` field already supports `owner/repo` format, so \
no schema change is needed — only the installation-fetching logic needs to handle cross-org cases.
- A new guardrail `ALLOWED_TARGET_ORGS` (comma-separated allowlist) restricts cross-org dispatch \
to explicitly permitted organisations.
- Cross-org dispatch is opt-in: `ALLOWED_TARGET_ORGS` is empty by default, blocking all \
cross-org targets.

## New Environment Variable

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_TARGET_ORGS` | empty (all blocked) | Comma-separated list of permitted target organisation names. Supports `*` wildcard. Empty means only the source org is permitted. |

## Acceptance Criteria

- [ ] `ALLOWED_TARGET_ORGS` guardrail is implemented and tested
- [ ] Installation lookup resolves the correct installation for a target org different from the source org
- [ ] Cross-org dispatch is blocked by default (empty `ALLOWED_TARGET_ORGS`)
- [ ] Inbound authorization is fetched from the target org's installation client
- [ ] A clear denial reason `target_org_not_allowlisted` is recorded when blocked
- [ ] Unit tests cover same-org (existing behaviour), permitted cross-org, and blocked cross-org
""",
    },
    {
        "key": "13",
        "title": "Feature: GitHub Deployment API Integration",
        "body": """\
## Summary

When the dispatcher triggers a target workflow, optionally create a GitHub Deployment \
(via the Deployments API) in the target repository so that deployment status appears in \
the GitHub UI (pull request checks, environment tab, etc.).

## Motivation

GitHub's native deployment tracking (on the pull request and the environment tab) is \
currently decoupled from the dispatcher. Teams have no way to see in the GitHub UI that \
a deployment was triggered by the dispatcher rather than by a native GitHub Actions environment.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: org/target-repo
        workflow: deploy-staging.yml
        create_deployment:
          environment: staging
          description: "Triggered by {{ source.workflow }} on {{ source.head_branch }}"
          auto_inactive: true
```

## Implementation Notes

- The dispatcher calls `POST /repos/{owner}/{repo}/deployments` before triggering the \
workflow dispatch, then immediately sets deployment status to `in_progress`.
- An extension to the facts-processor (or a companion Lambda) listens for the target \
`workflow_run.completed` event and updates the deployment status to `success` or `failure`.
- The GitHub Deployment ID is stored alongside the dispatch target record in DynamoDB \
for status update correlation.

## Acceptance Criteria

- [ ] `create_deployment` field is supported on outbound targets in the schema
- [ ] A GitHub Deployment is created in the target repo before `workflow_dispatch` is called
- [ ] Deployment status is set to `in_progress` immediately after dispatch
- [ ] Deployment status is updated to `success` or `failure` when the target workflow run completes
- [ ] Deployment description supports `{{ source.* }}` template variables
- [ ] `auto_inactive: true` marks previous deployments to the same environment as inactive
- [ ] Deployment creation failure does not block the workflow dispatch
- [ ] Unit tests cover deployment create, status update (success/failure), and template resolution
""",
    },
    {
        "key": "14",
        "title": "Feature: Dispatch Replay from Admin UI",
        "body": """\
## Summary

Add a "Replay" button in the admin observability dashboard that re-triggers a past dispatch \
— either re-running a failed dispatch or re-enqueuing a historical one for testing purposes.

## Motivation

When a dispatch fails due to a transient GitHub API error, operators currently have no way \
to replay it without re-running the source workflow. A replay button in the dashboard would \
allow safe, targeted retries with full audit trail support.

## Implementation Notes

- The replay action reads the original dispatch work item from DynamoDB and re-enqueues \
it to the `dispatch-targets` SQS queue.
- A replay emits a `dispatch.trigger.replayed` CloudEvent to distinguish it from an original \
dispatch in the audit log.
- Replay is gated behind the `ADMIN_IP_ALLOWLIST` check.
- A new correlation ID is generated for the replay: `{original-delivery-id}#replay-{n}`.
- The dashboard indicates which deliveries are replays and links them to their originals.

## New API Endpoint

| Method | Path | Description |
|---|---|---|
| `POST` | `/admin/api/replay` | Re-enqueue a past dispatch. Body: `{ "deliveryId": "<id>", "targetWorkflow": "<workflow>" }` |

## Acceptance Criteria

- [ ] `POST /admin/api/replay` endpoint accepts a delivery ID and target workflow
- [ ] The original dispatch work item is fetched from DynamoDB and re-enqueued to SQS
- [ ] Replay is gated behind `ADMIN_IP_ALLOWLIST`
- [ ] `dispatch.trigger.replayed` CloudEvent is emitted with a derived correlation ID
- [ ] The admin dashboard shows a "Replay" button on failed dispatch entries
- [ ] Replayed deliveries are visually distinguished and linked to their originals in the dashboard
- [ ] Unit tests cover replay enqueue, missing delivery ID, and IP allowlist enforcement
""",
    },
    {
        "key": "15",
        "title": "Feature: Dispatch History Diff View",
        "body": """\
## Summary

Add a dashboard view that shows what changed between two dispatch plans for the same source \
repository — making it easy to see when a new target was added, an existing one was removed, \
or authorisation for a route was revoked.

## Motivation

Over time, `dispatching.yml` files change. Currently there is no way to see — from the \
dispatcher's perspective — what the effect of those changes was. The diff view would surface \
"these targets were dispatched last week but not this week" and "this new target first \
appeared on Tuesday".

## Implementation Notes

- The facts-processor maintains a per-repo "last known dispatch plan" projection in DynamoDB.
- The diff view compares the current plan with the stored snapshot and returns added, removed, \
and unchanged targets.
- No new GitHub API calls are required — only DynamoDB projection reads.

## New API Endpoint

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/api/diff?repo=org/repo&since=7d` | Compare current dispatch plan against the plan from `since` ago |

Response shape:

```json
{
  "repo": "org/repo",
  "since": "2024-01-01T00:00:00Z",
  "added": [{ "target": "org/target#workflow.yml", "firstSeen": "..." }],
  "removed": [{ "target": "org/old-target#workflow.yml", "lastSeen": "..." }],
  "unchanged": [{ "target": "org/target#other.yml" }]
}
```

## Acceptance Criteria

- [ ] Facts-processor maintains a per-repo last-known-plan projection in DynamoDB
- [ ] `GET /admin/api/diff` endpoint is implemented and documented
- [ ] Response includes added, removed, and unchanged target lists with timestamps
- [ ] `since` parameter supports duration strings (`7d`, `30d`) and ISO 8601 timestamps
- [ ] The admin dashboard includes a "Plan diff" section per repository
- [ ] Unit tests cover added-only, removed-only, unchanged, and mixed diff scenarios
""",
    },
    {
        "key": "16",
        "title": "Feature: Supply Chain Attestation Passthrough",
        "body": """\
## Summary

When the source workflow produces an SLSA provenance attestation or an SBOM (Software Bill \
of Materials), automatically pass a reference to that attestation as an input to the target \
workflow so that the deployment pipeline can verify it before proceeding.

## Motivation

Supply chain security is increasingly important. Teams using `attest-build-provenance` or \
Sigstore in CI want the dispatcher to carry attestation evidence forward into deployment \
pipelines without requiring manual input wiring in every `dispatching.yml`.

## Proposed `dispatching.yml` Extension

```yaml
outbound:
  - source:
      workflow: build.yml
    targets:
      - repository: org/target-repo
        workflow: deploy.yml
        pass_attestations: true
```

## Mechanism

1. The dispatcher calls the GitHub Attestations API to check whether the source run \
produced any attestations.
2. If attestations are found, their bundle references are injected as reserved inputs \
when calling `workflow_dispatch` on the target:
   - `_attestation_bundle_url` — URL to the SLSA provenance bundle
   - `_sbom_url` — URL to the SBOM artifact (if present)
3. The target workflow is responsible for verifying the attestation before proceeding.

## Constraints

- This feature is opt-in per target (`pass_attestations: true`). Off by default.
- If no attestations are found, dispatch proceeds without the reserved inputs (not an error).
- Reserved input names (`_attestation_*`) are validated in the Zod schema and blocked from \
manual use in `inputs`.

## Acceptance Criteria

- [ ] `pass_attestations` boolean field is supported on outbound targets in the schema
- [ ] Dispatcher calls the GitHub Attestations API for the source run when `pass_attestations: true`
- [ ] Attestation bundle references are injected as `_attestation_bundle_url` and `_sbom_url` inputs
- [ ] Dispatch proceeds normally if no attestations are found (no-op, not an error)
- [ ] Reserved input names are blocked from manual use in the `inputs` field
- [ ] Attestation fetch errors are retried with standard backoff
- [ ] Unit tests cover attestation found, not found, fetch error, and reserved key conflict
""",
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def gh(*args: str) -> str:
    """Run a gh CLI command and return stdout."""
    env = os.environ.copy()
    if GH_TOKEN:
        env["GH_TOKEN"] = GH_TOKEN
    result = subprocess.run(
        ["gh", *args],
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        print(f"ERROR running gh {' '.join(args)}")
        print(result.stderr)
        sys.exit(1)
    return result.stdout.strip()


def find_existing_issue(title: str) -> int | None:
    """Return the issue number if an open enhancement issue with this title exists."""
    output = gh(
        "issue", "list",
        "--repo", REPO,
        "--label", "enhancement",
        "--state", "open",
        "--search", f'"{title}"',
        "--json", "number,title",
        "--jq", f'.[] | select(.title == "{title}") | .number',
    )
    stripped = output.strip()
    if stripped:
        return int(stripped.split()[0])
    return None


def create_issue(feature: dict) -> int:
    """Create or find an issue for the feature; return the issue number."""
    title = feature["title"]
    existing = find_existing_issue(title)
    if existing is not None:
        print(f"  Skipping '{title}' — already exists as #{existing}")
        return existing

    url = gh(
        "issue", "create",
        "--repo", REPO,
        "--label", "enhancement",
        "--title", title,
        "--body", feature["body"],
    )
    number = int(url.rstrip("/").split("/")[-1])
    print(f"  Created #{number}: {title}")
    return number


# ---------------------------------------------------------------------------
# FEATURES.md updater
# ---------------------------------------------------------------------------

HEADING_PREFIXES = {
    "1":  "## 1. Workflow Inputs Passthrough",
    "2":  "## 2. Dispatch Chains and Sequencing",
    "3":  "## 3. Conditional Dispatch Rules",
    "4":  "## 4. Approval Gates Before Dispatch",
    "5":  "## 5. Time-Window Guards",
    "6":  "## 6. Deployment Environment Promotion",
    "7":  "## 7. Rollback Trigger on Target Failure",
    "8":  "## 8. Notifications",
    "9":  "## 9. Additional Trigger Events",
    "10": "## 10. Dry-Run / Preview Mode",
    "11": "## 11. Gradual Rollout",
    "12": "## 12. Multi-Organisation Support",
    "13": "## 13. GitHub Deployment API Integration",
    "14": "## 14. Dispatch Replay from Admin UI",
    "15": "## 15. Dispatch History Diff View",
    "16": "## 16. Supply Chain Attestation Passthrough",
}

TOC_PATTERNS = [
    (r"^(\d+)\. \[Workflow Inputs Passthrough\](\(#1-workflow-inputs-passthrough\))",           "1"),
    (r"^(\d+)\. \[Dispatch Chains and Sequencing\](\(#2-dispatch-chains-and-sequencing\))",     "2"),
    (r"^(\d+)\. \[Conditional Dispatch Rules\](\(#3-conditional-dispatch-rules\))",             "3"),
    (r"^(\d+)\. \[Approval Gates Before Dispatch\](\(#4-approval-gates-before-dispatch\))",     "4"),
    (r"^(\d+)\. \[Time-Window Guards\](\(#5-time-window-guards\))",                             "5"),
    (r"^(\d+)\. \[Deployment Environment Promotion Pipeline\](\(#6-deployment-environment-promotion-pipeline\))", "6"),
    (r"^(\d+)\. \[Rollback Trigger on Target Failure\](\(#7-rollback-trigger-on-target-failure\))", "7"),
    (r"^(\d+)\. \[Notifications \(Slack / Teams / Webhook\)\](\(#8-notifications-slack--teams--webhook\))", "8"),
    (r"^(\d+)\. \[Additional Trigger Events\](\(#9-additional-trigger-events\))",               "9"),
    (r"^(\d+)\. \[Dry-Run / Preview Mode\](\(#10-dry-run--preview-mode\))",                     "10"),
    (r"^(\d+)\. \[Gradual Rollout \(Canary Dispatch\)\](\(#11-gradual-rollout-canary-dispatch\))", "11"),
    (r"^(\d+)\. \[Multi-Organisation Support\](\(#12-multi-organisation-support\))",             "12"),
    (r"^(\d+)\. \[GitHub Deployment API Integration\](\(#13-github-deployment-api-integration\))", "13"),
    (r"^(\d+)\. \[Dispatch Replay from Admin UI\](\(#14-dispatch-replay-from-admin-ui\))",       "14"),
    (r"^(\d+)\. \[Dispatch History Diff View\](\(#15-dispatch-history-diff-view\))",             "15"),
    (r"^(\d+)\. \[Supply Chain Attestation Passthrough\](\(#16-supply-chain-attestation-passthrough\))", "16"),
]

ISSUE_BADGE_RE = re.compile(r"^\n> \*\*GitHub Issue:\*\* \[#\d+\]\(https://github\.com/.*?\)\n$")


def update_features_md(issue_map: dict[str, int]) -> None:
    """Inject issue badge lines and ToC links into FEATURES.md."""
    features_path = os.path.realpath(FEATURES_MD)
    with open(features_path) as f:
        content = f.read()

    lines = content.split("\n")
    new_lines: list[str] = []

    for line in lines:
        # Remove any previously-injected badge so the file stays idempotent
        if ISSUE_BADGE_RE.match(line):
            continue
        new_lines.append(line)
        # Inject badge after the matching H2 heading
        for key, prefix in HEADING_PREFIXES.items():
            if line.strip().startswith(prefix):
                num = issue_map.get(key)
                if num:
                    url = f"https://github.com/{REPO}/issues/{num}"
                    new_lines.append(f"\n> **GitHub Issue:** [#{num}]({url})\n")
                break

    result = "\n".join(new_lines)

    # Update ToC entries to append issue links (idempotent: strip old link first)
    for pattern, key in TOC_PATTERNS:
        num = issue_map.get(key)
        if not num:
            continue
        issue_url = f"https://github.com/{REPO}/issues/{num}"
        # Strip any previously-appended issue reference on the ToC line
        def strip_and_replace(m: re.Match) -> str:  # noqa: E306
            base = f"{m.group(1)}. [{m.group(0).split('[')[1].split(']')[0]}]{m.group(2)}"
            return f"{base} — [#{num}]({issue_url})"

        result = re.sub(pattern, strip_and_replace, result, flags=re.MULTILINE)

    with open(features_path, "w") as f:
        f.write(result)

    print(f"  Updated {features_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    print(f"Creating/finding {len(ISSUES)} enhancement issues in {REPO} …")
    issue_map: dict[str, int] = {}

    for feature in ISSUES:
        key = feature["key"]
        number = create_issue(feature)
        issue_map[key] = number

    print("\nIssue map:")
    for k, v in sorted(issue_map.items(), key=lambda x: int(x[0])):
        print(f"  Feature {k} -> #{v}")

    print("\nUpdating FEATURES.md …")
    update_features_md(issue_map)
    print("Done.")


if __name__ == "__main__":
    main()
