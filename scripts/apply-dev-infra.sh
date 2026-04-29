#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
TF_DIR="$REPO_ROOT/infrastructure/terraform/environments/dev"
ENV_FILE="$REPO_ROOT/.env"

load_env_var() {
  local key="$1"
  local value
  if [[ -n "${!key:-}" ]]; then
    return 0
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  value=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d'=' -f2- || true)
  if [[ -n "$value" ]]; then
    export "$key=$value"
  fi
}

load_env_var AWS_PROFILE
load_env_var AWS_REGION
load_env_var GITHUB_APP_ID
load_env_var AWS_ACCOUNT_ID
load_env_var TF_STATE_BUCKET
load_env_var TF_STATE_REGION
load_env_var TF_VAR_github_app_id
load_env_var TF_VAR_container_image
load_env_var TF_VAR_lambda_image_uri
load_env_var LAMBDA_IMAGE_URI

PROFILE="${AWS_PROFILE:-nhs-notify-admin}"
REGION="${AWS_REGION:-eu-west-2}"
PLAN_ONLY=false
AUTO_APPROVE=false
BUILD_AND_PUSH_IMAGE=true

usage() {
  cat <<EOF
Usage: $0 [--plan-only] [--auto-approve] [--skip-image-build]

Options:
  --plan-only         Run terraform plan only (no apply)
  --auto-approve      Apply without interactive approval
  --skip-image-build  Do not build/push a new image; use TF_VAR_* image env vars as-is
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan-only)
      PLAN_ONLY=true
      shift
      ;;
    --auto-approve)
      AUTO_APPROVE=true
      shift
      ;;
    --skip-image-build)
      BUILD_AND_PUSH_IMAGE=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v terraform >/dev/null 2>&1; then
  echo "ERROR: terraform not found in PATH" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not found in PATH" >&2
  exit 1
fi

echo "==> AWS profile: $PROFILE"
if ! AWS_PROFILE="$PROFILE" aws sts get-caller-identity --output json >/tmp/apply-dev-caller.json 2>/tmp/apply-dev-sts.err; then
  echo "ERROR: AWS credentials are not valid for profile '$PROFILE'." >&2
  echo "Run: aws sso login --profile $PROFILE" >&2
  cat /tmp/apply-dev-sts.err >&2
  exit 1
fi

export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"

if [[ -z "${AWS_ACCOUNT_ID:-}" ]]; then
  AWS_ACCOUNT_ID="$(AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" aws sts get-caller-identity --query 'Account' --output text)"
  export AWS_ACCOUNT_ID
fi

if [[ -n "${GITHUB_APP_ID:-}" && -z "${TF_VAR_github_app_id:-}" ]]; then
  export TF_VAR_github_app_id="$GITHUB_APP_ID"
fi

if [[ -n "${LAMBDA_IMAGE_URI:-}" && -z "${TF_VAR_lambda_image_uri:-}" ]]; then
  export TF_VAR_lambda_image_uri="$LAMBDA_IMAGE_URI"
fi

if [[ "$BUILD_AND_PUSH_IMAGE" == "true" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found in PATH (required to build and publish latest image)." >&2
    echo "Use --skip-image-build only if you set TF_VAR_container_image/TF_VAR_lambda_image_uri explicitly." >&2
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm not found in PATH (required for local build validation before image publish)." >&2
    exit 1
  fi

  IMAGE_TAG="dev-$(date -u +%Y%m%d%H%M%S)-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/dispatcher-v2-dev-dispatcher"
  IMAGE_URI="${ECR_REPO}:${IMAGE_TAG}"

  echo "==> Building app"
  (
    cd "$REPO_ROOT"
    npm ci --no-audit --no-fund
    npm run build
  )

  echo "==> ECR login"
  AWS_PAGER="" aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

  echo "==> Docker build: $IMAGE_URI"
  docker build -t "$IMAGE_URI" "$REPO_ROOT"

  echo "==> Docker push: $IMAGE_URI"
  docker push "$IMAGE_URI"

  export TF_VAR_container_image="$IMAGE_URI"
  export TF_VAR_lambda_image_uri="$IMAGE_URI"
fi

if [[ -n "${AWS_ACCOUNT_ID:-}" && -z "${TF_VAR_container_image:-}" ]]; then
  export TF_VAR_container_image="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/dispatcher-v2-dev-dispatcher:latest"
fi

if [[ -z "${TF_VAR_github_app_id:-}" ]]; then
  echo "ERROR: TF_VAR_github_app_id is required (set GITHUB_APP_ID in .env or TF_VAR_github_app_id)." >&2
  exit 1
fi

if [[ -z "${TF_VAR_container_image:-}" ]]; then
  echo "ERROR: TF_VAR_container_image is required (set in env/TF_VAR_container_image)." >&2
  exit 1
fi

if [[ -z "${TF_VAR_lambda_image_uri:-}" ]]; then
  export TF_VAR_lambda_image_uri="$TF_VAR_container_image"
fi

echo "==> Terraform inputs: container_image=${TF_VAR_container_image}"
echo "==> Terraform inputs: lambda_image=${TF_VAR_lambda_image_uri}"

BACKEND_FILE="$TF_DIR/backend.hcl"
BACKEND_ARG=()

if [[ -f "$BACKEND_FILE" ]]; then
  BACKEND_ARG=(-backend-config="$BACKEND_FILE")
elif [[ -n "${TF_STATE_BUCKET:-}" ]]; then
  TMP_BACKEND="/tmp/dispatcher-dev-backend.hcl"
  cat > "$TMP_BACKEND" <<EOF
bucket         = "${TF_STATE_BUCKET}"
key            = "dispatcher-v2/dev/terraform.tfstate"
region         = "${TF_STATE_REGION:-$REGION}"
encrypt        = true
use_lockfile   = true
EOF
  BACKEND_ARG=(-backend-config="$TMP_BACKEND")
else
  echo "ERROR: Terraform backend config not found." >&2
  echo "Create $TF_DIR/backend.hcl or set TF_STATE_BUCKET (and optional TF_STATE_REGION) in .env." >&2
  echo "Reference: $TF_DIR/backend.hcl.example" >&2
  exit 1
fi

echo "==> Terraform init"
terraform -chdir="$TF_DIR" init -reconfigure "${BACKEND_ARG[@]}"

echo "==> Terraform plan"
terraform -chdir="$TF_DIR" plan -out=tfplan

if [[ "$PLAN_ONLY" == "true" ]]; then
  echo "==> Plan-only mode complete"
  exit 0
fi

echo "==> Terraform apply"
if [[ "$AUTO_APPROVE" == "true" ]]; then
  terraform -chdir="$TF_DIR" apply -auto-approve tfplan
else
  terraform -chdir="$TF_DIR" apply tfplan
fi

echo "==> Done"
