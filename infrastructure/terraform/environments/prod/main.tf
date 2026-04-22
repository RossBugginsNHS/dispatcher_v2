module "dispatcher_service" {
  source = "../../modules/dispatcher_service"

  project_name               = var.project_name
  environment                = "prod"
  container_image            = var.container_image
  github_app_id              = var.github_app_id
  github_app_slug            = var.github_app_slug
  desired_count              = var.desired_count
  cpu                        = var.cpu
  memory                     = var.memory
  create_managed_secrets     = var.create_managed_secrets
  github_webhook_secret_arn  = var.github_webhook_secret_arn
  github_app_private_key_arn = var.github_app_private_key_arn
  enable_async_pipeline      = var.enable_async_pipeline
  lambda_package_s3_bucket   = var.lambda_package_s3_bucket
  lambda_package_s3_key      = var.lambda_package_s3_key
  custom_domain_name         = var.custom_domain_name
  route53_zone_id            = var.route53_zone_id
  acm_certificate_arn        = var.acm_certificate_arn
  tags = {
    Service = "dispatcher"
  }
}
