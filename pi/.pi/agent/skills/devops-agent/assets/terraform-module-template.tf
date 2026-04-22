# Terraform basic module template
# Conventions: semantic versioning, remote state, variable validation, outputs

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---- Variables ----

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
}

variable "app_name" {
  description = "Application name used for resource naming"
  type        = string
}

variable "instance_count" {
  description = "Number of instances to create"
  type        = number
  default     = 1

  validation {
    condition     = var.instance_count >= 1 && var.instance_count <= 10
    error_message = "Instance count must be between 1 and 10."
  }
}

variable "common_tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}

# ---- Local Values ----

locals {
  name_prefix = "${var.app_name}-${var.environment}"
  default_tags = {
    ManagedBy     = "terraform"
    Environment   = var.environment
    Application   = var.app_name
    CostCenter    = "engineering"
  }
  tags = merge(local.default_tags, var.common_tags)
}

# ---- Data Sources ----

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# ---- Resources ----

resource "aws_security_group" "this" {
  name_prefix = "${local.name_prefix}-sg-"
  description = "Security group for ${var.app_name} in ${var.environment}"

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_instance" "this" {
  count = var.instance_count

  ami           = data.aws_ami.amazon_linux_2.id
  instance_type = var.environment == "prod" ? "m6i.large" : "t3.micro"

  vpc_security_group_ids = [aws_security_group.this.id]

  monitoring = var.environment == "prod"

  root_block_device {
    encrypted   = true
    volume_type = "gp3"
  }

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-instance-${count.index + 1}"
  })

  lifecycle {
    ignore_changes = [ami]
  }
}

# ---- Outputs ----

output "instance_ids" {
  description = "List of created instance IDs"
  value       = aws_instance.this[*].id
}

output "security_group_id" {
  description = "ID of the created security group"
  value       = aws_security_group.this.id
}

output "region" {
  description = "AWS region"
  value       = data.aws_region.current.name
}
