# Deployment Guide: KV-Based Article Processing Architecture

This guide walks you through deploying the KV-based article processing architecture for Bitcoin news aggregation with AI analysis.

## Overview

The architecture consists of three Cloudflare Workers to solve the "Too many subrequests" error:

1. **News Updater Worker** (`news-updater-cron.js`) - Producer: Fetches articles hourly and marks them for processing
2. **News Processor Worker** (`news-processor-cron.js`) - Consumer: Processes 5 articles every 10 minutes with AI
3. **Main API Worker** (`index.js`) - Public API endpoint that reads from KV

This architecture uses **Cloudflare KV for individual article storage** to enable efficient processing and retrieval while staying within FREE tier limits.

## Cloudflare Free Tier Compatibility

This application is designed to work within Cloudflare's free tier limits:

### Workers Free Tier
- ✅ **100,000 requests/day** - More than sufficient for typical usage
- ✅ **10ms CPU time per request** - KV reads are <1ms
- ✅ **50 subrequest limit** - Solved by separating updater/processor workers

### KV Free Tier  
- ✅ **1 GB storage** - Application uses ~2.5 MB (0.25% of limit)
- ✅ **100,000 reads/day** - Typical usage ~11,000 reads/day (11% of limit)
- ✅ **1,000 writes/day** - Typical usage ~860-960 writes/day (86-96% of limit)
- ✅ **1,000 deletes/day** - TTL auto-cleanup, manual deletes rarely needed
- ✅ **1,000 list operations/day** - Not used by this application

**Note on Write Usage:** The individual article storage architecture uses more writes (N+1 per update cycle where N = new articles) compared to the legacy monolithic approach (2 writes per cycle). However, this is still well within free tier limits and provides better scalability and performance. See [KV_MIGRATION_GUIDE.md](./KV_MIGRATION_GUIDE.md) for optimization strategies if approaching limits.

### Workers AI Free Tier
- ✅ **10,000 neurons/day** - Optimized for sentiment + summaries
- ✅ **Content extraction** - Skips headers/footers to save neurons

**Storage Architecture:**
- Each article stored individually with `article:<id>` key (~5 KB per article)
- ID index maintains article list (~20 KB)
- 500 articles maximum (configurable via `MAX_STORED_ARTICLES`)
- 30-day TTL auto-cleanup prevents unbounded growth

## News Provider Support

The system supports multiple news providers:
- **NewsData.io** (default) - Requires AI sentiment analysis
- **APITube** - Includes built-in sentiment

See [NEWS_PROVIDER_GUIDE.md](./NEWS_PROVIDER_GUIDE.md) for detailed provider configuration instructions.

## Prerequisites

- Cloudflare account with Workers enabled (FREE tier is sufficient)
- Wrangler CLI installed (`npm install -g wrangler`)
- API key for your chosen news provider:
  - NewsData.io: [get one here](https://newsdata.io/)
  - APITube: Contact APITube for API access

## Architecture Diagram

```
Producer (hourly)         Consumer (every 10 min)      API (on-demand)
     │                           │                          │
     ├─ Fetch articles           ├─ Read KV                 ├─ Read KV
     ├─ Store individually       ├─ Process 5 articles      └─ Parallel reads
     └─ Update ID index          └─ Update individually         (<10ms)
         (~11 SR)                    (~15 SR)
         N+1 KV writes               5 KV writes
```

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

**Note:** This single namespace is shared by all three workers. Individual article storage means each article has its own key within this namespace.

### Step 3: Update Wrangler Configurations

#### For News Updater Worker (Producer)

Edit `worker-news-updater/wrangler.toml` and replace the namespace ID:

```toml
[[kv_namespaces]]
binding = "CRYPTO_NEWS_CACHE"
id = "YOUR_NAMESPACE_ID_HERE"  # Replace with the ID from Step 2
```

#### For News Processor Worker (Consumer)

Edit `worker-news-processor/wrangler.toml` and replace the namespace ID:

```toml
[[kv_namespaces]]
binding = "CRYPTO_NEWS_CACHE"
id = "YOUR_NAMESPACE_ID_HERE"  # Replace with the SAME ID from Step 2
```

#### For Main API Worker

Edit `worker-api/wrangler.toml` and replace the namespace ID:

```toml
[[kv_namespaces]]
binding = "CRYPTO_NEWS_CACHE"
id = "YOUR_NAMESPACE_ID_HERE"  # Replace with the SAME ID from Step 2
```

**Important:** All three workers must use the SAME KV namespace ID.

### Step 4: Create Production KV Namespace (Optional)

If deploying to production environment:

```bash
wrangler kv:namespace create "CRYPTO_NEWS_CACHE" --env production
```

Update the production namespace IDs in all three config files under `[[env.production.kv_namespaces]]`.

### Step 5: Deploy the News Updater Worker (Producer)

```bash
wrangler deploy --config worker-news-updater/wrangler.toml
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

### Step 6: Configure News Provider

#### Set Provider Selection (Optional)

Choose which news provider to use (defaults to NewsData.io if not set):

```bash
wrangler secret put NEWS_PROVIDER --config worker-news-updater/wrangler.toml
```

When prompted, enter either:
- `newsdata` for NewsData.io (default)
- `apitube` for APITube

#### Set Provider API Key

**For NewsData.io:**
```bash
wrangler secret put NEWSDATA_API_KEY --config worker-news-updater/wrangler.toml
```

When prompted, paste your NewsData.io API key and press Enter.

**For APITube:**
```bash
wrangler secret put APITUBE_API_KEY --config worker-news-updater/wrangler.toml
```

When prompted, paste your APITube API key and press Enter.

**Note:** You only need to set the API key for the provider you're using. However, it's recommended to set both keys to enable quick switching between providers.

### Step 7: Deploy the News Processor Worker (Consumer)

```bash
wrangler deploy --config worker-news-processor/wrangler.toml
```

**Expected output:**
```
⛅️ wrangler 3.x.x
-------------------
Total Upload: xx.xx KiB / gzip: xx.xx KiB
Uploaded crypto-news-processor (x.xx sec)
Published crypto-news-processor (x.xx sec)
  https://crypto-news-processor.YOUR_SUBDOMAIN.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Step 8: Deploy the Main API Worker

```bash
wrangler deploy
```

**Note:** The main worker no longer needs the `NEWSDATA_API_KEY` since it only reads from KV.

### Step 9: Verify Deployment

#### Check Cron Triggers

Verify both cron jobs are configured:

```bash
# Producer (runs hourly)
wrangler deployments list --config worker-news-updater/wrangler.toml

# Consumer (runs every 10 minutes)
wrangler deployments list --config worker-news-processor/wrangler.toml
```

You should see cron schedules:
- Producer: `0 * * * *` (hourly)
- Consumer: `*/10 * * * *` (every 10 minutes)

#### Monitor Initial Processing

Monitor the producer worker logs:

```bash
wrangler tail --config worker-news-updater/wrangler.toml
```

Wait for the next hour. You should see logs like:
```
=== Bitcoin News Updater Cron Job Started ===
Phase 1: Reading ID index from KV...
Phase 2: Fetching articles with early-exit optimization...
Phase 2: Marking articles for AI processing...
Phase 3: Updating KV (2 writes)...
Queued 50 articles for AI processing by consumer worker
=== Bitcoin News Updater Cron Job Completed Successfully ===
```

#### Monitor Consumer Processing

In a separate terminal, monitor the consumer worker:

```bash
wrangler tail --config worker-news-processor/wrangler.toml
```

You should see logs every 10 minutes:
```
=== Bitcoin News Processor Cron Job Started ===
Step 1: Reading articles from KV...
Step 2: Finding articles that need processing...
Found 50 articles needing processing
Processing 5 articles this run...
Processing article 1/5: "Bitcoin rises..."
  Sentiment: positive
  AI Summary: Generated (243 chars)
  ✓ Article updated in KV
...
Processed: 5 articles
Remaining: 45 articles (will process in next run)
=== Bitcoin News Processor Cron Job Completed Successfully ===
```

#### Check KV Storage

Verify data is being stored:

```bash
wrangler kv:key list --binding CRYPTO_NEWS_CACHE --config worker-news-updater/wrangler.toml
```

You should see keys like `BTC_ANALYZED_NEWS` and `BTC_ID_INDEX`.

#### View Stored Articles

```bash
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config worker-news-updater/wrangler.toml | jq '.articles[0]'
```

You should see article data with postprocessing flags:
```json
{
  "article_id": "abc123",
  "title": "Bitcoin...",
  "needsSentiment": false,
  "needsSummary": false,
  "sentiment": "positive",
  "aiSummary": "...",
  "processedAt": 1702834890
}
```

#### Test the API Endpoint

Once processing has started, test the API endpoint:

```bash
curl https://crypto-cache.YOUR_SUBDOMAIN.workers.dev/api/bitcoin-news
```

You should receive a JSON response with articles (some may still be pending processing):
```json
{
  "success": true,
  "totalArticles": 50,
  "sentimentCounts": {"positive": 15, "negative": 5, "neutral": 20},
  "articles": [...]
}
```

#### Test On-Demand Processing (Optional)

You can manually process a specific article:

```bash
curl "https://crypto-news-processor.YOUR_SUBDOMAIN.workers.dev/process?articleId=ARTICLE_ID"
```

### Step 10: Update Frontend Configuration

If your frontend is pointing to the old worker URL, update it to use the new API worker URL.

In your HTML/JavaScript, find:
```javascript
const WORKER_BASE_URL = 'https://crypto-cache.YOUR_SUBDOMAIN.workers.dev';
```

Verify it matches your deployed worker URL.

## Manual Testing (Optional)

### Trigger Producer Manually

To manually trigger the producer for testing (without waiting for cron):

```bash
wrangler dev --config worker-news-updater/wrangler.toml --test-scheduled
```

This will run the worker immediately in development mode.

### Trigger Consumer Manually

To test the consumer worker:

```bash
wrangler dev --config worker-news-processor/wrangler.toml --test-scheduled
```

## Monitoring

### View Real-Time Logs

For the producer worker:
```bash
wrangler tail --config worker-news-updater/wrangler.toml
```

For the consumer worker:
```bash
wrangler tail --config worker-news-processor/wrangler.toml
```

For the main API worker:
```bash
wrangler tail
```

### Check Deployment Status

```bash
# News updater worker
wrangler deployments list --config worker-news-updater/wrangler.toml

# Main API worker
wrangler deployments list
```

### Inspect KV Data

```bash
# List all keys
wrangler kv:key list --binding CRYPTO_NEWS_CACHE --config worker-news-updater/wrangler.toml

# Get specific key
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config worker-news-updater/wrangler.toml

# Get metadata
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config worker-news-updater/wrangler.toml --preview false --metadata
```

## Troubleshooting

### Issue: Scheduled worker not running

**Symptoms:** No logs appear, KV is empty after 1+ hour

**Solutions:**
1. Verify deployment: `wrangler deployments list --config worker-news-updater/wrangler.toml`
2. Check cron configuration in `worker-news-updater/wrangler.toml`
3. Manually trigger: `wrangler dev --config worker-news-updater/wrangler.toml --test-scheduled`

### Issue: API endpoint returns "temporarily unavailable"

**Symptoms:** 503 error with message "News data temporarily unavailable"

**Solutions:**
1. Wait for scheduled worker to run (up to 1 hour after deployment)
2. Check scheduled worker logs: `wrangler tail --config worker-news-updater/wrangler.toml`
3. Verify API key is set: `wrangler secret list --config worker-news-updater/wrangler.toml`
4. Manually trigger worker to populate KV

### Issue: Sentiment analysis not working

**Symptoms:** Articles in KV don't have sentiment field or all show neutral

**Solutions:**
1. Verify AI binding is configured in `worker-news-updater/wrangler.toml`
2. Check Cloudflare Workers AI is enabled for your account
3. Review worker logs for AI-related errors
4. Ensure Cloudflare Workers AI has the Llama 3.1 model available

### Issue: Running out of API credits

**Symptoms:** NewsData.io API returns 429 (rate limit) errors

**Solutions:**
1. Reduce cron frequency (e.g., every 2 hours: `0 */2 * * *`)
2. Reduce `TARGET_ARTICLES` in `news-updater-cron.js`
3. Upgrade NewsData.io plan
4. Check actual credit usage in NewsData.io dashboard

## Configuration Options

### Adjust Producer Schedule

Edit `worker-news-updater/wrangler.toml`:

```toml
[triggers]
crons = ["0 * * * *"]  # Every hour (default)
# crons = ["0 */2 * * *"]  # Every 2 hours (recommended for free tier)
# crons = ["0 */6 * * *"]  # Every 6 hours
# crons = ["0 0 * * *"]    # Once per day at midnight
```

### Adjust Consumer Schedule

Edit `worker-news-processor/wrangler.toml`:

```toml
[triggers]
crons = ["*/10 * * * *"]  # Every 10 minutes (default)
# crons = ["*/5 * * * *"]   # Every 5 minutes (faster processing)
# crons = ["*/15 * * * *"]  # Every 15 minutes (slower processing)
```

### Adjust Processing Batch Size

Edit `news-processor-cron.js`:

```javascript
const MAX_ARTICLES_PER_RUN = 5;  // Articles processed per run (default)
// const MAX_ARTICLES_PER_RUN = 10;  # Faster processing (30 subrequests - still safe)
// const MAX_ARTICLES_PER_RUN = 3;   # Safer for very slow networks
```

### Adjust Article Limits

Edit `news-updater-cron.js`:

```javascript
const MAX_STORED_ARTICLES = 500;  // Maximum articles in KV
const MAX_PAGES = 15;             // Maximum pagination pages
```

## Cost Estimates

### NewsData.io API (Free Tier: 200 credits/day)

**⚠️ IMPORTANT: The default hourly schedule may exceed the free tier limit.**

With hourly producer (default):
- ~11 credits per run (pagination to fetch articles)
- 24 runs/day = 264 credits/day
- **⚠️ EXCEEDS the 200 credit free tier limit**
- **Recommendation**: Use 2-hour schedule for free tier

With 2-hour producer schedule (recommended for free tier):
- 12 runs/day = 132 credits/day
- **✅ Fits comfortably within free tier limits**
- Articles still updated every 2 hours
- Consumer continues processing every 10 minutes

To use 2-hour schedule, edit `worker-news-updater/wrangler.toml`:
```toml
[triggers]
crons = ["0 */2 * * *"]  # Every 2 hours instead of hourly
```

### Cloudflare Workers & KV (FREE Tier)

**All services used are FREE tier compatible:**

- Producer: ~11 subrequests per run (well under 50 limit)
- Consumer: ~15 subrequests per run (well under 50 limit)
- KV Writes: 48 (producer) + 720 (consumer) = 768/day (under 1000 limit)
- KV Reads: Minimal (only by workers, not counted toward user limits)
- Cron Triggers: Unlimited on free tier

**Total Cost: $0/month**

### Cloudflare Workers (Free Tier)

- Scheduled workers: 1M requests/month (plenty)
- KV reads: 100K/day (plenty)
- KV writes: 1K/day (plenty - 48 writes/day with 2 writes per run)
- Workers AI: Included in Workers paid plan or free tier limits

## Rollback Plan

If issues occur, you can rollback to the previous version:

```bash
# Rollback main API worker
wrangler rollback

# Rollback news updater worker
wrangler rollback --config worker-news-updater/wrangler.toml
```

Or temporarily disable the scheduled worker:

1. Comment out the `[triggers]` section in `worker-news-updater/wrangler.toml`
2. Redeploy: `wrangler deploy --config worker-news-updater/wrangler.toml`

## Next Steps

After successful deployment:

1. Monitor for 24 hours to ensure stability
2. Check API credit usage in NewsData.io dashboard
3. Adjust cron frequency if needed
4. Consider setting up alerts for failures
5. Document your specific configuration for future reference

## Automated Deployment with GitHub Actions

For continuous deployment, the repository includes separate GitHub Actions workflows for development and production environments.

### Deployment Environments

**Development Environment:**
- **Branch:** `main`
- **Workflows:** 
  - `deploy-workers.yml` - Deploys all three workers to development
  - `deploy-d1-schema.yml` - Deploys database schema to development
- **Trigger:** Automatic on push to `main` branch
- **Environment:** Default (development) Cloudflare environment

**Production Environment:**
- **Branch:** `production`
- **Workflows:**
  - `deploy-workers-production.yml` - Deploys all three workers to production
  - `deploy-d1-schema-production.yml` - Deploys database schema to production
- **Trigger:** Automatic on push to `production` branch
- **Environment:** Production Cloudflare environment (uses `--env production` flag)

### Setup GitHub Actions Deployment

1. **Add Cloudflare Secrets to GitHub Repository**
   
   Go to your repository Settings → Secrets and variables → Actions, then add:
   
   - `CLOUDFLARE_API_TOKEN`: Create a token at [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
     - Use "Edit Cloudflare Workers" template or create custom token with Workers permissions
   - `CLOUDFLARE_ACCOUNT_ID`: Found in your Cloudflare Dashboard or Workers overview page

2. **Development Workflow Configuration**
   
   The development workflow files are located at:
   - `.github/workflows/deploy-workers.yml`
   - `.github/workflows/deploy-d1-schema.yml`
   
   These workflows will:
   - Trigger on push to `main` branch when relevant files change
   - Can also be manually triggered from GitHub Actions tab
   - Deploy all three workers to the development environment in parallel
   - Deploy without the `--env` flag (uses default/development configuration)

3. **Production Workflow Configuration**
   
   The production workflow files are located at:
   - `.github/workflows/deploy-workers-production.yml`
   - `.github/workflows/deploy-d1-schema-production.yml`
   
   These workflows will:
   - Trigger on push to `production` branch when relevant files change
   - Can also be manually triggered from GitHub Actions tab
   - Deploy all three workers to the production environment using `--env production`
   - Use production-specific database IDs and KV namespaces from `[env.production]` sections

4. **How It Works**
   
   **Development deployment:**
   ```bash
   wrangler deploy --config worker-{name}/wrangler.toml
   ```
   
   **Production deployment:**
   ```bash
   wrangler deploy --config worker-{name}/wrangler.toml --env production
   ```
   
   This ensures all workers have access to the `shared/` folder containing `news-providers.js` and use the correct environment configuration.

5. **Deploying to Production**
   
   To deploy changes to production:
   
   ```bash
   # First, ensure changes are tested and merged to main
   git checkout main
   git pull origin main
   
   # Switch to production branch and merge from main
   git checkout production
   git merge main
   
   # Push to trigger production deployment
   git push origin production
   ```
   
   Alternatively, if you don't have a local production branch:
   ```bash
   # From main branch
   git checkout main
   git pull origin main
   git push origin main:production
   ```

6. **Manual Trigger**
   
   You can manually trigger deployment:
   - Go to Actions tab in GitHub
   - Select the appropriate workflow:
     - "Deploy Cloudflare Workers (Development)" for dev
     - "Deploy Cloudflare Workers (Production)" for production
   - Click "Run workflow"
   - Select the appropriate branch (`main` or `production`)

7. **Monitoring Deployments**
   
   - View deployment status in the Actions tab
   - Check deployment logs in Cloudflare Dashboard
   - Verify worker versions in Cloudflare Workers & Pages dashboard
   - Monitor separate development and production deployments

For detailed information about the GitHub Actions setup, see [.github/workflows/README.md](../.github/workflows/README.md).

## Support

For issues with:
- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Wrangler CLI: https://developers.cloudflare.com/workers/wrangler/
- NewsData.io API: https://newsdata.io/documentation
- Cloudflare Workers AI: https://developers.cloudflare.com/workers-ai/

## Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare KV Docs](https://developers.cloudflare.com/kv/)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [NewsData.io API Docs](https://newsdata.io/documentation)
