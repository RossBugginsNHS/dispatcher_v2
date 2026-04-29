locals {
  name_prefix = "${var.project_name}-${var.environment}"

  base_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )

  webhook_secret_arn = var.github_webhook_secret_arn != null ? var.github_webhook_secret_arn : (
    var.create_managed_secrets ? aws_secretsmanager_secret.github_webhook_secret[0].arn : null
  )

  app_private_key_arn = var.github_app_private_key_arn != null ? var.github_app_private_key_arn : (
    var.create_managed_secrets ? aws_secretsmanager_secret.github_app_private_key[0].arn : null
  )

  should_create_secret_access_policy = var.create_managed_secrets || (
    var.github_webhook_secret_arn != null && var.github_app_private_key_arn != null
  )

  lambda_image_uri = var.lambda_image_uri != null ? var.lambda_image_uri : var.container_image
}
