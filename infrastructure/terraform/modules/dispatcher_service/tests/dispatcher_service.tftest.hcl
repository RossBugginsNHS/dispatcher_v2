# Tests for dispatcher_service module using mock AWS provider.
# Run with: terraform test
# These tests verify resource naming, output completeness, and
# variable combination behaviour without requiring real AWS credentials.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      name = "eu-west-2"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

# ---------------------------------------------------------------------------
# Test 1: default configuration with managed secrets
# ---------------------------------------------------------------------------
run "default_config_with_managed_secrets" {
  command = plan

  variables {
    project_name    = "myproject"
    environment     = "test"
    container_image = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/myproject-test-dispatcher:latest"
    github_app_id   = "12345"
  }

  # ECR repository follows naming convention
  assert {
    condition     = aws_ecr_repository.app.name == "myproject-test-dispatcher"
    error_message = "ECR repository name should be '{project_name}-{environment}-dispatcher'"
  }

  # ECR image scanning enabled
  assert {
    condition     = aws_ecr_repository.app.image_scanning_configuration[0].scan_on_push == true
    error_message = "ECR image scanning on push should be enabled"
  }

  # ECR image tags immutable
  assert {
    condition     = aws_ecr_repository.app.image_tag_mutability == "IMMUTABLE"
    error_message = "ECR image tags should be immutable"
  }

  # Managed secrets created when create_managed_secrets = true (default)
  assert {
    condition     = length(aws_secretsmanager_secret.github_webhook_secret) == 1
    error_message = "Webhook secret should be created when create_managed_secrets is true"
  }

  assert {
    condition     = length(aws_secretsmanager_secret.github_app_private_key) == 1
    error_message = "App private key secret should be created when create_managed_secrets is true"
  }

  # SQS queue names follow naming convention
  assert {
    condition     = aws_sqs_queue.dispatch_requests.name == "myproject-test-dispatch-requests"
    error_message = "dispatch_requests SQS queue name should be '{project_name}-{environment}-dispatch-requests'"
  }

  assert {
    condition     = aws_sqs_queue.dispatch_requests_dlq.name == "myproject-test-dispatch-requests-dlq"
    error_message = "dispatch_requests_dlq SQS queue name should be '{project_name}-{environment}-dispatch-requests-dlq'"
  }

  assert {
    condition     = aws_sqs_queue.dispatch_targets.name == "myproject-test-dispatch-targets"
    error_message = "dispatch_targets SQS queue name should be '{project_name}-{environment}-dispatch-targets'"
  }

  assert {
    condition     = aws_sqs_queue.dispatch_targets_dlq.name == "myproject-test-dispatch-targets-dlq"
    error_message = "dispatch_targets_dlq SQS queue name should be '{project_name}-{environment}-dispatch-targets-dlq'"
  }

  # DynamoDB tables follow naming convention
  assert {
    condition     = aws_dynamodb_table.dispatch_events.name == "myproject-test-dispatch-events"
    error_message = "dispatch_events DynamoDB table name should be '{project_name}-{environment}-dispatch-events'"
  }

  assert {
    condition     = aws_dynamodb_table.dispatch_projections.name == "myproject-test-dispatch-projections"
    error_message = "dispatch_projections DynamoDB table name should be '{project_name}-{environment}-dispatch-projections'"
  }

  # DynamoDB deletion protection enabled
  assert {
    condition     = aws_dynamodb_table.dispatch_events.deletion_protection_enabled == true
    error_message = "dispatch_events DynamoDB deletion protection should be enabled"
  }

  assert {
    condition     = aws_dynamodb_table.dispatch_projections.deletion_protection_enabled == true
    error_message = "dispatch_projections DynamoDB deletion protection should be enabled"
  }

  # EventBridge bus follows naming convention
  assert {
    condition     = aws_cloudwatch_event_bus.dispatch_facts.name == "myproject-test-dispatch-facts"
    error_message = "EventBridge bus name should be '{project_name}-{environment}-dispatch-facts'"
  }

  # Lambda functions follow naming convention
  assert {
    condition     = aws_lambda_function.ingress.function_name == "myproject-test-ingress"
    error_message = "Ingress Lambda name should be '{project_name}-{environment}-ingress'"
  }

  assert {
    condition     = aws_lambda_function.planner.function_name == "myproject-test-planner"
    error_message = "Planner Lambda name should be '{project_name}-{environment}-planner'"
  }

  assert {
    condition     = aws_lambda_function.dispatcher.function_name == "myproject-test-dispatcher"
    error_message = "Dispatcher Lambda name should be '{project_name}-{environment}-dispatcher'"
  }

  assert {
    condition     = aws_lambda_function.admin.function_name == "myproject-test-admin"
    error_message = "Admin Lambda name should be '{project_name}-{environment}-admin'"
  }

  assert {
    condition     = aws_lambda_function.facts_processor.function_name == "myproject-test-facts-processor"
    error_message = "Facts processor Lambda name should be '{project_name}-{environment}-facts-processor'"
  }

  # Lambda functions use Image package type
  assert {
    condition     = aws_lambda_function.ingress.package_type == "Image"
    error_message = "Ingress Lambda should use Image package type"
  }

  # API Gateway follows naming convention
  assert {
    condition     = aws_apigatewayv2_api.webhook.name == "myproject-test-apigw"
    error_message = "API Gateway name should be '{project_name}-{environment}-apigw'"
  }

  # IAM role follows naming convention
  assert {
    condition     = aws_iam_role.lambda.name == "myproject-test-lambda"
    error_message = "Lambda IAM role name should be '{project_name}-{environment}-lambda'"
  }

  # CloudWatch log retention uses the default (90 days)
  assert {
    condition     = aws_cloudwatch_log_group.ingress.retention_in_days == 90
    error_message = "Default log retention should be 90 days"
  }
}

# ---------------------------------------------------------------------------
# Test 2: create_managed_secrets = false with externally provided ARNs
# ---------------------------------------------------------------------------
run "external_secret_arns" {
  command = plan

  variables {
    project_name               = "myproject"
    environment                = "test"
    container_image            = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/myproject-test-dispatcher:latest"
    github_app_id              = "12345"
    create_managed_secrets     = false
    github_webhook_secret_arn  = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:my-webhook-secret"
    github_app_private_key_arn = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:my-private-key"
  }

  # No managed secrets should be created
  assert {
    condition     = length(aws_secretsmanager_secret.github_webhook_secret) == 0
    error_message = "Webhook secret should NOT be created when create_managed_secrets is false"
  }

  assert {
    condition     = length(aws_secretsmanager_secret.github_app_private_key) == 0
    error_message = "App private key secret should NOT be created when create_managed_secrets is false"
  }
}

# ---------------------------------------------------------------------------
# Test 3: custom log retention and memory overrides
# ---------------------------------------------------------------------------
run "custom_runtime_overrides" {
  command = plan

  variables {
    project_name           = "myproject"
    environment            = "test"
    container_image        = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/myproject-test-dispatcher:latest"
    github_app_id          = "12345"
    log_retention_days     = 30
    lambda_memory_mb       = 1024
    lambda_timeout_seconds = 60
  }

  assert {
    condition     = aws_cloudwatch_log_group.ingress.retention_in_days == 30
    error_message = "Log retention should reflect the custom log_retention_days variable"
  }

  assert {
    condition     = aws_lambda_function.ingress.memory_size == 1024
    error_message = "Lambda memory should reflect the custom lambda_memory_mb variable"
  }

  assert {
    condition     = aws_lambda_function.ingress.timeout == 60
    error_message = "Lambda timeout should reflect the custom lambda_timeout_seconds variable"
  }
}

# ---------------------------------------------------------------------------
# Test 4: lambda_image_uri override takes precedence over container_image
# ---------------------------------------------------------------------------
run "lambda_image_uri_override" {
  command = plan

  variables {
    project_name     = "myproject"
    environment      = "test"
    container_image  = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/myproject-test-dispatcher:latest"
    github_app_id    = "12345"
    lambda_image_uri = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/myproject-test-dispatcher:pinned"
  }

  assert {
    condition     = aws_lambda_function.ingress.image_uri == "123456789012.dkr.ecr.eu-west-2.amazonaws.com/myproject-test-dispatcher:pinned"
    error_message = "Lambda should use lambda_image_uri when provided"
  }
}
