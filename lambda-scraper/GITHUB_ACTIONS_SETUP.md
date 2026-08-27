# GitHub Actions Deployment Setup

This guide explains how to set up automated deployments for the AWS Lambda scraper using GitHub Actions.

## Overview

Two workflows are provided for automated Lambda deployment:
- **deploy-lambda.yml**: Deploys to development when code is pushed to `main` branch
- **deploy-lambda-production.yml**: Deploys to production when code is pushed to `production` branch

Both workflows can also be triggered manually via `workflow_dispatch`.

## Prerequisites

1. AWS Lambda function already deployed (use `deploy.sh` for initial deployment)
2. GitHub repository with appropriate permissions
3. AWS credentials with Lambda update permissions

## Required GitHub Secrets

### Development Environment (main branch)

Navigate to: **Settings → Secrets and variables → Actions → New repository secret**

Add the following secrets:

| Secret Name | Description | Example |
|------------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | AWS access key for dev account | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key for dev account | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `AWS_REGION` | AWS region for dev Lambda | `us-east-1` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | `1234567890abcdef1234567890abcdef` |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 database ID for dev | `1729d3f6-8035-41c4-90b3-e1d75d3ace86` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token (already exists) | `already-configured` |

### Production Environment (production branch)

Add the following additional secrets for production:

| Secret Name | Description | Example |
|------------|-------------|---------|
| `AWS_ACCESS_KEY_ID_PROD` | AWS access key for prod account | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY_PROD` | AWS secret key for prod account | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `AWS_REGION_PROD` | AWS region for prod Lambda | `us-east-1` |
| `CLOUDFLARE_ACCOUNT_ID_PROD` | Cloudflare account ID for prod | `1234567890abcdef1234567890abcdef` |
| `CLOUDFLARE_D1_DATABASE_ID_PROD` | D1 database ID for prod | `abcdef1234567890abcdef1234567890` |
| `CLOUDFLARE_API_TOKEN_PROD` | Cloudflare API token for prod | `token-for-production` |

**Note**: `CLOUDFLARE_API_TOKEN` may already exist from Cloudflare Workers deployment.

## Creating AWS IAM User for GitHub Actions

### 1. Create IAM Policy

Create a policy with minimal permissions for Lambda updates:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration"
      ],
      "Resource": "arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:crypto-news-scraper*"
    }
  ]
}
```

### 2. Create IAM User

```bash
# Create user
aws iam create-user --user-name github-actions-lambda-deploy

# Attach policy
aws iam attach-user-policy \
  --user-name github-actions-lambda-deploy \
  --policy-arn arn:aws:iam::YOUR_ACCOUNT_ID:policy/LambdaDeployPolicy

# Create access key
aws iam create-access-key --user-name github-actions-lambda-deploy
```

Save the `AccessKeyId` and `SecretAccessKey` from the output.

## Workflow Triggers

### Automatic Deployment

**Development**: Push to `main` branch with changes in `lambda-scraper/` directory
```bash
git add lambda-scraper/
git commit -m "Update Lambda scraper"
git push origin main
```

**Production**: Push to `production` branch
```bash
git checkout production
git merge main
git push origin production
```

### Manual Deployment

1. Go to **Actions** tab in GitHub
2. Select workflow: "Deploy Lambda Scraper (Development)" or "Deploy Lambda Scraper (Production)"
3. Click **Run workflow**
4. Select branch
5. Click **Run workflow** button

## Workflow Steps

Each workflow performs the following:

1. **Checkout Code**: Fetches repository code
2. **Setup Node.js**: Installs Node.js 20 with npm caching
3. **Install Dependencies**: Runs `npm ci --production` in `lambda-scraper/`
4. **Create Deployment Package**: Creates `function.zip` with code and dependencies
5. **Configure AWS Credentials**: Sets up AWS CLI with provided secrets
6. **Update Lambda Function Code**: Uploads new code to Lambda
7. **Update Lambda Configuration**: Updates environment variables
8. **Wait for Update**: Ensures deployment completes successfully
9. **Deployment Summary**: Shows success message with details

## Monitoring Deployments

### View Workflow Runs

1. Go to **Actions** tab in GitHub
2. Click on the workflow run
3. View logs for each step

### Check Lambda Function

```bash
# Check function was updated
aws lambda get-function --function-name crypto-news-scraper

# View recent logs
aws logs tail /aws/lambda/crypto-news-scraper --follow
```

## Troubleshooting

### "Function not found" Error

The Lambda function must be created before GitHub Actions can update it. Use the manual deployment script first:

```bash
cd lambda-scraper
./deploy.sh
```

### "Access Denied" Error

Verify IAM user has correct permissions:
```bash
aws lambda get-function --function-name crypto-news-scraper
```

If this fails, update the IAM policy.

### "Package too large" Error

The function.zip is over 50 MB. Ensure:
- Using `npm ci --production` (no dev dependencies)
- Chromium is in a Lambda Layer (not in deployment package)
- Only necessary files are included

### Environment Variable Issues

Check secrets are properly set in GitHub:
1. Go to **Settings → Secrets and variables → Actions**
2. Verify all required secrets exist
3. Secret values are masked in logs for security

## Function Naming Convention

- **Development**: `crypto-news-scraper`
- **Production**: `crypto-news-scraper-prod`

Update the function name in workflows if using different naming.

## Comparison: Workers vs Lambda Deployment

| Aspect | Cloudflare Workers | AWS Lambda |
|--------|-------------------|------------|
| **Tool** | Wrangler CLI | AWS CLI |
| **Package** | No packaging needed | Zip file required |
| **Secrets** | Wrangler secrets | Environment variables |
| **Speed** | ~30 seconds | ~45 seconds |
| **Configuration** | wrangler.toml | GitHub secrets |

## Best Practices

1. **Test in Development First**: Always test changes in `main` before production
2. **Use Separate AWS Accounts**: Development and production in different AWS accounts
3. **Monitor Deployments**: Check workflow logs and Lambda function logs
4. **Version Tags**: Tag production releases for easy rollback
5. **Rollback Plan**: Keep previous version's zip file for quick rollback

## Security Notes

- Never commit AWS credentials to the repository
- Use GitHub secrets for all sensitive data
- Rotate AWS access keys regularly
- Use IAM policies with minimal required permissions
- Enable MFA on AWS accounts used for production

## Next Steps

After setting up GitHub Actions:
1. Make a test change to `lambda-scraper/index.js`
2. Push to `main` branch
3. Monitor the workflow run in GitHub Actions
4. Verify function updated successfully in AWS
5. Check Lambda logs for successful execution
