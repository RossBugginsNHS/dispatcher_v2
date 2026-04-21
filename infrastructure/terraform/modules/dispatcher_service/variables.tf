variable "project_name" {
  description = "Project name used for tagging and naming"
  type        = string
}

variable "environment" {
  description = "Environment name, for example dev or prod"
  type        = string
}

variable "container_image" {
  description = "Container image URI for ECS task definition"
  type        = string
}

variable "container_port" {
  description = "Port exposed by the container"
  type        = number
  default     = 3000
}

variable "desired_count" {
  description = "Desired ECS task count"
  type        = number
  default     = 1
}

variable "cpu" {
  description = "Fargate CPU units"
  type        = number
  default     = 256
}

variable "memory" {
  description = "Fargate memory in MiB"
  type        = number
  default     = 512
}

variable "default_dispatch_ref" {
  description = "Default branch/reference for workflow dispatch"
  type        = string
  default     = "main"
}

variable "create_issues" {
  description = "Whether runtime should create issues for outcomes"
  type        = bool
  default     = true
}

variable "github_app_id" {
  description = "GitHub App ID"
  type        = string
}

variable "github_app_slug" {
  description = "GitHub App slug"
  type        = string
  default     = "org-repo-workflows-runner-alpha"
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

variable "custom_domain_name" {
  description = "Optional DNS name for the ALB"
  type        = string
  default     = null
  nullable    = true
}

variable "route53_zone_id" {
  description = "Optional hosted zone ID used with custom_domain_name"
  type        = string
  default     = null
  nullable    = true
}

variable "acm_certificate_arn" {
  description = "Optional ACM certificate ARN for HTTPS"
  type        = string
  default     = null
  nullable    = true
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}
