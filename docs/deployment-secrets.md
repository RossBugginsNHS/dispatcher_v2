# Deployment Secrets and Variables

This project deploys using GitHub Actions and must keep account/role identity values out of source control.

## Required GitHub Secrets

Set these in repository or environment secrets:

- AWS_ROLE_TO_ASSUME
- APP_ID

Set with gh CLI:

```bash
gh secret set AWS_ROLE_TO_ASSUME --body "arn:aws:iam::<account-id>:role/<role-name>"
gh secret set APP_ID --body "<github-app-id>"
```

Notes:
- Keep role/account identifiers in secrets/variables only.
- Do not commit role ARN, account ID, or profile names in repository files.

## Required GitHub Variables

Set these in repository or environment variables:

- AWS_REGION
- ECR_REPOSITORY_DEV
- ECR_REPOSITORY_PROD

Set with gh CLI:

```bash
gh variable set AWS_REGION --body "eu-west-2"
gh variable set ECR_REPOSITORY_DEV --body "dispatcher-v2-dev-dispatcher"
gh variable set ECR_REPOSITORY_PROD --body "dispatcher-v2-prod-dispatcher"
```

Create environments with gh CLI:

```bash
gh api -X PUT repos/<owner>/<repo>/environments/dev
gh api -X PUT repos/<owner>/<repo>/environments/prod
```

## Recommended Environment Protection

Use GitHub environments:

- dev
- prod

For prod environment:
- Require manual reviewers before jobs can deploy.
- Scope prod secrets/variables to prod environment only.

## Runtime-only policy

All AWS identity and account details are supplied at runtime through GitHub settings. Repository files should contain placeholders or generic names only.

## Populate AWS Secrets Manager values

After first Terraform apply creates placeholder secrets, follow:

- docs/aws-secrets-bootstrap.md
