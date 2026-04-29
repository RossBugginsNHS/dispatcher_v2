resource "aws_cloudwatch_event_bus" "dispatch_facts" {
  name = "${local.name_prefix}-dispatch-facts"
  tags = local.base_tags
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
