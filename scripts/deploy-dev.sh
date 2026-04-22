#!/usr/bin/env bash
set -euo pipefail

ACCOUNT=767397886959
REGION=eu-west-2
ECR_REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/dispatcher-v2-dev-dispatcher"
CLUSTER=dispatcher-v2-dev-cluster
SERVICE=dispatcher-v2-dev-service
TASK_FAMILY=dispatcher-v2-dev-task
PROFILE=nhs-notify-admin

NEW_TAG=$(date -u +%Y%m%d%H%M%S)
echo "==> Tag: $NEW_TAG"

echo "==> ECR login"
AWS_PAGER="" AWS_PROFILE=$PROFILE aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

echo "==> Docker build"
docker build -t "$ECR_REPO:$NEW_TAG" "$(dirname "$0")/.."

echo "==> Docker push"
docker push "$ECR_REPO:$NEW_TAG"

echo "==> Preparing task definition"
AWS_PAGER="" AWS_PROFILE=$PROFILE aws ecs describe-task-definition \
  --task-definition $TASK_FAMILY --region $REGION \
  --query 'taskDefinition' > /tmp/taskdef.json

python3 - <<PYEOF
import json
td = json.load(open('/tmp/taskdef.json'))
td['containerDefinitions'][0]['image'] = '$ECR_REPO:$NEW_TAG'
for k in ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy']:
    td.pop(k, None)
json.dump(td, open('/tmp/new_taskdef.json', 'w'))
print('Image set:', td['containerDefinitions'][0]['image'])
PYEOF

echo "==> Registering new task definition"
NEW_ARN=$(AWS_PAGER="" AWS_PROFILE=$PROFILE aws ecs register-task-definition \
  --cli-input-json file:///tmp/new_taskdef.json --region $REGION \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "    $NEW_ARN"

echo "==> Updating ECS service"
AWS_PAGER="" AWS_PROFILE=$PROFILE aws ecs update-service \
  --cluster $CLUSTER --service $SERVICE \
  --task-definition $TASK_FAMILY --region $REGION \
  --query 'service.deployments[*].{status:status,taskDef:taskDefinition}' \
  --output table

echo "==> Waiting for stable rollout..."
AWS_PAGER="" AWS_PROFILE=$PROFILE aws ecs wait services-stable \
  --cluster $CLUSTER --services $SERVICE --region $REGION

echo "==> Done! Running task definition: $NEW_ARN"
