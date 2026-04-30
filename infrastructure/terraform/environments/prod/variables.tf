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

variable "lambda_image_uri" {
  type        = string
  description = "Optional override image URI for Lambda handlers. Defaults to container_image when null."
  default     = null
  nullable    = true
}

variable "app_image_tag" {
  type        = string
  description = "Container image tag currently deployed (e.g. v1.0.0 or sha-abc1234)"
  default     = null
  nullable    = true
}

variable "app_image_sha" {
  type        = string
  description = "Container image digest (sha256:...) currently deployed"
  default     = null
  nullable    = true
}
