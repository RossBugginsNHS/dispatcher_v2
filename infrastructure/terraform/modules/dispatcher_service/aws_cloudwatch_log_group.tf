resource "aws_cloudwatch_log_group" "ingress" {
  name              = "/aws/lambda/${local.name_prefix}-ingress"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "planner" {
  name              = "/aws/lambda/${local.name_prefix}-planner"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "dispatcher" {
  name              = "/aws/lambda/${local.name_prefix}-dispatcher"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "admin" {
  name              = "/aws/lambda/${local.name_prefix}-admin"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "facts_processor" {
  name              = "/aws/lambda/${local.name_prefix}-facts-processor"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "api_gateway_access" {
  name              = "/aws/apigateway/${local.name_prefix}-access"
  retention_in_days = var.log_retention_days
  tags              = local.base_tags
}
