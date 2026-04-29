output "ecr_repository_url" {
  description = "ECR repository URL for container pushes"
  value       = aws_ecr_repository.app.repository_url
}

output "apigw_invoke_url" {
  description = "API Gateway HTTPS invoke URL (base)"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "webhook_url" {
  description = "Full webhook URL to configure in GitHub App"
  value       = "${trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")}/webhooks/github"
}

output "github_webhook_secret_arn" {
  description = "Secret ARN used for GITHUB_WEBHOOK_SECRET"
  value       = local.webhook_secret_arn
}

output "github_app_private_key_arn" {
  description = "Secret ARN used for GITHUB_APP_PRIVATE_KEY"
  value       = local.app_private_key_arn
}

output "dispatch_requests_queue_url" {
  description = "SQS queue URL for accepted dispatch requests"
  value       = aws_sqs_queue.dispatch_requests.id
}

output "dispatch_targets_queue_url" {
  description = "SQS queue URL for target dispatch work"
  value       = aws_sqs_queue.dispatch_targets.id
}

output "dispatch_facts_event_bus_name" {
  description = "EventBridge bus name for dispatch lifecycle facts"
  value       = aws_cloudwatch_event_bus.dispatch_facts.name
}

output "dispatch_events_table_name" {
  description = "DynamoDB table name containing immutable dispatch event history"
  value       = aws_dynamodb_table.dispatch_events.name
}

output "dispatch_projections_table_name" {
  description = "DynamoDB table name containing dispatch projections"
  value       = aws_dynamodb_table.dispatch_projections.name
}
