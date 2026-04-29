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
