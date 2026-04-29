resource "aws_secretsmanager_secret" "github_webhook_secret" {
  count = var.create_managed_secrets && var.github_webhook_secret_arn == null ? 1 : 0

  name = "${local.name_prefix}/github-webhook-secret"
  tags = local.base_tags
}

resource "aws_secretsmanager_secret" "github_app_private_key" {
  count = var.create_managed_secrets && var.github_app_private_key_arn == null ? 1 : 0

  name = "${local.name_prefix}/github-app-private-key"
  tags = local.base_tags
}
