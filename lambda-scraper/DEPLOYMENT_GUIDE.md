# AWS Lambda News Scraper Deployment Guide

This guide covers deploying the Bitcoin news article scraper as an AWS Lambda function with EventBridge scheduling.

## Architecture Overview

- **Function**: Node.js Lambda with Puppeteer + Chromium
- **Memory**: 1024 MB (provides sufficient CPU for browser)
- **Timeout**: 20 seconds (safety limit for Free Tier)
- **Trigger**: EventBridge (every 2 minutes)
- **Layer**: @sparticuz/chromium for headless Chrome
- **Storage**: Cloudflare D1 (via HTTP API)

## Free Tier Safety

Monthly usage staying within AWS Free Tier:
- **Invocations**: ~21,600/month (well below 1M limit)
- **Compute Time**: ~172,800 GB-seconds @ 8s avg runtime (well below 400K limit)
- **Data Transfer**: Minimal text egress (well below 100 GB limit)

## Prerequisites

1. **AWS Account** with CLI configured
2. **Cloudflare Account** with:
   - D1 database (already deployed by worker)
   - API Token with D1 read/write permissions
   - Account ID

## Step 1: Install Dependencies

```bash
cd lambda-scraper
npm install
```

## Step 2: Create Chromium Lambda Layer

The Chromium binary must be deployed as a Lambda Layer to keep the deployment package under 50 MB.

### Option A: Use Pre-built Layer (Recommended)

Use the community-maintained `@sparticuz/chromium` layer:

1. Check the latest ARN for your region at: https://github.com/Sparticuz/chromium/releases
2. For us-east-1, the ARN format is:
   ```
   arn:aws:lambda:us-east-1:764866452798:layer:chrome-aws-lambda:43
   ```
3. Note this ARN for Step 4.

### Option B: Build Custom Layer

If you need a custom build:

```bash
# Clone the chromium layer repo
git clone https://github.com/Sparticuz/chromium.git
cd chromium

# Build for your architecture
npm install
npm run build

# Package as layer
mkdir -p layer/nodejs/node_modules/@sparticuz
cp -r . layer/nodejs/node_modules/@sparticuz/chromium

# Create layer zip
cd layer
zip -r chromium-layer.zip nodejs

# Upload to AWS
aws lambda publish-layer-version \
  --layer-name chromium-for-lambda \
  --zip-file fileb://chromium-layer.zip \
  --compatible-runtimes nodejs18.x nodejs20.x
```

## Step 3: Get Cloudflare Credentials

### 3.1 Get Account ID
```bash
# From Cloudflare dashboard URL: dash.cloudflare.com/<ACCOUNT_ID>/
# Or via API:
curl -X GET "https://api.cloudflare.com/client/v4/accounts" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json"
```

### 3.2 Get D1 Database ID
```bash
# Using wrangler
cd ../worker
wrangler d1 list

# Or check worker-news-updater/wrangler.toml:
# database_id = "..."
```

### 3.3 Create API Token

1. Go to: https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use template: "Edit Cloudflare Workers"
4. Add permissions:
   - Account > D1 > Edit
5. Create and copy token

## Step 4: Create Lambda Function

### 4.1 Create Deployment Package

```bash
cd lambda-scraper

# Install production dependencies only
npm install --production

# Create deployment zip
zip -r function.zip index.js package.json node_modules/
```

### 4.2 Create IAM Role

Create a role for Lambda execution:

```bash
# Create trust policy
cat > trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role
aws iam create-role \
  --role-name crypto-scraper-lambda-role \
  --assume-role-policy-document file://trust-policy.json

# Attach basic execution policy
aws iam attach-role-policy \
  --role-name crypto-scraper-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

### 4.3 Create Lambda Function

```bash
# Create function
aws lambda create-function \
  --function-name crypto-news-scraper \
  --runtime nodejs20.x \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/crypto-scraper-lambda-role \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --timeout 20 \
  --memory-size 1024 \
  --environment Variables="{
    CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID,
    CLOUDFLARE_D1_DATABASE_ID=YOUR_DATABASE_ID,
    CLOUDFLARE_API_TOKEN=YOUR_API_TOKEN
  }"

# Attach Chromium layer
aws lambda update-function-configuration \
  --function-name crypto-news-scraper \
  --layers arn:aws:lambda:us-east-1:764866452798:layer:chrome-aws-lambda:43
```

**Important**: Replace:
- `YOUR_ACCOUNT_ID` - Your AWS account ID
- `YOUR_ACCOUNT_ID` (Cloudflare) - Your Cloudflare account ID
- `YOUR_DATABASE_ID` - Your D1 database ID
- `YOUR_API_TOKEN` - Your Cloudflare API token

## Step 5: Create EventBridge Schedule

Schedule the function to run every 2 minutes:

```bash
# Create EventBridge rule
aws events put-rule \
  --name crypto-scraper-schedule \
  --schedule-expression "rate(2 minutes)" \
  --state ENABLED \
  --description "Trigger crypto news scraper every 2 minutes"

# Add Lambda as target
aws events put-targets \
  --rule crypto-scraper-schedule \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:crypto-news-scraper"

# Grant EventBridge permission to invoke Lambda
aws lambda add-permission \
  --function-name crypto-news-scraper \
  --statement-id AllowEventBridgeInvoke \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:YOUR_ACCOUNT_ID:rule/crypto-scraper-schedule
```

## Step 6: Test the Function

### Manual Test
```bash
aws lambda invoke \
  --function-name crypto-news-scraper \
  --payload '{}' \
  response.json

cat response.json
```

### Check Logs
```bash
aws logs tail /aws/lambda/crypto-news-scraper --follow
```

## Step 7: Monitor Usage

### Check Invocation Count
```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=crypto-news-scraper \
  --start-time $(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Sum
```

### Check Duration
```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=crypto-news-scraper \
  --start-time $(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Average,Maximum
```

## Updating the Function

When you make code changes:

```bash
cd lambda-scraper

# Rebuild deployment package
zip -r function.zip index.js package.json node_modules/

# Update function code
aws lambda update-function-code \
  --function-name crypto-news-scraper \
  --zip-file fileb://function.zip
```

## Troubleshooting

### Browser Launch Failures
- Ensure Chromium layer is attached
- Check memory allocation (needs at least 512 MB, recommend 1024 MB)
- Verify Lambda timeout is sufficient (20s recommended)

### D1 API Errors
- Verify API token has D1 edit permissions
- Check account ID and database ID are correct
- Ensure token hasn't expired

### Timeout Issues
- Reduce BATCH_SIZE if processing takes too long
- Increase Lambda timeout (max 900s, but stay within Free Tier)
- Check BROWSER_TIMEOUT and PAGE_IDLE_TIMEOUT settings

### Memory Issues
- Increase memory allocation (more memory = more CPU)
- Monitor CloudWatch metrics for memory usage
- Consider reducing BATCH_SIZE for memory-intensive sites

## Cost Optimization

To maximize Free Tier usage:

1. **Monitor monthly invocations**: Should stay under 1M
2. **Watch compute time**: Track GB-seconds to stay under 400K
3. **Adjust frequency**: Reduce from every 2 minutes if needed
4. **Optimize batch size**: Balance parallelism with execution time
5. **Set up billing alerts**: Get notified if approaching limits

## Rollback to Cloudflare Worker

If needed, re-enable the processor worker:

```bash
cd ../worker
wrangler deploy --config worker-news-processor/wrangler.toml
```

The processor worker is kept in the repository for backward compatibility.
