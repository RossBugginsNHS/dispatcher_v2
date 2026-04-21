#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Bootstrap Terraform remote state backend resources (S3 + DynamoDB).

Usage:
  ./infrastructure/terraform/bootstrap-backend.sh \
    --bucket <state-bucket-name> \
    --lock-table <dynamodb-lock-table-name> \
    --region <aws-region>

Optional environment variables:
  AWS_PROFILE     AWS CLI profile to use
  AWS_REGION      Default region if --region is not provided

Examples:
  AWS_PROFILE=nhs-notify-admin ./infrastructure/terraform/bootstrap-backend.sh \
    --bucket dispatcher-v2-tf-state \
    --lock-table dispatcher-v2-tf-locks \
    --region eu-west-2
EOF
}

BUCKET=""
LOCK_TABLE=""
REGION="${AWS_REGION:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)
      BUCKET="$2"
      shift 2
      ;;
    --lock-table)
      LOCK_TABLE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$BUCKET" || -z "$LOCK_TABLE" || -z "$REGION" ]]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found in PATH" >&2
  exit 1
fi

AWS_ARGS=(--region "$REGION")
if [[ -n "${AWS_PROFILE:-}" ]]; then
  AWS_ARGS+=(--profile "$AWS_PROFILE")
fi

echo "==> Ensuring S3 bucket exists: $BUCKET"
if aws "${AWS_ARGS[@]}" s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "Bucket already exists"
else
  if [[ "$REGION" == "us-east-1" ]]; then
    aws "${AWS_ARGS[@]}" s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws "${AWS_ARGS[@]}" s3api create-bucket \
      --bucket "$BUCKET" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  echo "Bucket created"
fi

echo "==> Configuring S3 security defaults"
aws "${AWS_ARGS[@]}" s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled >/dev/null

aws "${AWS_ARGS[@]}" s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null

aws "${AWS_ARGS[@]}" s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

echo "==> Ensuring DynamoDB lock table exists: $LOCK_TABLE"
if aws "${AWS_ARGS[@]}" dynamodb describe-table --table-name "$LOCK_TABLE" >/dev/null 2>&1; then
  echo "Lock table already exists"
else
  aws "${AWS_ARGS[@]}" dynamodb create-table \
    --table-name "$LOCK_TABLE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws "${AWS_ARGS[@]}" dynamodb wait table-exists --table-name "$LOCK_TABLE"
  echo "Lock table created"
fi

cat <<EOF

Bootstrap complete.

Set these GitHub repository/environment variables:
  TF_STATE_BUCKET=$BUCKET
  TF_STATE_REGION=$REGION
  TF_STATE_LOCK_TABLE=$LOCK_TABLE

Migrate existing local dev state to remote backend:
  cd infrastructure/terraform/environments/dev
  terraform init -migrate-state -force-copy \
    -backend-config="bucket=$BUCKET" \
    -backend-config="key=dispatcher-v2/dev/terraform.tfstate" \
    -backend-config="region=$REGION" \
    -backend-config="encrypt=true" \
    -backend-config="dynamodb_table=$LOCK_TABLE"

Initialize prod backend (no migration needed if brand new):
  cd infrastructure/terraform/environments/prod
  terraform init -reconfigure \
    -backend-config="bucket=$BUCKET" \
    -backend-config="key=dispatcher-v2/prod/terraform.tfstate" \
    -backend-config="region=$REGION" \
    -backend-config="encrypt=true" \
    -backend-config="dynamodb_table=$LOCK_TABLE"
EOF
