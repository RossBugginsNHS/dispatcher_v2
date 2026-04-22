#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

ACCOUNT="${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID must be set in .env or environment}"
REGION="${AWS_REGION:-eu-west-2}"
ECR_REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/dispatcher-v2-dev-dispatcher"
CLUSTER=dispatcher-v2-dev-cluster
SERVICE=dispatcher-v2-dev-service
TASK_FAMILY=dispatcher-v2-dev-task
PROFILE="${AWS_PROFILE:-nhs-notify-admin}"

echo "==> AWS profile: $PROFILE"
if ! AWS_PROFILE="$PROFILE" aws sts get-caller-identity --output json >/tmp/deploy-dev-caller.json 2>/tmp/deploy-dev-sts.err; then
  echo "ERROR: AWS credentials are not valid for profile '$PROFILE'." >&2
  echo "Run: aws sso login --profile $PROFILE" >&2
  cat /tmp/deploy-dev-sts.err >&2
  exit 1
fi

CALLER_ACCOUNT=$(python3 -c "import json; print(json.load(open('/tmp/deploy-dev-caller.json'))['Account'])")
if [[ "$CALLER_ACCOUNT" != "$ACCOUNT" ]]; then
  echo "ERROR: Profile '$PROFILE' is authenticated to account '$CALLER_ACCOUNT' but AWS_ACCOUNT_ID is '$ACCOUNT'." >&2
  exit 1
fi

NEW_TAG=$(date -u +%Y%m%d%H%M%S)
echo "==> Tag: $NEW_TAG"

echo "==> ECR login"
AWS_PAGER="" AWS_PROFILE="$PROFILE" aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

echo "==> Docker build"
docker build -t "$ECR_REPO:$NEW_TAG" "$SCRIPT_DIR/.."

echo "==> Docker push"
docker push "$ECR_REPO:$NEW_TAG"

echo "==> Preparing task definition"
AWS_PAGER="" AWS_PROFILE="$PROFILE" aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" --region "$REGION" \
  --query 'taskDefinition' > /tmp/taskdef.json

python3 - <<PYEOF
import json
td = json.load(open('/tmp/taskdef.json'))
td['containerDefinitions'][0]['image'] = '$ECR_REPO:$NEW_TAG'
env = td['containerDefinitions'][0].get('environment') or []
env = [item for item in env if item.get('name') != 'APP_VERSION']
env.append({'name': 'APP_VERSION', 'value': '$NEW_TAG'})
td['containerDefinitions'][0]['environment'] = env
for k in ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy']:
    td.pop(k, None)
json.dump(td, open('/tmp/new_taskdef.json', 'w'))
print('Image set:', td['containerDefinitions'][0]['image'])
print('APP_VERSION set:', '$NEW_TAG')
PYEOF

echo "==> Registering new task definition"
NEW_ARN=$(AWS_PAGER="" AWS_PROFILE="$PROFILE" aws ecs register-task-definition \
  --cli-input-json file:///tmp/new_taskdef.json --region "$REGION" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "    $NEW_ARN"

echo "==> Updating ECS service"
AWS_PAGER="" AWS_PROFILE="$PROFILE" aws ecs update-service \
  --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$TASK_FAMILY" --region "$REGION" \
  --query 'service.deployments[*].{status:status,taskDef:taskDefinition}' \
  --output table

echo "==> Waiting for stable rollout..."
AWS_PAGER="" AWS_PROFILE="$PROFILE" aws ecs wait services-stable \
  --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"

echo "==> Done! Running task definition: $NEW_ARN"
