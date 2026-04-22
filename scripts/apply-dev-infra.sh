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
load_env_var TF_STATE_LOCK_TABLE
load_env_var TF_STATE_REGION
load_env_var TF_VAR_github_app_id
load_env_var TF_VAR_container_image
load_env_var TF_VAR_enable_fargate
load_env_var TF_VAR_enable_async_pipeline
load_env_var TF_VAR_lambda_image_uri
load_env_var LAMBDA_ECR_REPOSITORY_NAME
load_env_var LAMBDA_IMAGE_TAG

PROFILE="${AWS_PROFILE:-nhs-notify-admin}"
REGION="${AWS_REGION:-eu-west-2}"
PLAN_ONLY=false
AUTO_APPROVE=false

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
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--plan-only] [--auto-approve]" >&2
      exit 1
      ;;
  esac
done

if ! command -v terraform >/dev/null 2>&1; then
  echo "ERROR: terraform not found in PATH" >&2
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

if [[ -n "${GITHUB_APP_ID:-}" && -z "${TF_VAR_github_app_id:-}" ]]; then
  export TF_VAR_github_app_id="$GITHUB_APP_ID"
fi

export TF_VAR_enable_fargate="${TF_VAR_enable_fargate:-false}"
export TF_VAR_enable_async_pipeline="${TF_VAR_enable_async_pipeline:-true}"

if [[ -z "${TF_VAR_github_app_id:-}" ]]; then
  echo "ERROR: TF_VAR_github_app_id is required (set GITHUB_APP_ID in .env or TF_VAR_github_app_id)." >&2
  exit 1
fi

if [[ "${TF_VAR_enable_fargate}" == "true" && -z "${TF_VAR_container_image:-}" ]]; then
  if [[ -z "${AWS_ACCOUNT_ID:-}" ]]; then
    AWS_ACCOUNT_ID=$(python3 -c "import json; print(json.load(open('/tmp/apply-dev-caller.json'))['Account'])")
    export AWS_ACCOUNT_ID
  fi
  export TF_VAR_container_image="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/dispatcher-v2-dev-dispatcher:latest"
fi

if [[ "${TF_VAR_enable_async_pipeline}" == "true" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found in PATH (required to build Lambda image for async pipeline)." >&2
    exit 1
  fi

  if [[ -z "${AWS_ACCOUNT_ID:-}" ]]; then
    AWS_ACCOUNT_ID=$(python3 -c "import json; print(json.load(open('/tmp/apply-dev-caller.json'))['Account'])")
    export AWS_ACCOUNT_ID
  fi

  LAMBDA_REPO_NAME="${LAMBDA_ECR_REPOSITORY_NAME:-dispatcher-v2-dev-dispatcher}"
  LAMBDA_IMAGE_TAG="${LAMBDA_IMAGE_TAG:-lambda-$(date -u +%Y%m%d%H%M%S)}"
  LAMBDA_IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${LAMBDA_REPO_NAME}:${LAMBDA_IMAGE_TAG}"

  echo "==> Ensuring ECR repository exists: ${LAMBDA_REPO_NAME}"
  if ! AWS_PAGER="" AWS_PROFILE="$PROFILE" aws ecr describe-repositories --region "$REGION" --repository-names "$LAMBDA_REPO_NAME" >/dev/null 2>&1; then
    AWS_PAGER="" AWS_PROFILE="$PROFILE" aws ecr create-repository --region "$REGION" --repository-name "$LAMBDA_REPO_NAME" >/dev/null
  fi

  echo "==> ECR login"
  AWS_PAGER="" AWS_PROFILE="$PROFILE" aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

  echo "==> Building Lambda image: ${LAMBDA_IMAGE_URI}"
  docker build -f "$REPO_ROOT/Dockerfile.lambda" -t "$LAMBDA_IMAGE_URI" "$REPO_ROOT"

  echo "==> Pushing Lambda image"
  docker push "$LAMBDA_IMAGE_URI"

  export TF_VAR_lambda_image_uri="$LAMBDA_IMAGE_URI"
fi

if [[ "${TF_VAR_enable_async_pipeline}" == "true" && -z "${TF_VAR_lambda_image_uri:-}" ]]; then
  echo "ERROR: async pipeline enabled but TF_VAR_lambda_image_uri is empty." >&2
  exit 1
fi

BACKEND_FILE="$TF_DIR/backend.hcl"
BACKEND_ARG=()

if [[ -f "$BACKEND_FILE" ]]; then
  BACKEND_ARG=(-backend-config="$BACKEND_FILE")
elif [[ -n "${TF_STATE_BUCKET:-}" && -n "${TF_STATE_LOCK_TABLE:-}" ]]; then
  TMP_BACKEND="/tmp/dispatcher-dev-backend.hcl"
  cat > "$TMP_BACKEND" <<EOF
bucket         = "${TF_STATE_BUCKET}"
key            = "dispatcher-v2/dev/terraform.tfstate"
region         = "${TF_STATE_REGION:-$REGION}"
encrypt        = true
dynamodb_table = "${TF_STATE_LOCK_TABLE}"
EOF
  BACKEND_ARG=(-backend-config="$TMP_BACKEND")
else
  echo "ERROR: Terraform backend config not found." >&2
  echo "Create $TF_DIR/backend.hcl or set TF_STATE_BUCKET and TF_STATE_LOCK_TABLE in .env." >&2
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
