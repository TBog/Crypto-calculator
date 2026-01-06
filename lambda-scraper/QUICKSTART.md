# Quick Start: AWS Lambda Scraper

Get the Bitcoin news scraper running on AWS Lambda in 5 minutes.

## Prerequisites

- AWS account with CLI configured (`aws configure`)
- Cloudflare account with D1 database (already set up from worker deployment)
- Node.js installed

## Step 1: Get Cloudflare Credentials

You need three values:

### 1. Account ID
From Cloudflare dashboard URL: `https://dash.cloudflare.com/<ACCOUNT_ID>/`

### 2. Database ID
From `worker/worker-news-updater/wrangler.toml`:
```toml
[[d1_databases]]
database_id = "1729d3f6-8035-41c4-90b3-e1d75d3ace86"  # ← This value
```

### 3. API Token
Create at: https://dash.cloudflare.com/profile/api-tokens
- Template: "Edit Cloudflare Workers"
- Add permission: Account > D1 > Edit
- Copy the token

## Step 2: Deploy with Script

```bash
cd lambda-scraper
./deploy.sh
```

Follow prompts and paste your credentials when asked.

## Step 3: Verify It's Working

```bash
# Watch the logs
aws logs tail /aws/lambda/crypto-news-scraper --follow
```

You should see:
- ✅ "Browser launched successfully"
- ✅ "Extracted X characters"
- ✅ "Updated article ... in D1"

## Step 4: Check Results

```bash
cd ../worker

# Check extracted content in D1
wrangler d1 execute crypto-news-db \
  --command "SELECT id, title, LENGTH(extractedContent) as content_length 
             FROM articles 
             WHERE extractedContent IS NOT NULL 
             LIMIT 5"
```

## Done! 🎉

Your Lambda function is now:
- Running every 2 minutes via EventBridge
- Scraping 2 articles in parallel per run
- Updating Cloudflare D1 with extracted content

## Next Steps

### Optional: Disable Cloudflare Worker Processor

To avoid duplicate work, disable the worker processor:

```bash
cd worker

# Edit worker-news-processor/wrangler.toml
# Comment out: [triggers] and crons = ["*/3 * * * *"]

# Redeploy
wrangler deploy --config worker-news-processor/wrangler.toml
```

### Monitor Usage

Keep an eye on Free Tier usage:

```bash
# Monthly invocations (target: < 1M)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=crypto-news-scraper \
  --start-time $(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 2592000 \
  --statistics Sum
```

Expected: ~21,600 invocations/month (well within 1M limit)

### Adjust Configuration

Edit `lambda-scraper/index.js` to tune:

```javascript
const BATCH_SIZE = 2;           // Process 2-4 sites per run
const BROWSER_TIMEOUT = 10000;  // Page load timeout (ms)
const PAGE_IDLE_TIMEOUT = 2000; // Wait for network idle (ms)
```

After changes:
```bash
./deploy.sh  # Choose update existing function
```

## Troubleshooting

### "Browser launch failed"
```bash
# Check layer is attached
aws lambda get-function --function-name crypto-news-scraper \
  --query 'Configuration.Layers[].Arn'

# Should show: arn:aws:lambda:us-east-1:764866452798:layer:chrome-aws-lambda:43
```

### "D1 API failed"
- Verify token has D1 edit permissions
- Check account ID and database ID are correct
- Try creating a new token

### No articles to process
This is normal! It means:
- Worker updater already filled the queue
- Lambda already processed everything
- Check back when new articles arrive (hourly)

## Support

- [README.md](./README.md) - Architecture and features
- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - Detailed deployment
- [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) - Migrating from Worker
- GitHub Issues - Report bugs or ask questions

---

**Free Tier Safety**: This setup processes ~21,600 articles/month using ~172,800 GB-seconds, well within AWS Free Tier limits (1M requests, 400K GB-seconds). No charges expected.
