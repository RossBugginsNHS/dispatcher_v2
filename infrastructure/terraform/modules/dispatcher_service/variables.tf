variable "project_name" {
  description = "Project name used for tagging and naming"
  type        = string
}

variable "environment" {
  description = "Environment name, for example dev or prod"
  type        = string
}

variable "container_image" {
  description = "Primary container image URI for the Lambda deployment"
  type        = string
}

variable "default_dispatch_ref" {
  description = "Default branch/reference for workflow dispatch"
  type        = string
  default     = "main"
}

variable "github_app_id" {
  description = "GitHub App ID"
  type        = string
}

variable "log_level" {
  description = "Application log level"
  type        = string
  default     = "info"
}

variable "create_managed_secrets" {
  description = "Create placeholder AWS Secrets Manager secrets for webhook secret and private key"
  type        = bool
  default     = true
}

variable "github_webhook_secret_arn" {
  description = "Existing secret ARN for GITHUB_WEBHOOK_SECRET"
  type        = string
  default     = null
  nullable    = true
}

variable "github_app_private_key_arn" {
  description = "Existing secret ARN for GITHUB_APP_PRIVATE_KEY"
  type        = string
  default     = null
  nullable    = true
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}

variable "lambda_image_uri" {
  description = "Optional override container image URI for Lambda handlers"
  type        = string
  default     = null
  nullable    = true
}

variable "lambda_timeout_seconds" {
  description = "Lambda timeout in seconds"
  type        = number
  default     = 30
}

variable "lambda_memory_mb" {
  description = "Lambda memory size in MB"
  type        = number
  default     = 512
}

variable "lambda_ingress_handler" {
  description = "Handler for ingress Lambda"
  type        = string
  default     = "dist/lambda/ingress-handler.handler"
}

variable "lambda_planner_handler" {
  description = "Handler for planner Lambda"
  type        = string
  default     = "dist/lambda/planner-handler.handler"
}

variable "lambda_dispatcher_handler" {
  description = "Handler for dispatcher Lambda"
  type        = string
  default     = "dist/lambda/dispatcher-handler.handler"
}

variable "app_image_tag" {
  description = "Container image tag currently deployed (e.g. v1.0.0 or sha-abc1234)"
  type        = string
  default     = null
  nullable    = true
}

variable "app_image_sha" {
  description = "Container image digest (sha256:...) currently deployed"
  type        = string
  default     = null
  nullable    = true
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention in days for Lambda and API Gateway log groups"
  type        = number
  default     = 90
}
