# Terraform Deployment (AWS)

This folder contains Terraform for deploying GitHub Workflow Dispatcher as a GitHub App backend on AWS.

## Layout

- modules/dispatcher_service: reusable AWS deployment module
- environments/dev: dev stack
- environments/prod: prod stack

## What this deploys

- ECR repository for images
- API Gateway HTTP API for webhook and admin routes
- Lambda functions for ingress, planner, dispatcher, facts processing, and admin observability
- SQS queues for request and target dispatch work
- EventBridge bus for dispatch lifecycle facts
- DynamoDB tables for event history and projections
- IAM roles and policies for Lambda runtime access
- Optional managed secrets in AWS Secrets Manager for:
  - GITHUB_WEBHOOK_SECRET
  - GITHUB_APP_PRIVATE_KEY

## Prerequisites

- Terraform >= 1.6
- AWS credentials configured
- Container image built and pushed to ECR (or another reachable registry)

## Sensitive Deployment Identity Policy

- Do not commit AWS account IDs, role names, role ARNs, or profile details into repository files.
- Supply AWS deployment identity at runtime only, for example with shell environment values or CI secret variables.
- Keep these values out of PLAN.md updates, terraform.tfvars in source control, and committed workflow files.
- Use local-only files (already gitignored) for any environment-specific credential setup.

## Quick start

1. Copy example values:

   cp environments/dev/terraform.tfvars.example environments/dev/terraform.tfvars

2. Fill required values in terraform.tfvars:

- github_app_id
- container_image
- either:
  - create_managed_secrets = true and then put secret values into created secrets after apply
  - or set existing github_webhook_secret_arn and github_app_private_key_arn

3. Run Terraform:

   cd environments/dev
   terraform init
   terraform validate
   terraform plan
   terraform apply

Optional runtime identity pattern (local shell):

  export AWS_PROFILE="your-local-profile"
  export AWS_REGION="eu-west-2"
  terraform plan

Optional helper script pattern (`scripts/apply-dev-infra.sh`):

- The script reads `.env` values for `TF_VAR_github_app_id` and `TF_VAR_container_image`.
- It also accepts `LAMBDA_IMAGE_URI=...` as an optional override; otherwise Lambdas use `TF_VAR_container_image`.

4. Get webhook URL from output webhook_url and configure GitHub App webhook URL for:

- https://github.com/apps/org-repo-workflows-runner-alpha

## Remote State Bootstrap

Use the bootstrap helper to create the Terraform backend S3 bucket:

  AWS_PROFILE=nhs-notify-admin ./bootstrap-backend.sh \
    --bucket dispatcher-v2-tf-state \
    --region eu-west-2

After running it:

- Set GitHub variables `TF_STATE_BUCKET`, `TF_STATE_REGION`.
- Migrate existing local dev state with `terraform init -migrate-state -force-copy`.
- Initialize prod backend with `terraform init -reconfigure`.

## Notes

- Runtime code must never run Terraform.
- Infrastructure provisioning stays in this folder only.
- CI/CD workflow is defined in .github/workflows/ci-cd.yml.
- Required runtime secrets/variables are documented in docs/deployment-secrets.md.
