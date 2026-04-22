#!/usr/bin/env bash
# One-off: import pre-existing Lambda log groups into Terraform state.
# Run once then delete this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
TF_DIR="$REPO_ROOT/infrastructure/terraform/environments/dev"
ENV_FILE="$REPO_ROOT/.env"

load_env_var() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then return 0; fi
  if [[ ! -f "$ENV_FILE" ]]; then return 0; fi
  local value
  value=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d'=' -f2- || true)
  if [[ -n "$value" ]]; then export "$key=$value"; fi
}

load_env_var AWS_PROFILE
load_env_var AWS_REGION

PROFILE="${AWS_PROFILE:-nhs-notify-admin}"
REGION="${AWS_REGION:-eu-west-2}"

echo "==> AWS profile: $PROFILE"
if ! AWS_PROFILE="$PROFILE" aws sts get-caller-identity --output json >/dev/null 2>&1; then
  echo "ERROR: Run: aws sso login --profile $PROFILE" >&2
  exit 1
fi
export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"

tf() { terraform -chdir="$TF_DIR" "$@"; }

log_groups=(
  "module.dispatcher_service.aws_cloudwatch_log_group.lambda_ingress[0]:/aws/lambda/dispatcher-v2-dev-ingress"
  "module.dispatcher_service.aws_cloudwatch_log_group.lambda_planner[0]:/aws/lambda/dispatcher-v2-dev-planner"
  "module.dispatcher_service.aws_cloudwatch_log_group.lambda_dispatcher[0]:/aws/lambda/dispatcher-v2-dev-dispatcher"
  "module.dispatcher_service.aws_cloudwatch_log_group.lambda_projection[0]:/aws/lambda/dispatcher-v2-dev-projection"
  "module.dispatcher_service.aws_cloudwatch_log_group.lambda_admin_observability[0]:/aws/lambda/dispatcher-v2-dev-admin-observability"
)

for entry in "${log_groups[@]}"; do
  addr="${entry%%:*}"
  id="${entry#*:}"
  echo "==> Importing $addr"
  tf import "$addr" "$id" || echo "  (already imported or failed, continuing)"
done

echo "==> Done. Run ./scripts/apply-dev-infra.sh to finish."
