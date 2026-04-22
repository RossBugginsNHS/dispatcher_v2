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

  async_enabled            = var.enable_async_pipeline
  has_lambda_package       = var.lambda_package_s3_bucket != null && var.lambda_package_s3_key != null
  should_create_lambda_iam = local.async_enabled
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = "10.60.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "10.60.1.0/24"
  availability_zone       = "${data.aws_region.current.name}a"
  map_public_ip_on_launch = true

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-public-a" })
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "10.60.2.0/24"
  availability_zone       = "${data.aws_region.current.name}b"
  map_public_ip_on_launch = true

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-public-b" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-igw" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-public-rt" })
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
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
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name_prefix}-task-exec"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = local.base_tags
}

resource "aws_iam_role_policy_attachment" "task_exec_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${local.name_prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = local.base_tags
}

data "aws_iam_policy_document" "secrets_read" {
  count = local.should_create_secret_access_policy ? 1 : 0

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
  count = local.should_create_secret_access_policy ? 1 : 0

  name   = "${local.name_prefix}-secrets-read"
  policy = data.aws_iam_policy_document.secrets_read[0].json
  tags   = local.base_tags
}

resource "aws_iam_role_policy_attachment" "task_secrets_read" {
  count = local.should_create_secret_access_policy ? 1 : 0

  role       = aws_iam_role.task.name
  policy_arn = aws_iam_policy.secrets_read[0].arn
}

resource "aws_iam_role_policy_attachment" "task_execution_secrets_read" {
  count = local.should_create_secret_access_policy ? 1 : 0

  role       = aws_iam_role.task_execution.name
  policy_arn = aws_iam_policy.secrets_read[0].arn
}

resource "aws_ecs_cluster" "this" {
  name = "${local.name_prefix}-cluster"
  tags = local.base_tags
}

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Allow inbound web traffic"
  vpc_id      = aws_vpc.this.id

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
  name        = "${local.name_prefix}-ecs"
  description = "Allow ALB to reach ECS tasks"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "From ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
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
  name               = substr(replace("${local.name_prefix}-alb", "_", "-"), 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]

  tags = local.base_tags
}

resource "aws_lb_target_group" "app" {
  name        = substr(replace("${local.name_prefix}-tg", "_", "-"), 0, 32)
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

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
  count = local.has_https ? 0 : 1

  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count = local.has_https ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
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
  count = local.has_https ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  lifecycle {
    precondition {
      condition     = var.custom_domain_name != null
      error_message = "HTTPS requires custom_domain_name. You cannot use a valid TLS certificate for the raw ALB DNS hostname."
    }
  }
}

resource "aws_route53_record" "app" {
  count = local.has_route53_alias ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.custom_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name_prefix}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

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
          awslogs-group         = aws_cloudwatch_log_group.app.name
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
  }

  tags = local.base_tags
}

resource "aws_ecs_service" "app" {
  name            = "${local.name_prefix}-service"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app.arn
  launch_type     = "FARGATE"
  desired_count   = var.desired_count

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.ecs.id]
    subnets          = [aws_subnet.public_a.id, aws_subnet.public_b.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
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
  api_id                 = aws_apigatewayv2_api.webhook.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = "http://${aws_lb.this.dns_name}/{proxy}"
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.webhook.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.alb_proxy.id}"
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
  runtime       = var.lambda_runtime
  handler       = var.lambda_ingress_handler
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb
  s3_bucket     = var.lambda_package_s3_bucket
  s3_key        = var.lambda_package_s3_key

  environment {
    variables = {
      LOG_LEVEL                     = var.log_level
      GITHUB_WEBHOOK_SECRET_ARN     = local.webhook_secret_arn
      DISPATCH_REQUESTS_QUEUE_URL   = aws_sqs_queue.dispatch_requests[0].id
      DISPATCH_FACTS_EVENT_BUS_NAME = aws_cloudwatch_event_bus.dispatch_facts[0].name
    }
  }

  lifecycle {
    precondition {
      condition     = local.has_lambda_package
      error_message = "When enable_async_pipeline=true, set lambda_package_s3_bucket and lambda_package_s3_key."
    }
  }

  tags = local.base_tags
}

resource "aws_lambda_function" "planner" {
  count = local.async_enabled ? 1 : 0

  function_name = "${local.name_prefix}-planner"
  role          = aws_iam_role.lambda[0].arn
  runtime       = var.lambda_runtime
  handler       = var.lambda_planner_handler
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb
  s3_bucket     = var.lambda_package_s3_bucket
  s3_key        = var.lambda_package_s3_key

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
    }
  }

  tags = local.base_tags
}

resource "aws_lambda_function" "dispatcher" {
  count = local.async_enabled ? 1 : 0

  function_name = "${local.name_prefix}-dispatcher"
  role          = aws_iam_role.lambda[0].arn
  runtime       = var.lambda_runtime
  handler       = var.lambda_dispatcher_handler
  timeout       = var.lambda_timeout_seconds
  memory_size   = var.lambda_memory_mb
  s3_bucket     = var.lambda_package_s3_bucket
  s3_key        = var.lambda_package_s3_key

  environment {
    variables = {
      LOG_LEVEL                     = var.log_level
      GITHUB_APP_ID                 = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_ARN    = local.app_private_key_arn
      DISPATCH_FACTS_EVENT_BUS_NAME = aws_cloudwatch_event_bus.dispatch_facts[0].name
      DISPATCH_MAX_RETRIES          = "2"
      DISPATCH_RETRY_BASE_DELAY_MS  = "200"
    }
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
