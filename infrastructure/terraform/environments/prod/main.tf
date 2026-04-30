module "dispatcher_service" {
  source = "../../modules/dispatcher_service"

  project_name               = var.project_name
  environment                = "prod"
  container_image            = var.container_image
  github_app_id              = var.github_app_id
  create_managed_secrets     = var.create_managed_secrets
  github_webhook_secret_arn  = var.github_webhook_secret_arn
  github_app_private_key_arn = var.github_app_private_key_arn
  lambda_image_uri           = var.lambda_image_uri
  app_image_tag              = var.app_image_tag
  app_image_sha              = var.app_image_sha
  tags = {
    Service = "dispatcher"
  }
}
