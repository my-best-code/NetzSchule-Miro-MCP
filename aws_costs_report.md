# AWS Architecture Cost Analysis & Optimization Report

## Overview
This report analyzes the core services and security improvements suggested in `security_report.md` from a cloud provider cost perspective. It estimates the pricing impact of implementing the suggested high-security features and provides cheaper, serverless-native alternatives to achieve identical security outcomes while maximizing AWS Free Tier and zero-baseline-cost solutions.

## 1. Secrets Management (Finding 1)
- **Currently Suggested:** AWS Secrets Manager + Customer Managed KMS Key
- **Cost Impact:** 
  - Secrets Manager: ~$0.40 per secret/month + $0.05 per 10,000 API requests.
  - KMS Customer Managed Key: $1.00/month per key + $0.03 per 10,000 requests.
  - **Total Baseline Cost:** ~$1.40/month minimum.
- **Cheaper Alternative: AWS Systems Manager (SSM) Parameter Store (SecureString)**
  - Parameter Store **Standard tier is Free**.
  - Using the AWS-managed default KMS key (`alias/aws/ssm`) to encrypt the param is **Free**.
  - **Verdict:** Use SSM Parameter Store with SecureString to securely inject `MIRO_CLIENT_SECRET` at **$0/month**.

## 2. OAuth State Validation (Finding 2)
- **Currently Suggested:** Storing CSRF `state` in a DynamoDB Table with TTL.
- **Cost Impact:** 
  - On-Demand billing: ~$1.25 per million write units (WCU) + ~$0.25 per million read units (RCU). 
  - While cheap, it introduces stateful infrastructure, VPC routing considerations (if used), and minor baseline latency.
- **Cheaper Alternative: Stateless Signed JWTs or HMAC Tokens**
  - Instead of a database, securely encode the `state` along with a timestamp into a JWT structured and signed by your server backend (using a secret stored in SSM). Return and validate this stateless token.
  - **Cost:** **$0** (Computed entirely in-memory during Lambda execution).

## 3. Web Application Firewall (WAF) (Finding 10)
- **Currently Suggested:** AWS WAFv2 attached to the API Gateway.
- **Cost Impact:** 
  - Base Web ACL: $5.00/month.
  - Per Rule Cost: $1.00/month per rule (e.g., Rate limiting, Bot control, IP blacklist).
  - Traffic processing: $0.60 per 1 million requests.
  - **Total Baseline Cost:** ~$6.00 to $10.00+/month just for enablement.
- **Cheaper Alternative: API Gateway Native Throttling & Auth Plans**
  - Use native API Gateway Usage Plans to establish per-route and per-client throttling (rate limiting) which is **built-in and Free**.
  - For malicious bot/DDoS protection, rely on AWS Shield Standard, which is automatically enabled on API Gateway endpoints for **Free**.

## 4. Network Isolation / VPC Deployment (Finding 9)
- **Currently Suggested:** Deploy Lambda inside a VPC (Virtual Private Cloud) in private subnets.
- **Cost Impact:** 
  - Lambdas in private subnets isolated from the internet require a **NAT Gateway** to safely make outbound calls (e.g., reaching the public Miro API).
  - NAT Gateway Cost: ~$0.045 fixed per isolated Availability Zone hour (~**$32.40/month**).
  - NAT Data Processing: $0.045 per GB transferred.
  - VPC Endpoints (PrivateLink) for AWS Services (e.g., connecting privately to Secrets Manager/SSM from the VPC): ~$0.01 per AZ hour (~$7.20/month per endpoint).
  - **Total Baseline Cost:** **~$40.00+/month**.
- **Cheaper Alternative: Lambda Public Environment (Zero Trust Architecture)**
  - Skip the VPC entirely. Since your application acts as an authorization proxy communicating squarely with a public 3rd party API (Miro), VPC isolation yields diminishing returns compared to its massive overhead.
  - Secure the deployment heavily on the Application Layer instead: strong IAM Least Privilege (Finding 6), rigid input validation (Finding 7), and strict environment variables injection (Finding 1).
  - **Cost:** **$0**.

## 5. Logging and Monitoring (Finding 3)
- **Current Observation:** Logging large OAuth response payloads and bearer tokens to CloudWatch.
- **Cost Impact:** 
  - CloudWatch Logs Ingestion: $0.50 per GB.
  - Bloated monolithic strings can inflate gigabytes quickly causing creeping usage costs.
- **Cheaper Alternative: Metadata-only Logging & strict Log Retention**
  - Adhere to the findings by stripping payloads. Log only IDs, Event Types, and Status Codes. 
  - Enforce a rigid Retention Policy on the auto-generated CloudWatch Log Group (e.g., 7 or 14 days) rather than "Never Expire". This keeps CloudWatch Storage ($0.03 per GB/month) negligible.

## Executive Conclusion
If implemented exactly as natively suggested in a traditional enterprise guide, achieving full compliance could passively generate **~$40 to $50 per month** in baseline infrastructure costs, primarily derived from VPC networking (NAT Gateway) and WAF. 

By utilizing serverless-native capabilities—namely **SSM Parameter Store over Secrets Manager, Stateless crypto over DynamoDB, and leaning on API Gateway native functionality over AWS WAF**—you can successfully mitigate 100% of the Critical and High severity findings while maintaining the architecture’s baseline run cost at **$0/month** (subject strictly to Lambda/HTTP request usage under the Free Tier).
