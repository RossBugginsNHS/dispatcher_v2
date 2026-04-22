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

  has_custom_domain = var.custom_domain_name != null
  has_route53_alias = var.custom_domain_name != null && var.route53_zone_id != null
  has_https         = var.acm_certificate_arn != null

  webhook_secret_arn = var.github_webhook_secret_arn != null ? var.github_webhook_secret_arn : (
    var.create_managed_secrets ? aws_secretsmanager_secret.github_webhook_secret[0].arn : null
  )

  app_private_key_arn = var.github_app_private_key_arn != null ? var.github_app_private_key_arn : (
    var.create_managed_secrets ? aws_secretsmanager_secret.github_app_private_key[0].arn : null
  )

  # This must be known at plan time; do not depend on resource-computed ARNs here.
  should_create_secret_access_policy = var.create_managed_secrets || (
    var.github_webhook_secret_arn != null && var.github_app_private_key_arn != null
  )

  fargate_enabled          = var.enable_fargate
  async_enabled            = var.enable_async_pipeline
  has_lambda_image         = var.lambda_image_uri != null
  should_create_lambda_iam = local.async_enabled

  # Extract image tag (after the colon) to use as APP_VERSION
  lambda_image_tag = var.lambda_image_uri != null ? (
    length(split(":", var.lambda_image_uri)) > 1
    ? split(":", var.lambda_image_uri)[1]
    : "unknown"
  ) : "unknown"
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

resource "aws_vpc" "this" {
  count = local.fargate_enabled ? 1 : 0

  cidr_block           = "10.60.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_subnet" "public_a" {
  count = local.fargate_enabled ? 1 : 0

  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = "10.60.1.0/24"
  availability_zone       = "${data.aws_region.current.name}a"
  map_public_ip_on_launch = true

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-public-a" })
}

resource "aws_subnet" "public_b" {
  count = local.fargate_enabled ? 1 : 0

  vpc_id                  = aws_vpc.this[0].id
  cidr_block              = "10.60.2.0/24"
  availability_zone       = "${data.aws_region.current.name}b"
  map_public_ip_on_launch = true

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-public-b" })
}

resource "aws_internet_gateway" "this" {
  count = local.fargate_enabled ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-igw" })
}

resource "aws_route_table" "public" {
  count = local.fargate_enabled ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this[0].id
  }

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-public-rt" })
}

resource "aws_route_table_association" "public_a" {
  count = local.fargate_enabled ? 1 : 0

  subnet_id      = aws_subnet.public_a[0].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table_association" "public_b" {
  count = local.fargate_enabled ? 1 : 0

  subnet_id      = aws_subnet.public_b[0].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_ecr_repository" "app" {
  name                 = "${local.name_prefix}-dispatcher"
  image_tag_mutability = "MUTABLE"

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
        description  = "Keep last 20 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  count = local.fargate_enabled ? 1 : 0

  name              = "/ecs/${local.name_prefix}-dispatcher"
  retention_in_days = 30

  tags = local.base_tags
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

data "aws_iam_policy_document" "task_assume" {
  count = local.fargate_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  count = local.fargate_enabled ? 1 : 0

  name               = "${local.name_prefix}-task-exec"
  assume_role_policy = data.aws_iam_policy_document.task_assume[0].json
  tags               = local.base_tags
}

resource "aws_iam_role_policy_attachment" "task_exec_managed" {
  count = local.fargate_enabled ? 1 : 0

  role       = aws_iam_role.task_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  count = local.fargate_enabled ? 1 : 0

  name               = "${local.name_prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume[0].json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "secrets_read" {
  count = local.fargate_enabled && local.should_create_secret_access_policy ? 1 : 0

  statement {
    sid = "AllowReadRuntimeSecrets"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = compact([
      local.webhook_secret_arn,
      local.app_private_key_arn,
    ])
  }
}

resource "aws_iam_policy" "secrets_read" {
  count = local.fargate_enabled && local.should_create_secret_access_policy ? 1 : 0

  name   = "${local.name_prefix}-secrets-read"
  policy = data.aws_iam_policy_document.secrets_read[0].json
  tags   = local.base_tags
}

resource "aws_iam_role_policy_attachment" "task_secrets_read" {
  count = local.fargate_enabled && local.should_create_secret_access_policy ? 1 : 0

  role       = aws_iam_role.task[0].name
  policy_arn = aws_iam_policy.secrets_read[0].arn
}

resource "aws_iam_role_policy_attachment" "task_execution_secrets_read" {
  count = local.fargate_enabled && local.should_create_secret_access_policy ? 1 : 0

  role       = aws_iam_role.task_execution[0].name
  policy_arn = aws_iam_policy.secrets_read[0].arn
}

resource "aws_ecs_cluster" "this" {
  count = local.fargate_enabled ? 1 : 0

  name = "${local.name_prefix}-cluster"
  tags = local.base_tags
}

resource "aws_security_group" "alb" {
  count = local.fargate_enabled ? 1 : 0

  name        = "${local.name_prefix}-alb"
  description = "Allow inbound web traffic"
  vpc_id      = aws_vpc.this[0].id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = local.has_https ? [1] : []

    content {
      description = "HTTPS"
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.base_tags
}

resource "aws_security_group" "ecs" {
  count = local.fargate_enabled ? 1 : 0

  name        = "${local.name_prefix}-ecs"
  description = "Allow ALB to reach ECS tasks"
  vpc_id      = aws_vpc.this[0].id

  ingress {
    description     = "From ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb[0].id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.base_tags
}

resource "aws_lb" "this" {
  count = local.fargate_enabled ? 1 : 0

  name               = substr(replace("${local.name_prefix}-alb", "_", "-"), 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = [aws_subnet.public_a[0].id, aws_subnet.public_b[0].id]

  tags = local.base_tags
}

resource "aws_lb_target_group" "app" {
  count = local.fargate_enabled ? 1 : 0

  name        = substr(replace("${local.name_prefix}-tg", "_", "-"), 0, 32)
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this[0].id

  health_check {
    enabled             = true
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200-299"
  }

  tags = local.base_tags
}

resource "aws_lb_listener" "http_forward" {
  count = local.fargate_enabled && !local.has_https ? 1 : 0

  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count = local.fargate_enabled && local.has_https ? 1 : 0

  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count = local.fargate_enabled && local.has_https ? 1 : 0

  load_balancer_arn = aws_lb.this[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }

  lifecycle {
    precondition {
      condition     = var.custom_domain_name != null
      error_message = "HTTPS requires custom_domain_name. You cannot use a valid TLS certificate for the raw ALB DNS hostname."
    }
  }
}

resource "aws_route53_record" "app" {
  count = local.fargate_enabled && local.has_route53_alias ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.custom_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this[0].dns_name
    zone_id                = aws_lb.this[0].zone_id
    evaluate_target_health = true
  }
}

resource "aws_ecs_task_definition" "app" {
  count = local.fargate_enabled ? 1 : 0

  family                   = "${local.name_prefix}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.task_execution[0].arn
  task_role_arn            = aws_iam_role.task[0].arn

  container_definitions = jsonencode([
    {
      name      = "dispatcher"
      image     = var.container_image
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app[0].name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "ecs"
        }
      }
      environment = [
        { name = "PORT", value = tostring(var.container_port) },
        { name = "NODE_ENV", value = "production" },
        { name = "LOG_LEVEL", value = var.log_level },
        { name = "GITHUB_APP_ID", value = var.github_app_id },
        { name = "GITHUB_APP_SLUG", value = var.github_app_slug },
        { name = "DEFAULT_DISPATCH_REF", value = var.default_dispatch_ref },
        { name = "CREATE_ISSUES", value = tostring(var.create_issues) },
      ]
      secrets = [
        { name = "GITHUB_WEBHOOK_SECRET", valueFrom = local.webhook_secret_arn },
        { name = "GITHUB_APP_PRIVATE_KEY", valueFrom = local.app_private_key_arn },
      ]
    }
  ])

  lifecycle {
    precondition {
      condition = var.create_managed_secrets || (
        var.github_webhook_secret_arn != null && var.github_app_private_key_arn != null
      )
      error_message = "Set create_managed_secrets=true or provide both github_webhook_secret_arn and github_app_private_key_arn."
    }

    precondition {
      condition     = var.container_image != null
      error_message = "When enable_fargate=true, set container_image."
    }
  }

  tags = local.base_tags
}

resource "aws_ecs_service" "app" {
  count = local.fargate_enabled ? 1 : 0

  name            = "${local.name_prefix}-service"
  cluster         = aws_ecs_cluster.this[0].id
  task_definition = aws_ecs_task_definition.app[0].arn
  launch_type     = "FARGATE"
  desired_count   = var.desired_count

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.ecs[0].id]
    subnets          = [aws_subnet.public_a[0].id, aws_subnet.public_b[0].id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app[0].arn
    container_name   = "dispatcher"
    container_port   = var.container_port
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  depends_on = [aws_lb_listener.http_forward, aws_lb_listener.http_redirect, aws_lb_listener.https]

  tags = local.base_tags
}

# ---------------------------------------------------------------------------
# API Gateway HTTP API — HTTPS front door for GitHub webhooks
# Proxies all requests through to the ALB over HTTP.
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "webhook" {
  name          = "${local.name_prefix}-apigw"
  protocol_type = "HTTP"
  description   = "HTTPS front door for GitHub webhook service"

  tags = local.base_tags
}

resource "aws_apigatewayv2_integration" "alb_proxy" {
  count = local.fargate_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = "http://${aws_lb.this[0].dns_name}/{proxy}"
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "proxy" {
  count = local.fargate_enabled ? 1 : 0

  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.alb_proxy[0].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.webhook.id
  name        = "$default"
  auto_deploy = true

  tags = local.base_tags
}

# ---------------------------------------------------------------------------
# Async pipeline (optional): API Gateway -> Lambda ingress -> SQS -> Lambda
# planner -> SQS -> Lambda dispatcher, with EventBridge facts.
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "dispatch_requests_dlq" {
  count = local.async_enabled ? 1 : 0

  name = "${local.name_prefix}-dispatch-requests-dlq"
  tags = local.base_tags
}

resource "aws_sqs_queue" "dispatch_requests" {
  count = local.async_enabled ? 1 : 0

  name = "${local.name_prefix}-dispatch-requests"
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dispatch_requests_dlq[0].arn
    maxReceiveCount     = 5
  })

  tags = local.base_tags
}

resource "aws_sqs_queue" "dispatch_targets_dlq" {
  count = local.async_enabled ? 1 : 0

  name = "${local.name_prefix}-dispatch-targets-dlq"
  tags = local.base_tags
}

resource "aws_sqs_queue" "dispatch_targets" {
  count = local.async_enabled ? 1 : 0

  name = "${local.name_prefix}-dispatch-targets"
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dispatch_targets_dlq[0].arn
    maxReceiveCount     = 5
  })

  tags = local.base_tags
}

resource "aws_cloudwatch_event_bus" "dispatch_facts" {
  count = local.async_enabled ? 1 : 0

  name = "${local.name_prefix}-dispatch-facts"

  tags = local.base_tags
}

resource "aws_dynamodb_table" "dispatch_events" {
  count = local.async_enabled ? 1 : 0

  name         = "${local.name_prefix}-dispatch-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

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
  count = local.async_enabled ? 1 : 0

  name         = "${local.name_prefix}-dispatch-projections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

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

data "aws_iam_policy_document" "lambda_assume" {
  count = local.should_create_lambda_iam ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  count = local.should_create_lambda_iam ? 1 : 0

  name               = "${local.name_prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume[0].json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "lambda_runtime" {
  count = local.should_create_lambda_iam ? 1 : 0

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:*:*:*"]
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
      aws_sqs_queue.dispatch_requests[0].arn,
      aws_sqs_queue.dispatch_targets[0].arn,
    ]
  }

  statement {
    sid = "PublishFacts"
    actions = [
      "events:PutEvents",
    ]
    resources = [aws_cloudwatch_event_bus.dispatch_facts[0].arn]
  }

  statement {
    sid = "DynamoEventStore"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:Scan",
    ]
    resources = [
      aws_dynamodb_table.dispatch_events[0].arn,
      "${aws_dynamodb_table.dispatch_events[0].arn}/index/*",
      aws_dynamodb_table.dispatch_projections[0].arn,
    ]
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
    sid = "XRayTracing"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "lambda_runtime" {
  count = local.should_create_lambda_iam ? 1 : 0

  name   = "${local.name_prefix}-lambda-runtime"
  policy = data.aws_iam_policy_document.lambda_runtime[0].json
  tags   = local.base_tags
}

resource "aws_iam_role_policy_attachment" "lambda_runtime" {
  count = local.should_create_lambda_iam ? 1 : 0

  role       = aws_iam_role.lambda[0].name
  policy_arn = aws_iam_policy.lambda_runtime[0].arn
}

resource "aws_lambda_function" "ingress" {
  count = local.async_enabled ? 1 : 0

  function_name = "${local.name_prefix}-ingress"
  role          = aws_iam_role.lambda[0].arn
  package_type  = "Image"
  image_uri     = var.lambda_image_uri
  image_config {
    command = ["dist/lambda/ingress-handler.handler"]
  }
  timeout     = var.lambda_timeout_seconds
  memory_size = var.lambda_memory_mb

  environment {
    variables = {
      LOG_LEVEL                     = var.log_level
      GITHUB_WEBHOOK_SECRET_ARN     = local.webhook_secret_arn
      DISPATCH_REQUESTS_QUEUE_URL   = aws_sqs_queue.dispatch_requests[0].id
      DISPATCH_FACTS_EVENT_BUS_NAME = aws_cloudwatch_event_bus.dispatch_facts[0].name
      APP_VERSION                   = local.lambda_image_tag
    }
  }

  tracing_config {
    mode = "Active"
  }

  lifecycle {
    precondition {
      condition     = local.has_lambda_image
      error_message = "When enable_async_pipeline=true, set lambda_image_uri."
    }
  }

  tags = local.base_tags
}

resource "aws_lambda_function" "planner" {
  count = local.async_enabled ? 1 : 0

  function_name = "${local.name_prefix}-planner"
  role          = aws_iam_role.lambda[0].arn
  package_type  = "Image"
  image_uri     = var.lambda_image_uri
  image_config {
    command = ["dist/lambda/planner-handler.handler"]
  }
  timeout     = var.lambda_timeout_seconds
  memory_size = var.lambda_memory_mb

  environment {
    variables = {
      LOG_LEVEL                     = var.log_level
      GITHUB_APP_ID                 = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_ARN    = local.app_private_key_arn
      DISPATCH_TARGETS_QUEUE_URL    = aws_sqs_queue.dispatch_targets[0].id
      DISPATCH_FACTS_EVENT_BUS_NAME = aws_cloudwatch_event_bus.dispatch_facts[0].name
      DEFAULT_DISPATCH_REF          = var.default_dispatch_ref
      DISPATCH_MAX_RETRIES          = "2"
      DISPATCH_RETRY_BASE_DELAY_MS  = "200"
      APP_VERSION                   = local.lambda_image_tag
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = local.base_tags
}

resource "aws_lambda_function" "dispatcher" {
  count = local.async_enabled ? 1 : 0

  function_name = "${local.name_prefix}-dispatcher"
  role          = aws_iam_role.lambda[0].arn
  package_type  = "Image"
  image_uri     = var.lambda_image_uri
  image_config {
    command = ["dist/lambda/dispatcher-handler.handler"]
  }
  timeout     = var.lambda_timeout_seconds
  memory_size = var.lambda_memory_mb

  environment {
    variables = {
      LOG_LEVEL                     = var.log_level
      GITHUB_APP_ID                 = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_ARN    = local.app_private_key_arn
      DISPATCH_FACTS_EVENT_BUS_NAME = aws_cloudwatch_event_bus.dispatch_facts[0].name
      DISPATCH_MAX_RETRIES          = "2"
      DISPATCH_RETRY_BASE_DELAY_MS  = "200"
      APP_VERSION                   = local.lambda_image_tag
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = local.base_tags
}

resource "aws_lambda_function" "projection" {
  count = local.async_enabled ? 1 : 0

  function_name = "${local.name_prefix}-projection"
  role          = aws_iam_role.lambda[0].arn
  package_type  = "Image"
  image_uri     = var.lambda_image_uri
  image_config {
    command = ["dist/lambda/projection-handler.handler"]
  }
  timeout     = var.lambda_timeout_seconds
  memory_size = var.lambda_memory_mb

  environment {
    variables = {
      LOG_LEVEL                       = var.log_level
      DISPATCH_EVENTS_TABLE_NAME      = aws_dynamodb_table.dispatch_events[0].name
      DISPATCH_PROJECTIONS_TABLE_NAME = aws_dynamodb_table.dispatch_projections[0].name
      APP_VERSION                     = local.lambda_image_tag
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = local.base_tags
}

resource "aws_lambda_function" "admin_installations" {
  count = local.async_enabled ? 1 : 0

  function_name = "${local.name_prefix}-admin-installations"
  role          = aws_iam_role.lambda[0].arn
  package_type  = "Image"
  image_uri     = var.lambda_image_uri
  image_config {
    command = ["dist/lambda/admin-installations-handler.handler"]
  }
  timeout     = var.lambda_timeout_seconds
  memory_size = var.lambda_memory_mb

  environment {
    variables = {
      LOG_LEVEL                  = var.log_level
      GITHUB_APP_ID              = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_ARN = local.app_private_key_arn
      APP_VERSION                = local.lambda_image_tag
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = local.base_tags
}

resource "aws_lambda_function" "admin_observability" {
  count = local.async_enabled ? 1 : 0

  function_name = "${local.name_prefix}-admin-observability"
  role          = aws_iam_role.lambda[0].arn
  package_type  = "Image"
  image_uri     = var.lambda_image_uri
  image_config {
    command = ["dist/lambda/admin-observability-handler.handler"]
  }
  timeout     = var.lambda_timeout_seconds
  memory_size = var.lambda_memory_mb

  environment {
    variables = {
      LOG_LEVEL                       = var.log_level
      DISPATCH_PROJECTIONS_TABLE_NAME = aws_dynamodb_table.dispatch_projections[0].name
      DISPATCH_EVENTS_TABLE_NAME      = aws_dynamodb_table.dispatch_events[0].name
      APP_VERSION                     = local.lambda_image_tag
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = local.base_tags
}

resource "aws_lambda_event_source_mapping" "planner" {
  count = local.async_enabled ? 1 : 0

  event_source_arn = aws_sqs_queue.dispatch_requests[0].arn
  function_name    = aws_lambda_function.planner[0].arn
  batch_size       = 10
}

resource "aws_lambda_event_source_mapping" "dispatcher" {
  count = local.async_enabled ? 1 : 0

  event_source_arn = aws_sqs_queue.dispatch_targets[0].arn
  function_name    = aws_lambda_function.dispatcher[0].arn
  batch_size       = 10
}

resource "aws_lambda_permission" "apigw_invoke_ingress" {
  count = local.async_enabled ? 1 : 0

  statement_id  = "AllowApiGatewayInvokeIngress"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingress[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/*/webhooks/github"
}

resource "aws_apigatewayv2_integration" "lambda_ingress" {
  count = local.async_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ingress[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "webhook_ingress" {
  count = local.async_enabled ? 1 : 0

  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "POST /webhooks/github"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_ingress[0].id}"
}

resource "aws_cloudwatch_event_rule" "facts_to_projection" {
  count = local.async_enabled ? 1 : 0

  name           = "${local.name_prefix}-facts-to-projection"
  event_bus_name = aws_cloudwatch_event_bus.dispatch_facts[0].name
  event_pattern  = jsonencode({ source = [{ prefix = "io.dispatcher." }] })
}

resource "aws_cloudwatch_event_target" "facts_to_projection" {
  count = local.async_enabled ? 1 : 0

  event_bus_name = aws_cloudwatch_event_bus.dispatch_facts[0].name
  rule           = aws_cloudwatch_event_rule.facts_to_projection[0].name
  target_id      = "projection"
  arn            = aws_lambda_function.projection[0].arn
}

resource "aws_lambda_permission" "eventbridge_invoke_projection" {
  count = local.async_enabled ? 1 : 0

  statement_id  = "AllowEventBridgeInvokeProjection"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.projection[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.facts_to_projection[0].arn
}

resource "aws_lambda_permission" "apigw_invoke_admin_installations" {
  count = local.async_enabled ? 1 : 0

  statement_id  = "AllowApiGatewayInvokeAdminInstallations"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin_installations[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/GET/admin/installations"
}

resource "aws_apigatewayv2_integration" "lambda_admin_installations" {
  count = local.async_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin_installations[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "admin_installations" {
  count = local.async_enabled ? 1 : 0

  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "GET /admin/installations"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_admin_installations[0].id}"
}

resource "aws_lambda_permission" "apigw_invoke_admin_observability_root" {
  count = local.async_enabled ? 1 : 0

  statement_id  = "AllowApiGatewayInvokeAdminObservabilityRoot"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin_observability[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/GET/admin"
}

resource "aws_lambda_permission" "apigw_invoke_admin_observability_projections" {
  count = local.async_enabled ? 1 : 0

  statement_id  = "AllowApiGatewayInvokeAdminObservabilityProjections"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin_observability[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/GET/admin/projections"
}

resource "aws_apigatewayv2_integration" "lambda_admin_observability" {
  count = local.async_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin_observability[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "admin_observability_root" {
  count = local.async_enabled ? 1 : 0

  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "GET /admin"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_admin_observability[0].id}"
}

resource "aws_apigatewayv2_route" "admin_projections" {
  count = local.async_enabled ? 1 : 0

  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "GET /admin/projections"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_admin_observability[0].id}"
}

resource "aws_lambda_permission" "apigw_invoke_admin_observability_api" {
  count = local.async_enabled ? 1 : 0

  statement_id  = "AllowApiGatewayInvokeAdminObservabilityApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin_observability[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/GET/admin/api/*"
}

resource "aws_apigatewayv2_route" "admin_api" {
  count = local.async_enabled ? 1 : 0

  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "GET /admin/api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_admin_observability[0].id}"
}

# ---------------------------------------------------------------------------
# CloudWatch log groups for Lambda functions (explicit, with retention)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda_ingress" {
  count             = local.async_enabled ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-ingress"
  retention_in_days = 30
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "lambda_planner" {
  count             = local.async_enabled ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-planner"
  retention_in_days = 30
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "lambda_dispatcher" {
  count             = local.async_enabled ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-dispatcher"
  retention_in_days = 30
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "lambda_projection" {
  count             = local.async_enabled ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-projection"
  retention_in_days = 30
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "lambda_admin_installations" {
  count             = local.async_enabled ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-admin-installations"
  retention_in_days = 30
  tags              = local.base_tags
}

resource "aws_cloudwatch_log_group" "lambda_admin_observability" {
  count             = local.async_enabled ? 1 : 0
  name              = "/aws/lambda/${local.name_prefix}-admin-observability"
  retention_in_days = 30
  tags              = local.base_tags
}

# ---------------------------------------------------------------------------
# CloudWatch dashboard — Lambda + SQS + DynamoDB infrastructure view
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "dispatcher" {
  count          = local.async_enabled ? 1 : 0
  dashboard_name = "${local.name_prefix}-dispatcher"

  dashboard_body = jsonencode({
    widgets = [
      {
        type       = "metric"
        x          = 0
        y          = 0
        width      = 12
        height     = 6
        properties = {
          title   = "Lambda Invocations & Errors"
          region  = data.aws_region.current.name
          view    = "timeSeries"
          stat    = "Sum"
          period  = 60
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", "${local.name_prefix}-ingress", { "label" = "ingress" }],
            ["AWS/Lambda", "Errors", "FunctionName", "${local.name_prefix}-ingress", { "label" = "ingress errors", "color" = "#d13212" }],
            ["AWS/Lambda", "Invocations", "FunctionName", "${local.name_prefix}-planner", { "label" = "planner" }],
            ["AWS/Lambda", "Errors", "FunctionName", "${local.name_prefix}-planner", { "label" = "planner errors", "color" = "#ff7f0e" }],
            ["AWS/Lambda", "Invocations", "FunctionName", "${local.name_prefix}-dispatcher", { "label" = "dispatcher" }],
            ["AWS/Lambda", "Errors", "FunctionName", "${local.name_prefix}-dispatcher", { "label" = "dispatcher errors", "color" = "#9467bd" }],
            ["AWS/Lambda", "Invocations", "FunctionName", "${local.name_prefix}-projection", { "label" = "projection" }],
            ["AWS/Lambda", "Errors", "FunctionName", "${local.name_prefix}-projection", { "label" = "projection errors", "color" = "#8c564b" }],
          ]
        }
      },
      {
        type       = "metric"
        x          = 12
        y          = 0
        width      = 12
        height     = 6
        properties = {
          title   = "Lambda Duration p50 / p99 (ms)"
          region  = data.aws_region.current.name
          view    = "timeSeries"
          period  = 60
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", "${local.name_prefix}-ingress", { "stat" = "p50", "label" = "ingress p50" }],
            ["AWS/Lambda", "Duration", "FunctionName", "${local.name_prefix}-ingress", { "stat" = "p99", "label" = "ingress p99" }],
            ["AWS/Lambda", "Duration", "FunctionName", "${local.name_prefix}-planner", { "stat" = "p50", "label" = "planner p50" }],
            ["AWS/Lambda", "Duration", "FunctionName", "${local.name_prefix}-planner", { "stat" = "p99", "label" = "planner p99" }],
            ["AWS/Lambda", "Duration", "FunctionName", "${local.name_prefix}-dispatcher", { "stat" = "p50", "label" = "dispatcher p50" }],
            ["AWS/Lambda", "Duration", "FunctionName", "${local.name_prefix}-dispatcher", { "stat" = "p99", "label" = "dispatcher p99" }],
          ]
        }
      },
      {
        type       = "metric"
        x          = 0
        y          = 6
        width      = 12
        height     = 6
        properties = {
          title   = "SQS Queue Depths"
          region  = data.aws_region.current.name
          view    = "timeSeries"
          stat    = "Maximum"
          period  = 60
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "${local.name_prefix}-dispatch-requests", { "label" = "requests queue" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "${local.name_prefix}-dispatch-requests-dlq", { "label" = "requests DLQ", "color" = "#d13212" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "${local.name_prefix}-dispatch-targets", { "label" = "targets queue" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "${local.name_prefix}-dispatch-targets-dlq", { "label" = "targets DLQ", "color" = "#ff7f0e" }],
          ]
        }
      },
      {
        type       = "metric"
        x          = 12
        y          = 6
        width      = 12
        height     = 6
        properties = {
          title   = "DynamoDB Latency & Errors"
          region  = data.aws_region.current.name
          view    = "timeSeries"
          period  = 60
          metrics = [
            ["AWS/DynamoDB", "SuccessfulRequestLatency", "TableName", "${local.name_prefix}-dispatch-events", "Operation", "PutItem", { "stat" = "p99", "label" = "events PutItem p99ms" }],
            ["AWS/DynamoDB", "SuccessfulRequestLatency", "TableName", "${local.name_prefix}-dispatch-projections", "Operation", "UpdateItem", { "stat" = "p99", "label" = "projections UpdateItem p99ms" }],
            ["AWS/DynamoDB", "SystemErrors", "TableName", "${local.name_prefix}-dispatch-events", { "stat" = "Sum", "label" = "events errors", "color" = "#d13212" }],
            ["AWS/DynamoDB", "SystemErrors", "TableName", "${local.name_prefix}-dispatch-projections", { "stat" = "Sum", "label" = "projections errors", "color" = "#ff7f0e" }],
          ]
        }
      },
      {
        type       = "metric"
        x          = 0
        y          = 12
        width      = 12
        height     = 6
        properties = {
          title   = "Lambda Throttles"
          region  = data.aws_region.current.name
          view    = "timeSeries"
          stat    = "Sum"
          period  = 60
          metrics = [
            ["AWS/Lambda", "Throttles", "FunctionName", "${local.name_prefix}-ingress", { "label" = "ingress" }],
            ["AWS/Lambda", "Throttles", "FunctionName", "${local.name_prefix}-planner", { "label" = "planner" }],
            ["AWS/Lambda", "Throttles", "FunctionName", "${local.name_prefix}-dispatcher", { "label" = "dispatcher" }],
            ["AWS/Lambda", "Throttles", "FunctionName", "${local.name_prefix}-projection", { "label" = "projection" }],
          ]
        }
      },
      {
        type       = "metric"
        x          = 12
        y          = 12
        width      = 12
        height     = 6
        properties = {
          title   = "API Gateway Requests & Errors"
          region  = data.aws_region.current.name
          view    = "timeSeries"
          stat    = "Sum"
          period  = 60
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", "${aws_apigatewayv2_api.webhook.id}", { "label" = "total requests" }],
            ["AWS/ApiGateway", "4XXError", "ApiId", "${aws_apigatewayv2_api.webhook.id}", { "label" = "4xx errors", "color" = "#ff7f0e" }],
            ["AWS/ApiGateway", "5XXError", "ApiId", "${aws_apigatewayv2_api.webhook.id}", { "label" = "5xx errors", "color" = "#d13212" }],
          ]
        }
      },
    ]
  })
}
