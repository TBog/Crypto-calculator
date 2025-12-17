# KV-Based Article Processing Deployment Guide

## Overview

This guide covers deploying the KV-based "todo list" architecture that solves the "Too many subrequests" error using **FREE tier** Cloudflare services.

## Architecture

### Two-Worker System (FREE Tier Compatible)

1. **Producer Worker** (Hourly) - `crypto-news-updater`
   - Fetches articles from NewsData.io
   - Marks articles with postprocessing flags
   - Stores in KV (2 writes)
   - ~11 subrequests (well within 50 limit)

2. **Consumer Worker** (Every 10 min) - `crypto-news-processor`
   - Reads articles from KV
   - Processes 5 articles per run
   - Updates KV after EACH article (incremental saves)
   - ~15 subrequests (well within 50 limit)

### Why This Solves the Problem

**Before (Single Worker)**:
```
100 articles × 3 subrequests/article = 300 subrequests
❌ Exceeds 50 subrequest limit (free tier)
```

**After (KV-Based)**:
```
Producer: ~11 subrequests (fetch only)
Consumer: 5 articles × 3 subrequests = 15 per run
✅ Each run stays within 50 limit
✅ 100% FREE tier compatible
```

## Postprocessing Flags

Articles are marked with boolean flags indicating needed processing:

- **`needsSentiment: true`** - Needs sentiment analysis
- **`needsSummary: true`** - Needs AI summary generation
- **`contentTimeout: true`** - Previous fetch timed out, retry this run

After processing, flags are updated:
- `needsSentiment: false` and `sentiment: 'positive' | 'negative' | 'neutral'`
- `needsSummary: false` and `aiSummary: "text of summary"` (or left as true to retry)
- `contentTimeout: undefined` (cleared after successful fetch)

## Prerequisites

1. Cloudflare account (FREE tier is sufficient)
2. Wrangler CLI installed (`npm install -g wrangler`)
3. NewsData.io API key (free tier: 200 credits/day)
4. Existing KV namespace (from previous setup)

## Step 1: Verify KV Namespace

```bash
# List your KV namespaces
wrangler kv:namespace list

# If you need to create one:
wrangler kv:namespace create "CRYPTO_NEWS_CACHE"
```

Note the namespace ID - you'll need it for both workers.

## Step 2: Deploy Producer Worker

```bash
# Navigate to worker directory
cd worker

# Update wrangler-news-updater.toml with your KV namespace ID
# Replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID_FROM_STEP_2 with actual ID

# Deploy producer worker
wrangler deploy --config wrangler-news-updater.toml

# Set NewsData.io API key
wrangler secret put NEWSDATA_API_KEY --config wrangler-news-updater.toml
# Paste your API key when prompted
```

The producer will run hourly at the top of each hour.

## Step 3: Deploy Consumer Worker

```bash
# Update wrangler-news-processor.toml with SAME KV namespace ID
# Replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID_FROM_STEP_2 with actual ID

# Deploy consumer worker
wrangler deploy --config wrangler-news-processor.toml
```

The consumer will run every 10 minutes.

## Step 4: Verify Deployment

### Check Scheduled Workers

```bash
# List scheduled workers
wrangler deployments list --config wrangler-news-updater.toml
wrangler deployments list --config wrangler-news-processor.toml
```

You should see both workers deployed with cron triggers.

### Monitor Worker Logs

```bash
# Producer logs (hourly execution)
wrangler tail --config wrangler-news-updater.toml

# Consumer logs (every 10 minutes)
wrangler tail --config wrangler-news-processor.toml
```

### Check KV Data

```bash
# View stored articles
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml
```

Look for articles with flags like:
```json
{
  "title": "Bitcoin rises...",
  "needsSentiment": true,
  "needsSummary": true,
  ...
}
```

## Processing Timeline

After deployment:

```
Hour 0:00 - Producer runs
├─ Fetches 100 new articles
├─ Marks all with needsSentiment=true, needsSummary=true
└─ Stores in KV

0:10 - Consumer runs
├─ Finds 100 articles needing processing
├─ Processes first 5 articles
└─ Updates KV (5 writes)

0:20 - Consumer runs
├─ Processes next 5 articles
└─ 90 remaining

0:30 - Consumer runs
└─ Processes next 5 articles...

...continues every 10 minutes

After ~3 hours:
└─ All 100 articles fully processed
```

## Configuration Options

### Producer Frequency (wrangler-news-updater.toml)

```toml
[triggers]
crons = ["0 * * * *"]  # Every hour (default)
# OR
crons = ["0 */2 * * *"]  # Every 2 hours (saves API credits)
```

### Consumer Frequency (wrangler-news-processor.toml)

```toml
[triggers]
crons = ["*/10 * * * *"]  # Every 10 minutes (default)
# OR
crons = ["*/5 * * * *"]   # Every 5 minutes (faster processing)
# OR
crons = ["*/15 * * * *"]  # Every 15 minutes (slower)
```

### Articles Per Run (news-processor-cron.js)

Edit the constant:
```javascript
const MAX_ARTICLES_PER_RUN = 5;  // Default
// Increase to process faster (but watch subrequest limits)
// 5 articles × 3 subrequests = 15 (safe)
// 10 articles × 3 subrequests = 30 (still safe)
// 15 articles × 3 subrequests = 45 (close to limit)
```

## Monitoring

### Key Metrics

1. **Producer Success Rate**: Should run every hour
2. **Consumer Success Rate**: Should run every 10 minutes
3. **Pending Articles**: Check how many articles have flags
4. **Processing Time**: How long to process all articles
5. **Error Rate**: Check logs for failures

### Monitoring Commands

```bash
# Check recent producer runs
wrangler tail --config wrangler-news-updater.toml --format pretty

# Check recent consumer runs
wrangler tail --config wrangler-news-processor.toml --format pretty

# View KV statistics
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml | jq '.totalArticles, .sentimentCounts'
```

### What to Look For

**Producer logs** should show:
```
Fetching articles with early-exit optimization...
Marked 50 articles for AI processing
Write #1: Stored 150 articles in KV
```

**Consumer logs** should show:
```
Found 45 articles needing processing
Processing 5 articles this run...
Processing article 1/5: "Bitcoin rises..."
  Sentiment: positive
  AI Summary: Generated (243 chars)
  ✓ Article updated in KV
Processed: 5 articles
Remaining: 40 articles
```

## Troubleshooting

### Issue: Articles Stuck with Flags

**Symptoms**: Articles always show `needsSentiment: true`

**Solution**: Check consumer logs for errors
```bash
wrangler tail --config wrangler-news-processor.toml
```

Common causes:
- Consumer not running (check cron trigger)
- AI binding missing (check wrangler config)
- Errors during processing (check logs)

### Issue: "Too many subrequests" Still Occurs

**Symptoms**: Worker fails with subrequest limit error

**Solution**: Reduce MAX_ARTICLES_PER_RUN
```javascript
// In news-processor-cron.js
const MAX_ARTICLES_PER_RUN = 3;  // Reduce from 5
```

### Issue: Articles Not Appearing

**Symptoms**: No articles in KV

**Solution**: 
1. Check producer is running: `wrangler tail --config wrangler-news-updater.toml`
2. Verify API key: `wrangler secret list --config wrangler-news-updater.toml`
3. Check NewsData.io credits remaining

### Issue: contentTimeout Flag Never Clears

**Symptoms**: Articles permanently stuck with `contentTimeout: true`

**Solution**: Article URL may be permanently unreachable
- Check logs to see which URLs are timing out
- These articles will be retried each run
- Consider manually setting `needsSummary: false` for permanently broken URLs

## Cost Analysis

### Cloudflare FREE Tier Limits

```
Workers:
- 100,000 requests/day ✅
- Unlimited cron triggers ✅
- Workers AI: Check current limits ✅

KV:
- 100,000 reads/day ✅
- 1,000 writes/day ✅

Our Usage:
- Producer: 2 writes/hour × 24 = 48 writes/day ✅
- Consumer: 5 writes/run × 6 runs/hour × 24 = 720 writes/day ✅
- Total: 768 writes/day (within 1,000 limit) ✅
```

### NewsData.io Free Tier

```
- 200 credits/day
- Producer uses ~11 credits/hour
- 24 hours × 11 = 264 credits/day
- ⚠️ Slightly exceeds free tier
```

**Solution**: Run producer every 2 hours instead of hourly
```toml
crons = ["0 */2 * * *"]  # 12 runs/day × 11 = 132 credits ✅
```

## Best Practices

1. **Monitor Logs Regularly**: Check for errors in both workers
2. **Gradual Rollout**: Start with every 2 hours, then optimize
3. **Set Up Alerts**: Use Cloudflare's alerting for worker failures
4. **Test with Few Articles**: Manually trigger with small dataset first
5. **Document Errors**: Keep track of which URLs commonly fail

## Rollback Plan

If issues occur, revert to previous state:

```bash
# 1. List deployments
wrangler deployments list --config wrangler-news-updater.toml

# 2. Rollback producer
wrangler rollback --config wrangler-news-updater.toml

# 3. Rollback consumer
wrangler rollback --config wrangler-news-processor.toml

# 4. Or delete consumer entirely
wrangler delete --config wrangler-news-processor.toml
```

## Next Steps

After successful deployment:

1. Monitor for 24-48 hours to ensure stability
2. Check article sentiment accuracy in frontend
3. Verify AI summaries are being generated
4. Adjust frequencies based on your needs
5. Set up Cloudflare alerting for failures

## Support

For issues:
- Check worker logs: `wrangler tail`
- Review Cloudflare Workers documentation
- Open an issue in the GitHub repository
- Check Cloudflare status page for service issues
