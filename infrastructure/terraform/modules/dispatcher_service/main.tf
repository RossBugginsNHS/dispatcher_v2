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

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

resource "aws_ecr_repository" "app" {
  name                 = "${local.name_prefix}-dispatcher"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.base_tags
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 30 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = {
          type = "expire"
        }
      },
    ]
  })
}

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

resource "aws_dynamodb_table" "dispatch_events" {
  name         = "${local.name_prefix}-dispatch-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  deletion_protection_enabled = true

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  tags = local.base_tags
}

resource "aws_dynamodb_table" "dispatch_projections" {
  name         = "${local.name_prefix}-dispatch-projections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  deletion_protection_enabled = true

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  tags = local.base_tags
}

resource "aws_sqs_queue" "dispatch_requests_dlq" {
  name                    = "${local.name_prefix}-dispatch-requests-dlq"
  sqs_managed_sse_enabled = true
  tags                    = local.base_tags
}

resource "aws_sqs_queue" "dispatch_requests" {
  name                    = "${local.name_prefix}-dispatch-requests"
  sqs_managed_sse_enabled = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dispatch_requests_dlq.arn
    maxReceiveCount     = 5
  })

  tags = local.base_tags
}

resource "aws_sqs_queue" "dispatch_targets_dlq" {
  name                    = "${local.name_prefix}-dispatch-targets-dlq"
  sqs_managed_sse_enabled = true
  tags                    = local.base_tags
}

resource "aws_sqs_queue" "dispatch_targets" {
  name                    = "${local.name_prefix}-dispatch-targets"
  sqs_managed_sse_enabled = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dispatch_targets_dlq.arn
    maxReceiveCount     = 5
  })

  tags = local.base_tags
}

resource "aws_cloudwatch_event_bus" "dispatch_facts" {
  name = "${local.name_prefix}-dispatch-facts"
  tags = local.base_tags
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name_prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "lambda_runtime" {
  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.name_prefix}-*",
      "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.name_prefix}-*:*",
    ]
  }

  statement {
    sid = "QueueWork"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [
      aws_sqs_queue.dispatch_requests.arn,
      aws_sqs_queue.dispatch_targets.arn,
    ]
  }

  statement {
    sid = "PublishFacts"
    actions = [
      "events:PutEvents",
    ]
    resources = [aws_cloudwatch_event_bus.dispatch_facts.arn]
  }

  statement {
    sid = "ReadRuntimeSecrets"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = compact([
      local.webhook_secret_arn,
      local.app_private_key_arn,
    ])
  }

  statement {
    sid = "ProjectionTablesReadWrite"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchWriteItem",
    ]
    resources = [
      aws_dynamodb_table.dispatch_events.arn,
      "${aws_dynamodb_table.dispatch_events.arn}/index/*",
      aws_dynamodb_table.dispatch_projections.arn,
      "${aws_dynamodb_table.dispatch_projections.arn}/index/*",
    ]
  }
}

resource "aws_iam_policy" "lambda_runtime" {
  name   = "${local.name_prefix}-lambda-runtime"
  policy = data.aws_iam_policy_document.lambda_runtime.json
  tags   = local.base_tags
}

resource "aws_iam_role_policy_attachment" "lambda_runtime" {
  role       = aws_iam_role.lambda.name
  policy_arn = aws_iam_policy.lambda_runtime.arn
}

# --- CloudWatch Log Groups with bounded retention ---

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

resource "aws_lambda_function" "ingress" {
  function_name = "${local.name_prefix}-ingress"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = local.lambda_image_uri
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb

  image_config {
    command = [var.lambda_ingress_handler]
  }

  environment {
    variables = {
      LOG_LEVEL                     = var.log_level
      GITHUB_WEBHOOK_SECRET_ARN     = local.webhook_secret_arn
      DISPATCH_REQUESTS_QUEUE_URL   = aws_sqs_queue.dispatch_requests.id
      DISPATCH_FACTS_EVENT_BUS_NAME = aws_cloudwatch_event_bus.dispatch_facts.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.ingress]
  tags       = local.base_tags
}

resource "aws_lambda_function" "planner" {
  function_name = "${local.name_prefix}-planner"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = local.lambda_image_uri
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb

  image_config {
    command = [var.lambda_planner_handler]
  }

  environment {
    variables = {
      LOG_LEVEL                     = var.log_level
      GITHUB_APP_ID                 = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_ARN    = local.app_private_key_arn
      DISPATCH_TARGETS_QUEUE_URL    = aws_sqs_queue.dispatch_targets.id
      DISPATCH_FACTS_EVENT_BUS_NAME = aws_cloudwatch_event_bus.dispatch_facts.name
      DEFAULT_DISPATCH_REF          = var.default_dispatch_ref
      DISPATCH_MAX_RETRIES          = "2"
      DISPATCH_RETRY_BASE_DELAY_MS  = "200"
    }
  }

  depends_on = [aws_cloudwatch_log_group.planner]
  tags       = local.base_tags
}

resource "aws_lambda_function" "dispatcher" {
  function_name = "${local.name_prefix}-dispatcher"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = local.lambda_image_uri
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb

  image_config {
    command = [var.lambda_dispatcher_handler]
  }

  environment {
    variables = {
      LOG_LEVEL                     = var.log_level
      GITHUB_APP_ID                 = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_ARN    = local.app_private_key_arn
      DISPATCH_FACTS_EVENT_BUS_NAME = aws_cloudwatch_event_bus.dispatch_facts.name
      DISPATCH_MAX_RETRIES          = "2"
      DISPATCH_RETRY_BASE_DELAY_MS  = "200"
    }
  }

  depends_on = [aws_cloudwatch_log_group.dispatcher]
  tags       = local.base_tags
}

resource "aws_lambda_function" "admin" {
  function_name = "${local.name_prefix}-admin"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = local.lambda_image_uri
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb

  image_config {
    command = ["dist/lambda/admin-observability-handler.handler"]
  }

  environment {
    variables = {
      LOG_LEVEL                      = var.log_level
      APP_VERSION                    = var.environment
      DISPATCH_EVENTS_TABLE_NAME     = aws_dynamodb_table.dispatch_events.name
      DISPATCH_PROJECTIONS_TABLE_NAME = aws_dynamodb_table.dispatch_projections.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.admin]
  tags       = local.base_tags
}

resource "aws_lambda_function" "facts_processor" {
  function_name = "${local.name_prefix}-facts-processor"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = local.lambda_image_uri
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb

  image_config {
    command = ["dist/lambda/facts-processor-handler.handler"]
  }

  environment {
    variables = {
      LOG_LEVEL                       = var.log_level
      APP_VERSION                     = var.environment
      DISPATCH_EVENTS_TABLE_NAME      = aws_dynamodb_table.dispatch_events.name
      DISPATCH_PROJECTIONS_TABLE_NAME = aws_dynamodb_table.dispatch_projections.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.facts_processor]
  tags       = local.base_tags
}

resource "aws_lambda_event_source_mapping" "planner" {
  event_source_arn = aws_sqs_queue.dispatch_requests.arn
  function_name    = aws_lambda_function.planner.arn
  batch_size       = 10
}

resource "aws_lambda_event_source_mapping" "dispatcher" {
  event_source_arn = aws_sqs_queue.dispatch_targets.arn
  function_name    = aws_lambda_function.dispatcher.arn
  batch_size       = 10
}

resource "aws_cloudwatch_event_rule" "facts_all" {
  name           = "${local.name_prefix}-facts-all"
  event_bus_name = aws_cloudwatch_event_bus.dispatch_facts.name

  event_pattern = jsonencode({
    source = ["dispatcher.v2"]
  })

  tags = local.base_tags
}

resource "aws_cloudwatch_event_target" "facts_processor" {
  rule           = aws_cloudwatch_event_rule.facts_all.name
  event_bus_name = aws_cloudwatch_event_bus.dispatch_facts.name
  arn            = aws_lambda_function.facts_processor.arn
}

resource "aws_lambda_permission" "eventbridge_invoke_facts_processor" {
  statement_id  = "AllowEventBridgeInvokeFactsProcessor"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.facts_processor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.facts_all.arn
}

resource "aws_apigatewayv2_api" "webhook" {
  name          = "${local.name_prefix}-apigw"
  protocol_type = "HTTP"
  description   = "HTTPS front door for webhook and admin endpoints"

  tags = local.base_tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.webhook.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  tags = local.base_tags
}

resource "aws_apigatewayv2_integration" "lambda_ingress" {
  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ingress.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "lambda_admin" {
  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_lambda_permission" "apigw_invoke_ingress" {
  statement_id  = "AllowApiGatewayInvokeIngress"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingress.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_invoke_admin" {
  statement_id  = "AllowApiGatewayInvokeAdmin"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/*"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_ingress.id}"
}

resource "aws_apigatewayv2_route" "webhook_ingress" {
  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "POST /webhooks/github"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_ingress.id}"
}

resource "aws_apigatewayv2_route" "admin_root" {
  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "GET /admin"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_admin.id}"
}

resource "aws_apigatewayv2_route" "admin_proxy" {
  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "GET /admin/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_admin.id}"
}
