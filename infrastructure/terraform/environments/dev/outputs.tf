output "ecr_repository_url" {
  value = module.dispatcher_service.ecr_repository_url
}

output "apigw_invoke_url" {
  value = module.dispatcher_service.apigw_invoke_url
}

output "webhook_url" {
  value = module.dispatcher_service.webhook_url
}

output "github_webhook_secret_arn" {
  value = module.dispatcher_service.github_webhook_secret_arn
}

output "github_app_private_key_arn" {
  value = module.dispatcher_service.github_app_private_key_arn
}
