# Example Terraform configuration for deploying the Miro MCP REST API.
# This shows how to set up the IAM role and S3 bucket needed for SAM deployment
# via GitHub Actions. Adapt to your own AWS account and infrastructure.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# --- Variables ---

variable "aws_region" {
  type    = string
  default = "eu-central-1"
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID"
}

variable "github_repo" {
  type        = string
  default     = "my-best-code/NetzSchule-Miro-MCP"
  description = "GitHub repo in org/repo format"
}

variable "sam_artifacts_bucket" {
  type        = string
  default     = "netz-miro-mcp-sam-artifacts"
  description = "S3 bucket for SAM deployment artifacts"
}

# --- OIDC Provider (skip if you already have one) ---

# One per AWS account. If you already have a GitHub OIDC provider, reference it
# with a data source instead:
#   data "aws_iam_openid_connect_provider" "github" {
#     url = "https://token.actions.githubusercontent.com"
#   }

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# --- IAM Role for GitHub Actions ---

resource "aws_iam_role" "github_actions_miro_mcp" {
  name = "GitHubActions-MiroMCP-Deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringLike = {
            "token.actions.githubusercontent.com:sub" : "repo:${var.github_repo}:*"
          }
          StringEquals = {
            "token.actions.githubusercontent.com:aud" : "sts.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_iam_policy" "sam_deploy" {
  name = "MiroMCP-SAM-Deploy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CloudFormation"
        Effect   = "Allow"
        Action   = ["cloudformation:*"]
        Resource = "arn:aws:cloudformation:${var.aws_region}:${var.aws_account_id}:stack/miro-mcp-*/*"
      },
      {
        Sid    = "CloudFormationValidate"
        Effect = "Allow"
        Action = [
          "cloudformation:ValidateTemplate",
          "cloudformation:GetTemplateSummary"
        ]
        Resource = "*"
      },
      {
        Sid    = "S3"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"]
        Resource = [
          "arn:aws:s3:::${var.sam_artifacts_bucket}",
          "arn:aws:s3:::${var.sam_artifacts_bucket}/*"
        ]
      },
      {
        Sid    = "Lambda"
        Effect = "Allow"
        Action = [
          "lambda:CreateFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration",
          "lambda:DeleteFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration",
          "lambda:ListTags", "lambda:TagResource", "lambda:UntagResource",
          "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency",
          "lambda:AddPermission", "lambda:RemovePermission",
          "lambda:PublishVersion", "lambda:ListVersionsByFunction"
        ]
        Resource = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:miro-mcp-*"
      },
      {
        Sid    = "LambdaAliases"
        Effect = "Allow"
        Action = [
          "lambda:CreateAlias", "lambda:UpdateAlias", "lambda:DeleteAlias",
          "lambda:GetAlias", "lambda:ListAliases"
        ]
        Resource = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:miro-mcp-*:*"
      },
      {
        Sid      = "APIGateway"
        Effect   = "Allow"
        Action   = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"]
        Resource = "arn:aws:apigateway:${var.aws_region}::*"
      },
      {
        Sid    = "IAM"
        Effect = "Allow"
        Action = [
          "iam:CreateRole", "iam:GetRole", "iam:DeleteRole", "iam:PassRole",
          "iam:AttachRolePolicy", "iam:DetachRolePolicy",
          "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
          "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
          "iam:TagRole", "iam:UntagRole"
        ]
        Resource = "arn:aws:iam::${var.aws_account_id}:role/miro-mcp-*"
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:DescribeLogGroups", "logs:PutRetentionPolicy"]
        Resource = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/miro-mcp-*"
      },
      {
        Sid    = "CloudWatchAlarms"
        Effect = "Allow"
        Action = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms"]
        Resource = "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:miro-mcp-*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "sam_deploy" {
  role       = aws_iam_role.github_actions_miro_mcp.name
  policy_arn = aws_iam_policy.sam_deploy.arn
}

# --- S3 bucket for SAM artifacts ---

resource "aws_s3_bucket" "sam_artifacts" {
  bucket = var.sam_artifacts_bucket
}

resource "aws_s3_bucket_lifecycle_configuration" "sam_artifacts" {
  bucket = aws_s3_bucket.sam_artifacts.id
  rule {
    id     = "cleanup-old-artifacts"
    status = "Enabled"
    expiration {
      days = 30
    }
  }
}

# --- Outputs ---

output "role_arn" {
  value       = aws_iam_role.github_actions_miro_mcp.arn
  description = "Add this as AWS_ROLE_ARN secret in GitHub repo settings"
}

output "sam_bucket" {
  value       = aws_s3_bucket.sam_artifacts.bucket
  description = "Add this as SAM_BUCKET secret in GitHub repo settings"
}
