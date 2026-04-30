# Feature Ideas for GitHub Workflow Dispatcher

This document captures potential new features that could be added to the GitHub Workflow Dispatcher. No code changes are included here — this is a planning document only.

---

## Table of Contents

1. [Workflow Inputs Passthrough](#1-workflow-inputs-passthrough)
2. [Dispatch Chains and Sequencing](#2-dispatch-chains-and-sequencing)
3. [Conditional Dispatch Rules](#3-conditional-dispatch-rules)
4. [Approval Gates Before Dispatch](#4-approval-gates-before-dispatch)
5. [Time-Window Guards](#5-time-window-guards)
6. [Deployment Environment Promotion Pipeline](#6-deployment-environment-promotion-pipeline)
7. [Rollback Trigger on Target Failure](#7-rollback-trigger-on-target-failure)
8. [Notifications (Slack / Teams / Webhook)](#8-notifications-slack--teams--webhook)
9. [Additional Trigger Events](#9-additional-trigger-events)
10. [Dry-Run / Preview Mode](#10-dry-run--preview-mode)
11. [Gradual Rollout (Canary Dispatch)](#11-gradual-rollout-canary-dispatch)
12. [Multi-Organisation Support](#12-multi-organisation-support)
13. [GitHub Deployment API Integration](#13-github-deployment-api-integration)
14. [Dispatch Replay from Admin UI](#14-dispatch-replay-from-admin-ui)
15. [Dispatch History Diff View](#15-dispatch-history-diff-view)
16. [Supply Chain Attestation Passthrough](#16-supply-chain-attestation-passthrough)

---

## 1. Workflow Inputs Passthrough

**Summary**
Allow outbound rules to map source workflow run metadata (SHA, branch, run ID, run URL, custom outputs) to named inputs in the target workflow.

**Motivation**
Today the dispatcher triggers target workflows but passes no context from the source run. Target workflows often need to know what triggered them — which commit SHA is being deployed, the source run URL for audit links, or a custom value from the source workflow's outputs.

**Proposed `dispatching.yml` extension**

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

Supported template variables: `source.sha`, `source.head_branch`, `source.run_id`, `source.run_url`, `source.repo`, `source.workflow`. Literal string values are also valid.

**Constraints**
- GitHub workflow dispatch inputs must be strings; no nested objects.
- Unknown template variables should cause the dispatch to be denied with a clear reason logged.
- Schema validation via Zod must enforce the `inputs` map is `Record<string, string>`.

---

## 2. Dispatch Chains and Sequencing

**Summary**
Allow a `dispatching.yml` to declare that a set of target workflows must be triggered **in order** — each subsequent target only starts after the previous one completes successfully.

**Motivation**
A common CI/CD pattern is: build → integration-test → deploy-staging → smoke-test → deploy-prod. Today the dispatcher fires all targets concurrently. There is no way to wait for intermediate results before proceeding.

**Proposed `dispatching.yml` extension**

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

Each step waits for a `workflow_run.completed` event from the previous step before proceeding. This builds on the existing dispatcher event model — each "chain link" is itself a `workflow_run` that the dispatcher listens to.

**Architecture notes**
- The dispatcher would persist chain state in DynamoDB, keyed on the original delivery ID.
- A failed step stops the chain and records the stopping reason.
- A new CloudEvent fact type `dispatch.chain.aborted` should be emitted when a chain halts.

---

## 3. Conditional Dispatch Rules

**Summary**
Allow outbound rules to include a `conditions` block that must evaluate to true before a target is dispatched.

**Motivation**
Some teams only want to deploy to production when the source workflow ran against a tagged commit. Others want to skip dispatch if the source run relates to a `docs/` change only, or if a specific label is on the triggering pull request.

**Proposed `dispatching.yml` extension**

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

Conditions would be evaluated against a set of safe, read-only source-run context variables before the inbound authorization check is performed.

**Constraints**
- Only a minimal, safe expression language should be supported (equality checks, `startsWith`, `contains`). No arbitrary code execution.
- Failed conditions should log a clear reason and be counted in the `dispatch.plan.created` facts as `conditions_not_met`.

---

## 4. Approval Gates Before Dispatch

**Summary**
Allow targets to declare that a human approval is required before the workflow dispatch API is called.

**Motivation**
For production deployments, teams often need a named person or team to sign off before a deployment begins. GitHub's built-in environment protection rules partially cover this, but an explicit gate at the dispatcher level means the approval is tracked in the dispatcher's audit trail, not buried inside the target workflow's environment settings.

**Proposed mechanism**
- When a target has `require_approval: true`, the dispatcher creates a GitHub issue (or a pull request comment) asking a designated reviewer to approve.
- The reviewer approves by reacting to the issue with 👍 or posting a `/approve` comment.
- The dispatcher listens for `issue_comment` events from the GitHub App and resumes the queued dispatch when approval is detected.
- A configurable timeout (e.g. 24 hours) auto-denies the dispatch if no approval arrives.

**Proposed `dispatching.yml` extension**

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

**Architecture notes**
- Pending approvals would be stored in DynamoDB with a TTL matching the timeout.
- A new Lambda (`approvals-handler`) would listen for `issue_comment` events from the GitHub App webhook and resolve or expire the pending approval records.
- A new CloudEvent fact type `dispatch.approval.requested` and `dispatch.approval.granted` / `dispatch.approval.expired` would be emitted.

---

## 5. Time-Window Guards

**Summary**
Allow outbound rules or global configuration to define time windows during which dispatch is permitted. Dispatches outside those windows are deferred or denied.

**Motivation**
Many organisations have "no-deploy Fridays" or maintenance blackout windows. Currently a pipeline triggered at 23:55 on Friday would dispatch to production without any time-based check.

**Proposed `dispatching.yml` extension**

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

`defer` places the dispatch in a pending queue and retries when the next allowed window opens. `reject` denies the dispatch immediately with a logged reason.

**Architecture notes**
- A scheduled Lambda (CloudWatch Events) would run every minute to check for deferred dispatches that can now be released.
- Deferred dispatch records would be stored in DynamoDB with the earliest-eligible-dispatch timestamp as a sort key.

---

## 6. Deployment Environment Promotion Pipeline

**Summary**
Provide a first-class concept of **environments** (dev → staging → prod) with guardrails that prevent promotion if a lower environment is in a failing state.

**Motivation**
Today there is no mechanism to block a production dispatch if the staging deployment recently failed. Environment promotion pipelines are a common pattern that the dispatcher is well-positioned to support natively.

**Proposed `dispatching.yml` extension**

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

**Architecture notes**
- The dispatcher would check the DynamoDB projections for the most recent dispatch to the `staging` environment for this repository. If the most recent dispatch is a failure or is older than the healthy window, the production dispatch is denied.
- This creates a data-driven promotion gate with no external tooling required.

---

## 7. Rollback Trigger on Target Failure

**Summary**
Allow an outbound rule to declare a rollback workflow that is automatically dispatched when a target workflow run fails.

**Motivation**
When a deployment fails, the team usually wants to trigger a rollback as fast as possible. Today this requires a separate pipeline or manual intervention.

**Proposed `dispatching.yml` extension**

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

**Architecture notes**
- The dispatcher already listens for `workflow_run.completed` events. A `rollback` step would be triggered when the monitored target workflow run completes with conclusion `failure`.
- This needs careful loop-prevention logic: rollback workflows must not themselves trigger further rollbacks or dispatch chains.
- A new fact type `dispatch.rollback.triggered` would be emitted.

---

## 8. Notifications (Slack / Teams / Webhook)

**Summary**
Allow outbound rules or global configuration to specify notification targets that receive a message when a dispatch succeeds, fails, or is denied.

**Motivation**
Today the only side-effect of a dispatch outcome is a GitHub issue. Many teams prefer Slack or Microsoft Teams notifications, or want to call a custom webhook (e.g. PagerDuty, Opsgenie, Statuspage).

**Proposed global `dispatching.yml` extension**

```yaml
notifications:
  on_success:
    - type: slack
      webhook_secret: SLACK_WEBHOOK_SECRET   # name of a GitHub App secret or AWS Secrets Manager ARN
      message: "✅ {{ source.workflow }} → {{ target.workflow }} dispatched successfully"
  on_failure:
    - type: teams
      webhook_secret: TEAMS_WEBHOOK_SECRET
    - type: webhook
      url: https://hooks.example.com/dispatcher-alert
      method: POST
      headers:
        Authorization: "Bearer {{ secret.ALERT_TOKEN }}"
```

**Architecture notes**
- Notification delivery would be handled by a new `notifications-handler` Lambda triggered by the EventBridge facts bus, keeping the main dispatch path clean.
- Secrets for notification webhooks must be stored in AWS Secrets Manager and never appear in `dispatching.yml` in plaintext.

---

## 9. Additional Trigger Events

**Summary**
Extend the dispatcher to react to GitHub events beyond `workflow_run.completed`, including `push` (to a tagged ref), `release.published`, `pull_request.merged`, and `schedule`.

**Motivation**
Many teams want to trigger a CD workflow when a semantic version tag is pushed, not just when a CI workflow passes. Others want a nightly rollup build dispatched on a schedule.

**Proposed additional event types in `dispatching.yml`**

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
    cron: "0 2 * * 1-5"   # 02:00 UTC Mon–Fri
    targets:
      - repository: org/target-repo
        workflow: nightly-integration.yml
```

**Architecture notes**
- The ingress Lambda's webhook router would need to handle additional event types alongside `workflow_run`.
- Scheduled triggers would require a CloudWatch Events rule per declared cron entry, created by Terraform. Schedules declared in `dispatching.yml` would be read once and used to generate Terraform configuration — they would not be applied dynamically at runtime.

---

## 10. Dry-Run / Preview Mode

**Summary**
Add a `?dry_run=true` query parameter (or a request header) to the webhook endpoint that evaluates the full dispatch plan (authorization, guardrails, matching) but does not call the GitHub API or produce any side effects.

**Motivation**
Operators adding new `dispatching.yml` rules want to validate them against a real payload before enabling them. There is currently no way to do this without risking an unintended dispatch.

**Implementation notes**
- In dry-run mode the service logs what would have been dispatched and returns the planned actions in the response body.
- An explicit `X-Dispatcher-Dry-Run: true` header is safer than a query parameter for POST requests, as it cannot be accidentally included in a bookmarked URL.
- Dry-run results should be emitted as a new fact type `dispatch.plan.dryrun` to the EventBridge bus for audit purposes.
- The dry-run path could be used in CI to validate changes to `dispatching.yml` before merging.

---

## 11. Gradual Rollout (Canary Dispatch)

**Summary**
Allow an outbound rule to specify that only a percentage of eligible dispatch events should actually trigger the target workflow, enabling canary or staged rollout of new pipeline relationships.

**Motivation**
When introducing a new cross-repo dispatch rule, teams may want to observe the behaviour for 10% of builds before rolling it out to 100%. This mirrors the concept of feature flags applied to dispatch rules.

**Proposed `dispatching.yml` extension**

```yaml
outbound:
  - source:
      workflow: ci.yml
    targets:
      - repository: org/target-repo
        workflow: cd.yml
        rollout_percentage: 10
```

**Implementation notes**
- The dispatcher hashes the source `run_id` modulo 100 and compares it to the rollout percentage. This gives a deterministic, reproducible result for any given run — the same run will always be in or out of the canary.
- Canary denials should emit a `dispatch.target.canary_skipped` fact for tracking adoption.

---

## 12. Multi-Organisation Support

**Summary**
Allow the dispatcher to cross GitHub organisation boundaries — dispatching from a workflow in `org-a/repo` to a workflow in `org-b/repo`, provided both repositories' `dispatching.yml` files permit it and the GitHub App is installed in both organisations.

**Motivation**
Large enterprises often have separate GitHub organisations for different business units that still need coordinated delivery pipelines.

**Implementation notes**
- The dispatcher already uses per-installation Octokit clients. The primary change is ensuring that the GitHub App is installed in all participating organisations and that installation ID lookup covers both organisations.
- The `dispatching.yml` outbound `repository` field already supports `owner/repo` format, so no schema change is needed — only the installation-fetching logic needs to handle cross-org cases.
- A new guardrail `ALLOWED_TARGET_ORGS` (comma-separated allowlist) would restrict cross-org dispatch to explicitly permitted organisations.

---

## 13. GitHub Deployment API Integration

**Summary**
When the dispatcher triggers a target workflow, create a GitHub Deployment (via the Deployments API) in the target repository so that deployment status appears in the GitHub UI (pull request checks, environment tab, etc.).

**Motivation**
GitHub's native deployment tracking (on the pull request and the environment tab) is currently decoupled from the dispatcher. Teams have no way to see in the GitHub UI that a deployment was triggered by the dispatcher rather than by a native GitHub Actions environment.

**Proposed `dispatching.yml` extension**

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

**Implementation notes**
- The dispatcher would call `POST /repos/{owner}/{repo}/deployments` before triggering the workflow dispatch, then update the deployment status to `in_progress`.
- A companion Lambda or extension to the facts-processor could listen for the target `workflow_run.completed` event and update the deployment status to `success` or `failure`.

---

## 14. Dispatch Replay from Admin UI

**Summary**
Add a "Replay" button in the admin observability dashboard that re-triggers a past dispatch — either re-running a failed dispatch or re-enqueuing a historical one for testing purposes.

**Motivation**
When a dispatch fails due to a transient GitHub API error, operators currently have no way to replay it without re-running the source workflow. A replay button in the dashboard would allow safe, targeted retries with full audit trail support.

**Implementation notes**
- The replay action would read the original dispatch work item from DynamoDB and re-enqueue it to the `dispatch-targets` SQS queue.
- A replay would emit a new `dispatch.trigger.replayed` fact to distinguish it from an original dispatch in the audit log.
- Replay should be gated behind the `ADMIN_IP_ALLOWLIST` check and should generate a new correlation ID derived from the original (e.g. `{original-delivery-id}#replay-{n}`).
- The dashboard UI should indicate which deliveries are replays and link them to their originals.

---

## 15. Dispatch History Diff View

**Summary**
Add a dashboard view that shows what changed between two dispatch plans for the same source repository — making it easy to see when a new target was added, an existing one was removed, or authorisation for a route was revoked.

**Motivation**
Over time, `dispatching.yml` files change. Currently there is no way to see — from the dispatcher's perspective — what the effect of those changes was. The diff view would surface "these targets were dispatched last week but not this week" and "this new target first appeared on Tuesday".

**Implementation notes**
- The facts-processor would maintain a per-repo "last known dispatch plan" projection in DynamoDB.
- The diff view endpoint (`GET /admin/api/diff?repo=org/repo&since=7d`) would compare the current plan with the stored snapshot and return added, removed, and unchanged targets.
- No new GitHub API calls are required — only DynamoDB projection reads.

---

## 16. Supply Chain Attestation Passthrough

**Summary**
When the source workflow produces an SLSA provenance attestation or an SBOM (Software Bill of Materials), automatically pass a reference to that attestation as an input to the target workflow so that the deployment pipeline can verify it before proceeding.

**Motivation**
Supply chain security is increasingly important. Teams using tools like `attest-build-provenance` or Sigstore in CI want the dispatcher to carry attestation evidence forward into deployment pipelines without requiring manual input wiring in every `dispatching.yml`.

**Proposed mechanism**
- The dispatcher would call the GitHub Attestations API to check whether the source run produced any attestations for its output artifacts.
- If attestations are found, their IDs or bundle references are injected as a reserved input (`_attestation_id`, `_sbom_url`) when calling `workflow_dispatch` on the target.
- This feature would be opt-in per target using `pass_attestations: true` in the outbound rule.

**Proposed `dispatching.yml` extension**

```yaml
outbound:
  - source:
      workflow: build.yml
    targets:
      - repository: org/target-repo
        workflow: deploy.yml
        pass_attestations: true
```

---

*This document was created as part of the feature ideation process for GitHub Workflow Dispatcher. No implementation work has been started for any of these features.*
