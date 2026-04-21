# AWS Secrets Bootstrap (GitHub App)

Use this after the first Terraform apply creates placeholder secrets.

This stores the two required runtime secrets in AWS Secrets Manager:
- GITHUB_WEBHOOK_SECRET
- GITHUB_APP_PRIVATE_KEY

## 1. Prerequisites

- AWS CLI installed and authenticated for the target account/role.
- Terraform has already created the secret containers.
- You have:
  - Webhook secret value from GitHub App settings
  - Private key PEM file downloaded from GitHub App private keys

## 2. Set local shell variables (not committed)

```bash
export AWS_REGION="eu-west-2"
export ENVIRONMENT="dev"   # change to prod when needed
export PROJECT_NAME="dispatcher-v2"

# Fill this from GitHub App webhook settings
export WEBHOOK_SECRET_VALUE="<your-webhook-secret>"

# Path to the downloaded PEM file from GitHub App private keys
export APP_PRIVATE_KEY_FILE="$HOME/Downloads/org-repo-workflows-runner-alpha.private-key.pem"
```

## 3. Compute secret names

```bash
export SECRET_WEBHOOK_NAME="${PROJECT_NAME}-${ENVIRONMENT}/github-webhook-secret"
export SECRET_PRIVATE_KEY_NAME="${PROJECT_NAME}-${ENVIRONMENT}/github-app-private-key"
```

## 4. Verify secret containers exist

```bash
aws secretsmanager describe-secret --region "$AWS_REGION" --secret-id "$SECRET_WEBHOOK_NAME" >/dev/null
aws secretsmanager describe-secret --region "$AWS_REGION" --secret-id "$SECRET_PRIVATE_KEY_NAME" >/dev/null
```

## 5. Put secret values

```bash
aws secretsmanager put-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$SECRET_WEBHOOK_NAME" \
  --secret-string "$WEBHOOK_SECRET_VALUE"

aws secretsmanager put-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$SECRET_PRIVATE_KEY_NAME" \
  --secret-string "$(cat "$APP_PRIVATE_KEY_FILE")"
```

## 6. Repeat for prod

```bash
export ENVIRONMENT="prod"

export SECRET_WEBHOOK_NAME="${PROJECT_NAME}-${ENVIRONMENT}/github-webhook-secret"
export SECRET_PRIVATE_KEY_NAME="${PROJECT_NAME}-${ENVIRONMENT}/github-app-private-key"

aws secretsmanager put-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$SECRET_WEBHOOK_NAME" \
  --secret-string "$WEBHOOK_SECRET_VALUE"

aws secretsmanager put-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$SECRET_PRIVATE_KEY_NAME" \
  --secret-string "$(cat "$APP_PRIVATE_KEY_FILE")"
```

## 7. Sanity checks (no secret value output)

```bash
aws secretsmanager list-secret-version-ids --region "$AWS_REGION" --secret-id "$SECRET_WEBHOOK_NAME"
aws secretsmanager list-secret-version-ids --region "$AWS_REGION" --secret-id "$SECRET_PRIVATE_KEY_NAME"
```

## Notes

- Keep all values in environment variables or secret managers only.
- Do not commit secret values, account IDs, role names, or PEM contents to source control.
- Client secret from GitHub App is not required for this webhook/app-auth flow.
