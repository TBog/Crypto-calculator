# Deployment Guide: Scheduled Worker Architecture

This guide walks you through deploying the new scheduled worker architecture for Bitcoin news aggregation.

## Overview

The new architecture consists of two Cloudflare Workers:

1. **News Updater Worker** (`news-updater-cron.js`) - Scheduled worker that runs hourly
2. **Main API Worker** (`index.js`) - Public API endpoint that reads from KV

## Prerequisites

- Cloudflare account with Workers enabled
- Wrangler CLI installed (`npm install -g wrangler`)
- NewsData.io API key ([get one here](https://newsdata.io/))

## Step-by-Step Deployment

### Step 1: Login to Cloudflare

```bash
wrangler login
```

This will open a browser window for authentication.

### Step 2: Create KV Namespace

Create a KV namespace for storing the analyzed news data:

```bash
cd worker
wrangler kv:namespace create "CRYPTO_NEWS_CACHE"
```

**Expected output:**
```
⛅️ wrangler 3.x.x
-------------------
🌀 Creating namespace with title "crypto-news-updater-CRYPTO_NEWS_CACHE"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "CRYPTO_NEWS_CACHE", id = "abc123xyz456..." }
```

**Action:** Copy the namespace ID from the output.

### Step 3: Update Wrangler Configurations

#### For News Updater Worker

Edit `wrangler-news-updater.toml` and replace the namespace ID:

```toml
[[kv_namespaces]]
binding = "CRYPTO_NEWS_CACHE"
id = "YOUR_NAMESPACE_ID_HERE"  # Replace with the ID from Step 2
```

#### For Main API Worker

Edit `wrangler.toml` and replace the namespace ID:

```toml
[[kv_namespaces]]
binding = "CRYPTO_NEWS_CACHE"
id = "YOUR_NAMESPACE_ID_HERE"  # Replace with the same ID from Step 2
```

### Step 4: Create Production KV Namespace (Optional)

If deploying to production environment:

```bash
wrangler kv:namespace create "CRYPTO_NEWS_CACHE" --env production
```

Update the production namespace IDs in both config files under `[[env.production.kv_namespaces]]`.

### Step 5: Deploy the News Updater Worker

```bash
wrangler deploy --config wrangler-news-updater.toml
```

**Expected output:**
```
⛅️ wrangler 3.x.x
-------------------
Total Upload: xx.xx KiB / gzip: xx.xx KiB
Uploaded crypto-news-updater (x.xx sec)
Published crypto-news-updater (x.xx sec)
  https://crypto-news-updater.YOUR_SUBDOMAIN.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Step 6: Set NewsData.io API Key for News Updater

```bash
wrangler secret put NEWSDATA_API_KEY --config wrangler-news-updater.toml
```

**Prompt:** Enter your NewsData.io API key when prompted. The key will be stored securely.

### Step 7: Verify Scheduled Worker Configuration

Check that the cron trigger is properly configured:

```bash
wrangler deployments list --config wrangler-news-updater.toml
```

You should see your deployment with the cron schedule `0 * * * *` (hourly).

### Step 8: Deploy the Main API Worker

```bash
wrangler deploy
```

**Note:** The main worker no longer needs the `NEWSDATA_API_KEY` since it only reads from KV.

### Step 9: Verify Deployment

#### Check KV Storage

Wait up to 1 hour for the scheduled worker to run, then verify data is stored:

```bash
wrangler kv:key list --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml
```

You should see the key `BTC_ANALYZED_NEWS` in the list.

#### View Stored Data

```bash
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml
```

This will output the stored JSON data.

#### Monitor Scheduled Worker Logs

```bash
wrangler tail --config wrangler-news-updater.toml
```

Leave this running and wait for the next hour. You should see logs like:
```
=== Bitcoin News Updater Cron Job Started ===
Execution time: 2024-12-05T15:00:00.000Z
Starting article aggregation...
Fetching page 1...
...
=== Bitcoin News Updater Cron Job Completed Successfully ===
```

#### Test the API Endpoint

Once the scheduled worker has run, test the API endpoint:

```bash
curl https://crypto-cache.YOUR_SUBDOMAIN.workers.dev/api/bitcoin-news
```

You should receive a JSON response with articles, sentimentCounts, and lastUpdatedExternal timestamp.

### Step 10: Update Frontend Configuration

If your frontend is pointing to the old worker URL, update it to use the new API worker URL.

In your HTML/JavaScript, find:
```javascript
const WORKER_BASE_URL = 'https://crypto-cache.YOUR_SUBDOMAIN.workers.dev';
```

Verify it matches your deployed worker URL.

## Manual Testing (Optional)

To manually trigger the scheduled worker for testing (without waiting for the cron):

```bash
wrangler dev --config wrangler-news-updater.toml --test-scheduled
```

This will run the worker immediately in development mode.

## Monitoring

### View Real-Time Logs

For the scheduled worker:
```bash
wrangler tail --config wrangler-news-updater.toml
```

For the main API worker:
```bash
wrangler tail
```

### Check Deployment Status

```bash
# News updater worker
wrangler deployments list --config wrangler-news-updater.toml

# Main API worker
wrangler deployments list
```

### Inspect KV Data

```bash
# List all keys
wrangler kv:key list --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml

# Get specific key
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml

# Get metadata
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml --preview false --metadata
```

## Troubleshooting

### Issue: Scheduled worker not running

**Symptoms:** No logs appear, KV is empty after 1+ hour

**Solutions:**
1. Verify deployment: `wrangler deployments list --config wrangler-news-updater.toml`
2. Check cron configuration in `wrangler-news-updater.toml`
3. Manually trigger: `wrangler dev --config wrangler-news-updater.toml --test-scheduled`

### Issue: API endpoint returns "temporarily unavailable"

**Symptoms:** 503 error with message "News data temporarily unavailable"

**Solutions:**
1. Wait for scheduled worker to run (up to 1 hour after deployment)
2. Check scheduled worker logs: `wrangler tail --config wrangler-news-updater.toml`
3. Verify API key is set: `wrangler secret list --config wrangler-news-updater.toml`
4. Manually trigger worker to populate KV

### Issue: Sentiment analysis not working

**Symptoms:** Articles in KV don't have sentiment field

**Solutions:**
1. Verify AI binding is configured in `wrangler-news-updater.toml`
2. Check Cloudflare Workers AI is enabled for your account
3. Review worker logs for AI-related errors

### Issue: Running out of API credits

**Symptoms:** NewsData.io API returns 429 (rate limit) errors

**Solutions:**
1. Reduce cron frequency (e.g., every 2 hours: `0 */2 * * *`)
2. Reduce `TARGET_ARTICLES` in `news-updater-cron.js`
3. Upgrade NewsData.io plan
4. Check actual credit usage in NewsData.io dashboard

## Configuration Options

### Adjust Cron Schedule

Edit `wrangler-news-updater.toml`:

```toml
[triggers]
crons = ["0 * * * *"]  # Every hour (default)
# crons = ["0 */2 * * *"]  # Every 2 hours
# crons = ["0 */6 * * *"]  # Every 6 hours
# crons = ["0 0 * * *"]    # Once per day at midnight
```

### Adjust Article Limits

Edit `news-updater-cron.js`:

```javascript
const TARGET_ARTICLES = 100;  // Target number of new articles
const MAX_PAGES = 15;         // Maximum pagination pages
```

## Cost Estimates

### NewsData.io API (Free Tier: 200 credits/day)

With hourly cron (default):
- ~5-11 credits per run (depending on pagination)
- 24 runs/day = 120-264 credits/day
- **May exceed free tier**

With 2-hour cron:
- 12 runs/day = 60-132 credits/day
- **Fits within free tier**

### Cloudflare Workers (Free Tier)

- Scheduled workers: 1M requests/month (plenty)
- KV reads: 100K/day (plenty)
- KV writes: 1K/day (plenty - 24 writes/day)
- Workers AI: Check Cloudflare pricing page

## Rollback Plan

If issues occur, you can rollback to the previous version:

```bash
# Rollback main API worker
wrangler rollback

# Rollback news updater worker
wrangler rollback --config wrangler-news-updater.toml
```

Or temporarily disable the scheduled worker:

1. Comment out the `[triggers]` section in `wrangler-news-updater.toml`
2. Redeploy: `wrangler deploy --config wrangler-news-updater.toml`

## Next Steps

After successful deployment:

1. Monitor for 24 hours to ensure stability
2. Check API credit usage in NewsData.io dashboard
3. Adjust cron frequency if needed
4. Consider setting up alerts for failures
5. Document your specific configuration for future reference

## Support

For issues with:
- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Wrangler CLI: https://developers.cloudflare.com/workers/wrangler/
- NewsData.io API: https://newsdata.io/documentation

## Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare KV Docs](https://developers.cloudflare.com/kv/)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [NewsData.io API Docs](https://newsdata.io/documentation)
