# Terraform Deployment (AWS)

This folder contains Terraform for deploying dispatcher_v2 as a GitHub App backend on AWS.

## Layout

- modules/dispatcher_service: reusable AWS deployment module
- environments/dev: dev stack
- environments/prod: prod stack

## What this deploys

- VPC with two public subnets
- ECS Fargate service running the Node.js app
- ECR repository for images
- ALB with health checks on /health
- IAM roles for ECS task/execution
- CloudWatch log group
- Optional managed secrets in AWS Secrets Manager for:
  - GITHUB_WEBHOOK_SECRET
  - GITHUB_APP_PRIVATE_KEY
- Optional HTTPS and DNS if you supply ACM/Route53 inputs

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

4. Get webhook URL from output webhook_url and configure GitHub App webhook URL for:

- https://github.com/apps/org-repo-workflows-runner-alpha

## Remote State Bootstrap

Use the bootstrap helper to create Terraform backend resources (S3 state + DynamoDB lock table):

  AWS_PROFILE=nhs-notify-admin ./bootstrap-backend.sh \
    --bucket dispatcher-v2-tf-state \
    --lock-table dispatcher-v2-tf-locks \
    --region eu-west-2

After running it:

- Set GitHub variables `TF_STATE_BUCKET`, `TF_STATE_REGION`, `TF_STATE_LOCK_TABLE`.
- Migrate existing local dev state with `terraform init -migrate-state -force-copy`.
- Initialize prod backend with `terraform init -reconfigure`.

## Notes

- Runtime code must never run Terraform.
- Infrastructure provisioning stays in this folder only.
- For production, configure a custom domain + ACM cert + Route53 zone.
- CI/CD workflow is defined in .github/workflows/ci-cd.yml.
- Required runtime secrets/variables are documented in docs/deployment-secrets.md.
