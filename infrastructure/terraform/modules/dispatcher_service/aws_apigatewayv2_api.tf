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
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
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
