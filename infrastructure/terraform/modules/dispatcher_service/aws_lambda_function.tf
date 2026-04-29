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
      LOG_LEVEL                       = var.log_level
      APP_VERSION                     = var.environment
      DISPATCH_EVENTS_TABLE_NAME      = aws_dynamodb_table.dispatch_events.name
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
