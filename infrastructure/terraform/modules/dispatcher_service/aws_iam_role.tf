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
