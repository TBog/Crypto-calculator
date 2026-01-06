# Migration Guide: Cloudflare Worker to AWS Lambda Scraper

This guide helps you migrate from the Cloudflare Worker processor to the AWS Lambda scraper for better performance and broader site compatibility.

## Why Migrate?

### Benefits of AWS Lambda Scraper

1. **Full Browser Environment**
   - Real headless Chromium browser
   - JavaScript execution and rendering
   - Support for dynamic content and SPAs

2. **No CPU Timeout Limitations**
   - Cloudflare Workers: 10ms CPU limit (Free Tier)
   - AWS Lambda: 20+ seconds execution time

3. **Batch Processing**
   - Process 2+ sites in parallel per invocation
   - Single browser instance reduces "startup tax"
   - Better throughput with same or lower cost

4. **Better Scraping Success Rate**
   - Handles JavaScript-heavy sites
   - Waits for network idle
   - Can execute custom scripts if needed

### When to Use Each Option

**Use Cloudflare Worker Processor If:**
- Sites are mostly static HTML
- You're already at Free Tier limits on AWS
- You prefer edge computing
- Sites load very quickly (< 1 second)

**Use AWS Lambda Scraper If:**
- Sites use heavy JavaScript
- Content loads dynamically
- You need better success rates
- You want faster processing (batch mode)
- You're hitting Worker CPU timeouts

## Migration Steps

### Phase 1: Deploy Lambda Function

1. **Set up AWS credentials**
   ```bash
   aws configure
   # Enter your AWS Access Key, Secret Key, and Region
   ```

2. **Deploy Lambda function**
   ```bash
   cd lambda-scraper
   chmod +x deploy.sh
   ./deploy.sh
   ```

3. **Provide configuration when prompted:**
   - Cloudflare Account ID (from dashboard URL)
   - D1 Database ID (from `worker/worker-news-updater/wrangler.toml`)
   - Cloudflare API Token (create one with D1 edit permissions)
   - Chromium Layer ARN (use default for us-east-1)

4. **Test the deployment**
   ```bash
   aws lambda invoke \
     --function-name crypto-news-scraper \
     --payload '{}' \
     response.json
   
   cat response.json
   ```

### Phase 2: Verify Lambda Operation

1. **Check logs for successful execution**
   ```bash
   aws logs tail /aws/lambda/crypto-news-scraper --follow
   ```

   Look for:
   - "Browser launched successfully"
   - "Extracted X characters"
   - "Updated article ... in D1"

2. **Monitor for 15-30 minutes**
   
   Ensure:
   - Articles are being processed
   - No timeout errors
   - Success rate is good (> 80%)

3. **Verify D1 updates**
   
   Check articles in D1 have `extractedContent`:
   ```bash
   cd ../worker
   wrangler d1 execute crypto-news-db \
     --command "SELECT id, title, LENGTH(extractedContent) as content_length FROM articles WHERE extractedContent IS NOT NULL LIMIT 5"
   ```

### Phase 3: Disable Cloudflare Worker Processor

**IMPORTANT**: Only disable the processor AFTER confirming Lambda works!

1. **Disable the processor cron job**
   
   Edit `worker/worker-news-processor/wrangler.toml`:
   ```toml
   # Comment out the cron trigger
   # [triggers]
   # crons = ["*/3 * * * *"]
   ```

2. **Redeploy processor worker**
   ```bash
   cd worker
   wrangler deploy --config worker-news-processor/wrangler.toml
   ```

3. **Verify processor is disabled**
   ```bash
   # Check recent logs - should show no new cron invocations
   wrangler tail worker-news-processor
   ```

### Phase 4: Monitor Both Systems

For the first week, monitor both to ensure smooth transition:

**Lambda Metrics:**
```bash
# Check invocations
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=crypto-news-scraper \
  --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 \
  --statistics Sum

# Check duration
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=crypto-news-scraper \
  --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 \
  --statistics Average,Maximum

# Check errors
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Errors \
  --dimensions Name=FunctionName,Value=crypto-news-scraper \
  --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 \
  --statistics Sum
```

**D1 Database:**
```bash
# Check article processing status
cd worker
wrangler d1 execute crypto-news-db \
  --command "SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN extractedContent IS NOT NULL THEN 1 ELSE 0 END) as with_content,
    SUM(CASE WHEN needsSummary = 1 THEN 1 ELSE 0 END) as needs_summary
  FROM articles"
```

### Phase 5: Optimize Configuration

After confirming Lambda works well, optimize settings:

1. **Adjust batch size** (in `lambda-scraper/index.js`)
   ```javascript
   const BATCH_SIZE = 2; // Try 3-4 if processing is fast
   ```

2. **Tune timeouts** if needed
   ```javascript
   const BROWSER_TIMEOUT = 10000;    // Page load timeout
   const PAGE_IDLE_TIMEOUT = 2000;   // Wait for network idle
   ```

3. **Adjust schedule** if needed
   
   Edit CloudFormation or EventBridge rule:
   ```bash
   aws events put-rule \
     --name crypto-scraper-schedule \
     --schedule-expression "rate(3 minutes)"  # Change from 2 to 3 minutes
   ```

## Rollback Plan

If you need to roll back to the Cloudflare Worker:

1. **Re-enable processor cron job**
   
   Edit `worker/worker-news-processor/wrangler.toml`:
   ```toml
   [triggers]
   crons = ["*/3 * * * *"]
   ```

2. **Redeploy processor**
   ```bash
   cd worker
   wrangler deploy --config worker-news-processor/wrangler.toml
   ```

3. **Disable Lambda schedule**
   ```bash
   aws events disable-rule --name crypto-scraper-schedule
   ```

4. **Monitor worker logs**
   ```bash
   wrangler tail worker-news-processor
   ```

The Worker processor will resume where it left off, processing any pending articles.

## Cost Comparison

### Cloudflare Worker Processor
- **Free Tier**: 100,000 requests/day
- **Usage**: ~480 invocations/day (every 3 min)
- **Cost**: $0/month (well within Free Tier)

### AWS Lambda Scraper
- **Free Tier**: 1M requests/month, 400K GB-seconds
- **Usage**: ~21,600 invocations/month, ~172,800 GB-seconds
- **Cost**: $0/month (well within Free Tier)

**Verdict**: Both stay within Free Tier, but Lambda provides better performance.

## Hybrid Approach

You can run both simultaneously for redundancy:

1. **Lambda handles primary scraping** (every 2 minutes)
2. **Worker handles fallback** (every 10 minutes, reduced frequency)

This provides:
- Best performance from Lambda
- Automatic fallback if Lambda has issues
- No additional cost (both within Free Tier)

To implement:
1. Keep Lambda at 2-minute schedule
2. Change Worker to 10-minute schedule:
   ```toml
   crons = ["*/10 * * * *"]
   ```

Articles already processed by Lambda will be skipped by Worker (no duplicate work).

## Troubleshooting

### Lambda Issues

**"Browser launch failed"**
- Check Chromium layer is attached
- Verify memory allocation (needs 1024 MB)
- Check /tmp space (Lambda has 512 MB)

**"Timeout error"**
- Reduce BATCH_SIZE
- Increase Lambda timeout
- Check for slow/unresponsive sites

**"D1 API failed"**
- Verify API token permissions
- Check token hasn't expired
- Ensure account/database IDs are correct

### Worker Issues

**"CPU limit exceeded"**
- This is why we're migrating to Lambda!
- Reduce content extraction size
- Skip more elements in HTMLRewriter

**"Request timed out"**
- Sites are taking too long to respond
- Lambda's browser approach handles this better

## Support

For issues or questions:
1. Check [lambda-scraper/README.md](./README.md)
2. Check [lambda-scraper/DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
3. Review CloudWatch logs for Lambda
4. Review Wrangler logs for Worker
5. Open an issue on GitHub

## Next Steps

After successful migration:
- [ ] Monitor Free Tier usage for first month
- [ ] Set up CloudWatch billing alerts
- [ ] Consider adjusting schedule based on article volume
- [ ] Document any site-specific issues
- [ ] Share success metrics!
