variable "aws_region" {
  type        = string
  description = "AWS region for deployment"
  default     = "eu-west-2"
}

variable "project_name" {
  type        = string
  description = "Project name"
  default     = "dispatcher-v2"
}

variable "container_image" {
  type        = string
  description = "Container image URI to deploy"
}

variable "github_app_id" {
  type        = string
  description = "GitHub App ID"
}

variable "github_app_slug" {
  type        = string
  description = "GitHub App slug"
  default     = "org-repo-workflows-runner-alpha"
}

variable "desired_count" {
  type        = number
  description = "ECS desired task count"
  default     = 2
}

variable "cpu" {
  type        = number
  description = "Fargate CPU units"
  default     = 512
}

variable "memory" {
  type        = number
  description = "Fargate memory"
  default     = 1024
}

variable "create_managed_secrets" {
  type        = bool
  description = "Create placeholder secrets if existing ARNs are not provided"
  default     = true
}

variable "github_webhook_secret_arn" {
  type        = string
  description = "Existing webhook secret ARN"
  default     = null
  nullable    = true
}

variable "github_app_private_key_arn" {
  type        = string
  description = "Existing private key secret ARN"
  default     = null
  nullable    = true
}

variable "custom_domain_name" {
  type        = string
  description = "Optional custom domain name"
  default     = null
  nullable    = true
}

variable "route53_zone_id" {
  type        = string
  description = "Optional hosted zone ID"
  default     = null
  nullable    = true
}

variable "acm_certificate_arn" {
  type        = string
  description = "Optional ACM certificate ARN"
  default     = null
  nullable    = true
}

variable "enable_async_pipeline" {
  type        = bool
  description = "Enable async Lambda + SQS + EventBridge dispatcher pipeline"
  default     = false
}

variable "lambda_package_s3_bucket" {
  type        = string
  description = "S3 bucket for Lambda deployment package zip"
  default     = null
  nullable    = true
}

variable "lambda_package_s3_key" {
  type        = string
  description = "S3 key for Lambda deployment package zip"
  default     = null
  nullable    = true
}
