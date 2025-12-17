# Queue-Based Architecture Deployment Guide

## Overview

This guide covers deploying the queue-based architecture that solves the "Too many subrequests" error by distributing article processing across multiple worker invocations.

## Architecture

### Three-Worker System

1. **Scheduled Worker** (Producer) - `crypto-news-updater`
   - Runs every hour via cron trigger
   - Fetches articles from NewsData.io
   - Sends articles to Cloudflare Queue
   - Stores articles in KV with "pending" status

2. **Queue Consumer Worker** - `crypto-news-processor`
   - Processes articles from queue (1 at a time)
   - Fetches article content
   - Runs AI sentiment analysis
   - Generates AI summaries
   - Updates articles in KV

3. **API Worker** - `crypto-cache`
   - Reads enriched articles from KV
   - Serves to frontend

### Why This Solves the Problem

**Before (Single Worker)**:
```
100 articles × 3 subrequests/article = 300 subrequests
❌ Exceeds 50 subrequest limit (free tier)
```

**After (Queue-Based)**:
```
Producer: ~11 subrequests (fetch articles from NewsData.io)
Consumer: 3 subrequests × 1 article per invocation = 3 subrequests
✅ Each invocation stays well within 50 limit
```

## Prerequisites

1. Cloudflare account with Workers enabled
2. Wrangler CLI installed (`npm install -g wrangler`)
3. NewsData.io API key
4. Existing KV namespace (from previous setup)

## Step 1: Create Cloudflare Queues

```bash
# Create the main queue
wrangler queues create crypto-article-queue

# Create the dead letter queue (for failed messages)
wrangler queues create crypto-article-dlq
```

**Note**: Cloudflare Queues are available on the Workers Paid plan ($5/month minimum).

## Step 2: Deploy Queue Consumer Worker

```bash
# Navigate to worker directory
cd worker

# Update wrangler-news-processor.toml with your KV namespace ID
# Replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID_FROM_STEP_2 with actual ID

# Deploy consumer worker
wrangler deploy --config wrangler-news-processor.toml
```

The consumer will automatically start processing messages from the queue.

## Step 3: Update and Deploy Scheduled Worker

```bash
# The scheduled worker is already updated to use queues
# Just deploy it
wrangler deploy --config wrangler-news-updater.toml
```

## Step 4: Verify Deployment

### Check Queue Status

```bash
# List queues
wrangler queues list

# Check queue consumers
wrangler queues consumer list crypto-article-queue
```

You should see:
```
Queue: crypto-article-queue
Consumers:
  - Worker: crypto-news-processor
    Max Batch Size: 1
    Max Retries: 3
```

### Monitor Queue Processing

```bash
# View consumer logs
wrangler tail --config wrangler-news-processor.toml

# View producer logs
wrangler tail --config wrangler-news-updater.toml
```

### Test the Flow

1. **Wait for Scheduled Run**: The cron job will run at the top of each hour
2. **Check Producer Logs**: Should show articles being queued
3. **Check Consumer Logs**: Should show articles being processed
4. **Verify in KV**: Articles should update from "pending" to actual sentiment

```bash
# Check KV data
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml
```

## Configuration Options

### Consumer Worker (wrangler-news-processor.toml)

```toml
[[queues.consumers]]
queue = "crypto-article-queue"
max_batch_size = 1  # Process 1 article at a time (recommended)
max_batch_timeout = 30  # Wait max 30 seconds for batch
max_retries = 3  # Retry failed messages 3 times
dead_letter_queue = "crypto-article-dlq"  # DLQ for failed messages
```

**Tuning Options**:
- `max_batch_size`: Keep at 1 to ensure we stay within subrequest limits
- `max_retries`: Increase if articles frequently fail due to transient errors
- `max_batch_timeout`: Decrease for faster processing

### Producer Worker (wrangler-news-updater.toml)

```toml
[[queues.producers]]
queue = "crypto-article-queue"
binding = "ARTICLE_QUEUE"
```

## Monitoring and Debugging

### Check Queue Metrics

```bash
# View queue dashboard in Cloudflare dashboard
# Navigate to: Workers & Pages > Queues > crypto-article-queue
```

Metrics include:
- Messages queued
- Messages processed
- Messages in DLQ
- Processing time

### View Consumer Worker Logs

```bash
# Real-time logs
wrangler tail --config wrangler-news-processor.toml

# Look for:
# - "Processing article: ..." - Article being processed
# - "Sentiment: positive/negative/neutral" - Sentiment analysis complete
# - "Generated AI summary" - Summary generation complete
# - "Updated article in KV" - Article enriched in KV
```

### Check Dead Letter Queue

If articles fail after max retries, they go to DLQ:

```bash
# Create a consumer to inspect DLQ messages
wrangler queues consumer add crypto-article-dlq crypto-news-processor

# View DLQ messages in logs
wrangler tail --config wrangler-news-processor.toml
```

### Common Issues

**Issue**: Articles stuck in "pending" status
- **Cause**: Consumer worker not running or failing
- **Solution**: Check consumer logs for errors

**Issue**: Queue filling up
- **Cause**: Consumer processing slower than producer
- **Solution**: Check if articles are timing out; increase timeout or reduce article fetching

**Issue**: High costs
- **Cause**: Too many queue operations
- **Solution**: Reduce cron frequency (e.g., every 2 hours instead of hourly)

## Cost Analysis

### Cloudflare Workers Paid Plan ($5/month)

**Included**:
- 10 million requests/month
- Unlimited workers
- Unlimited cron triggers
- **Cloudflare Queues included**

**Queue Costs** (after included usage):
- Queue operations: $0.40 per million operations
- Message deliveries: Free (included)

### Estimated Monthly Costs

**Scenario: Hourly cron, 100 articles/run**

```
Producer:
- 24 runs/day × 30 days = 720 runs
- 720 runs × 100 articles = 72,000 queue writes
- Cost: $0.40 × (72,000 / 1,000,000) = $0.03

Consumer:
- 72,000 invocations (one per article)
- Cost: Included in Workers plan

API Worker:
- User requests (varies)
- Cost: Included in Workers plan

Total: ~$5.03/month (base plan + queue operations)
```

**Note**: This is significantly cheaper than upgrading NewsData.io plan and solves the subrequest limit issue.

## Rollback Plan

If issues occur, rollback to previous architecture:

```bash
# 1. Stop queueing articles (revert scheduled worker)
git checkout HEAD~1 worker/news-updater-cron.js
git checkout HEAD~1 worker/wrangler-news-updater.toml

# 2. Redeploy scheduled worker with old code
wrangler deploy --config wrangler-news-updater.toml

# 3. Delete consumer worker (optional)
wrangler delete --config wrangler-news-processor.toml
```

## Best Practices

1. **Monitor Queue Depth**: Keep an eye on queue metrics to ensure consumer keeps up
2. **Set Up Alerts**: Use Cloudflare's alerting for queue depth and DLQ messages
3. **Regular DLQ Cleanup**: Inspect and handle failed messages periodically
4. **Gradual Rollout**: Test with fewer articles first (reduce MAX_PAGES in producer)
5. **Logging**: Keep detailed logs in both producer and consumer for debugging

## Next Steps

After successful deployment:

1. Monitor for 24-48 hours to ensure stability
2. Check article sentiment accuracy in frontend
3. Verify AI summaries are being generated
4. Adjust cron frequency based on API credit usage
5. Set up Cloudflare alerting for critical metrics

## Support

For issues or questions:
- Check Cloudflare Workers documentation: https://developers.cloudflare.com/queues/
- Review worker logs using `wrangler tail`
- Check queue metrics in Cloudflare dashboard
- Open an issue in the GitHub repository
