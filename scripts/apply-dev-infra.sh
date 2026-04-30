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
load_env_var TF_VAR_app_image_tag
load_env_var TF_VAR_app_image_sha
load_env_var LAMBDA_IMAGE_URI
load_env_var GHCR_IMAGE
load_env_var GHCR_TOKEN
load_env_var ECR_REPO_DEV

PROFILE="${AWS_PROFILE:-nhs-notify-admin}"
REGION="${AWS_REGION:-eu-west-2}"
PLAN_ONLY=false
AUTO_APPROVE=false
BUILD_AND_PUSH_IMAGE=true
USE_GITHUB_IMAGE=""

GHCR_IMAGE="${GHCR_IMAGE:-}"
if [[ -z "$GHCR_IMAGE" ]]; then
  REMOTE_URL=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")
  if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    _REPO_OWNER=$(echo "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')
    _REPO_NAME=$(echo "${BASH_REMATCH[2]}" | tr '[:upper:]' '[:lower:]')
    GHCR_IMAGE="ghcr.io/${_REPO_OWNER}/${_REPO_NAME}/app"
  else
    GHCR_IMAGE="ghcr.io/rossbugginsnhs/github-workflow-dispatcher/app"
  fi
fi
ECR_REPO_DEV="${ECR_REPO_DEV:-dispatcher-v2-dev-dispatcher}"

usage() {
  cat <<EOF
Usage: $0 [--plan-only] [--auto-approve] [--skip-image-build] [--use-github-image <tag>]

Options:
  --plan-only              Run terraform plan only (no apply)
  --auto-approve           Apply without interactive approval
  --skip-image-build       Do not build/push a new image; use TF_VAR_* image env vars as-is
  --use-github-image <tag> Pull the specified image tag from GHCR, promote it to ECR,
                           and deploy without a local build (e.g. sha-abc1234, 1.2.3, latest)
                           Note: release tags should be given without the 'v' prefix (e.g. 1.2.3 not v1.2.3)

Environment variables:
  ECR_REPO_DEV Override the dev ECR repository name (default: dispatcher-v2-dev-dispatcher)
  GHCR_IMAGE   Override the GHCR source image base (default: $GHCR_IMAGE)
  GHCR_TOKEN   Personal access token (or GitHub token) for GHCR login.
               If unset, the script tries 'gh auth token' as a fallback.
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
    --use-github-image)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "ERROR: --use-github-image requires a tag argument (e.g. sha-abc1234, 1.2.3, latest)" >&2
        usage >&2
        exit 1
      fi
      USE_GITHUB_IMAGE="${2#v}"
      BUILD_AND_PUSH_IMAGE=false
      shift 2
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

if [[ -n "$USE_GITHUB_IMAGE" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found in PATH (required to pull and promote GHCR image)." >&2
    exit 1
  fi

  ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO_DEV}"
  GHCR_SOURCE_IMAGE="${GHCR_IMAGE}:${USE_GITHUB_IMAGE}"
  ECR_IMAGE_URI="${ECR_REPO}:${USE_GITHUB_IMAGE}"

  echo "==> GHCR login"
  GHCR_LOGIN_TOKEN="${GHCR_TOKEN:-}"
  if [[ -z "$GHCR_LOGIN_TOKEN" ]] && command -v gh >/dev/null 2>&1; then
    GHCR_LOGIN_TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
  if [[ -n "$GHCR_LOGIN_TOKEN" ]]; then
    # 'x-access-token' is the required username for GHCR token authentication (PAT or GitHub token)
    echo "$GHCR_LOGIN_TOKEN" | docker login ghcr.io --username x-access-token --password-stdin
  else
    echo "WARN: no GHCR_TOKEN or gh CLI token found; assuming Docker is already authenticated to ghcr.io" >&2
  fi

  echo "==> ECR login"
  AWS_PAGER="" aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

  echo "==> Pulling image from GHCR: $GHCR_SOURCE_IMAGE"
  docker pull "$GHCR_SOURCE_IMAGE"

  echo "==> Tagging for ECR: $ECR_IMAGE_URI"
  docker tag "$GHCR_SOURCE_IMAGE" "$ECR_IMAGE_URI"

  echo "==> Pushing to ECR: $ECR_IMAGE_URI"
  docker push "$ECR_IMAGE_URI"

  export TF_VAR_container_image="$ECR_IMAGE_URI"
  export TF_VAR_lambda_image_uri="$ECR_IMAGE_URI"

  if [[ -z "${TF_VAR_app_image_tag:-}" ]]; then
    export TF_VAR_app_image_tag="$USE_GITHUB_IMAGE"
  fi

  if [[ -z "${TF_VAR_app_image_sha:-}" ]]; then
    _full_digest=$(docker inspect --format='{{index .RepoDigests 0}}' "$GHCR_SOURCE_IMAGE" 2>/dev/null || true)
    _image_sha="${_full_digest##*@}"
    if [[ -n "$_image_sha" ]]; then
      export TF_VAR_app_image_sha="$_image_sha"
    fi
  fi
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
  ECR_REPO="${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO_DEV}"
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

  if [[ -z "${TF_VAR_app_image_tag:-}" ]]; then
    export TF_VAR_app_image_tag="$IMAGE_TAG"
  fi

  if [[ -z "${TF_VAR_app_image_sha:-}" ]]; then
    _full_digest=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_URI" 2>/dev/null || true)
    _image_sha="${_full_digest##*@}"
    if [[ -n "$_image_sha" ]]; then
      export TF_VAR_app_image_sha="$_image_sha"
    fi
  fi
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
echo "==> Terraform inputs: app_image_tag=${TF_VAR_app_image_tag:-<not set>}"
echo "==> Terraform inputs: app_image_sha=${TF_VAR_app_image_sha:-<not set>}"

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

plan_infra() {
  echo "==> Terraform plan"
  terraform -chdir="$TF_DIR" plan -out=tfplan
}

import_preexisting_log_groups() {
  local imported_any=false
  local project_name
  local env_name="dev"
  local name_prefix
  local suffix resource_address log_group_name

  project_name="${TF_VAR_project_name:-dispatcher-v2}"
  name_prefix="${project_name}-${env_name}"

  for suffix in ingress planner dispatcher admin facts-processor; do
    resource_address="module.dispatcher_service.aws_cloudwatch_log_group.${suffix//-/_}"
    log_group_name="/aws/lambda/${name_prefix}-${suffix}"

    if terraform -chdir="$TF_DIR" state show "$resource_address" >/dev/null 2>&1; then
      continue
    fi

    if ! AWS_PAGER="" aws logs describe-log-groups \
      --region "$REGION" \
      --log-group-name-prefix "$log_group_name" \
      --query "length(logGroups[?logGroupName=='${log_group_name}'])" \
      --output text >/tmp/dispatcher-dev-loggroup-check.txt 2>/tmp/dispatcher-dev-loggroup-check.err; then
      echo "ERROR: failed checking log group existence: $log_group_name" >&2
      cat /tmp/dispatcher-dev-loggroup-check.err >&2
      return 1
    fi

    if [[ "$(cat /tmp/dispatcher-dev-loggroup-check.txt)" != "1" ]]; then
      continue
    fi

    echo "==> Importing existing CloudWatch log group into state"
    echo "    address: $resource_address"
    echo "    id:      $log_group_name"
    terraform -chdir="$TF_DIR" import "$resource_address" "$log_group_name"
    imported_any=true
  done

  if [[ "$imported_any" == "true" ]]; then
    return 0
  fi

  return 1
}

run_apply() {
  local apply_log
  local apply_exit=0
  apply_log="$(mktemp -t dispatcher-dev-apply.XXXXXX.log)"

  echo "==> Terraform apply"
  if [[ "$AUTO_APPROVE" == "true" ]]; then
    terraform -chdir="$TF_DIR" apply -auto-approve tfplan 2>&1 | tee "$apply_log" || apply_exit=$?
  else
    terraform -chdir="$TF_DIR" apply tfplan 2>&1 | tee "$apply_log" || apply_exit=$?
  fi

  if [[ "$apply_exit" -eq 0 ]]; then
    rm -f "$apply_log"
    return 0
  fi

  if grep -q "ResourceAlreadyExistsException: The specified log group already exists" "$apply_log"; then
    echo "==> Detected existing CloudWatch log groups not tracked in Terraform state"
    if import_preexisting_log_groups; then
      echo "==> Re-planning after importing existing log groups"
      plan_infra

      echo "==> Retrying terraform apply"
      if [[ "$AUTO_APPROVE" == "true" ]]; then
        terraform -chdir="$TF_DIR" apply -auto-approve tfplan
      else
        terraform -chdir="$TF_DIR" apply tfplan
      fi
      rm -f "$apply_log"
      return 0
    fi
  fi

  rm -f "$apply_log"
  return "$apply_exit"
}

plan_infra

if [[ "$PLAN_ONLY" == "true" ]]; then
  echo "==> Plan-only mode complete"
  exit 0
fi

run_apply

echo "==> Done"
