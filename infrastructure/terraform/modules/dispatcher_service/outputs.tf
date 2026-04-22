output "ecr_repository_url" {
  description = "ECR repository URL for container pushes"
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.app.name
}

output "alb_dns_name" {
  description = "ALB DNS name"
  value       = aws_lb.this.dns_name
}

output "apigw_invoke_url" {
  description = "API Gateway HTTPS invoke URL (base)"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "webhook_base_url" {
  description = "Base URL for GitHub App webhook configuration"
  value       = local.has_custom_domain ? "https://${var.custom_domain_name}" : trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")
}

output "webhook_url" {
  description = "Full webhook URL to configure in GitHub App"
  value       = "${local.has_custom_domain ? "https://${var.custom_domain_name}" : trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")}/webhooks/github"
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
  value       = local.async_enabled ? aws_sqs_queue.dispatch_requests[0].id : null
}

output "dispatch_targets_queue_url" {
  description = "SQS queue URL for target dispatch work"
  value       = local.async_enabled ? aws_sqs_queue.dispatch_targets[0].id : null
}

output "dispatch_facts_event_bus_name" {
  description = "EventBridge bus name for dispatch lifecycle facts"
  value       = local.async_enabled ? aws_cloudwatch_event_bus.dispatch_facts[0].name : null
}
