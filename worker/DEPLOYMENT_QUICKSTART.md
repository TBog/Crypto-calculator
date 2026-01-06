# Quick Start: D1 + KV Architecture Deployment

## What Changed?

This update migrates from KV-only storage to D1+KV hybrid architecture for better performance and reduced KV writes.

### Benefits
- ✅ **76% fewer KV writes** (1,200 → 288/day)
- ✅ **2x faster processing** (10 min → 5 min average)
- ✅ **6x higher throughput** (combined frequency + batch size improvements)
- ✅ **Better querying** with SQL
- ✅ **Well within free tier** with room to scale 3-5x

## Prerequisites

- Wrangler CLI installed: `npm install -g wrangler`
- Authenticated with Cloudflare: `wrangler login`
- Existing KV namespace for CRYPTO_NEWS_CACHE

## 5-Minute Deployment

### Step 1: Create D1 Database (30 seconds)

```bash
cd worker

# Create development database
wrangler d1 create crypto-news-db
```

Copy the `database_id` from the output. Example:
```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### Step 2: Update Configuration (2 minutes)

Update `database_id` in these files with the ID from Step 1:
- `worker/worker-api/wrangler.toml` (line ~17)
- `worker/worker-news-updater/wrangler.toml` (line ~17)
- `worker/worker-news-processor/wrangler.toml` (line ~21)

Replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with your actual database ID.

### Step 3: Initialize Database Schema (30 seconds)

```bash
# Run migration to create tables
wrangler d1 execute crypto-news-db --file=schema.sql
```

Verify tables were created:
```bash
wrangler d1 execute crypto-news-db --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Expected output: `articles` and `processing_checkpoint` tables.

### Step 4: Deploy Workers (1 minute)

```bash
# Deploy all three workers
npm run deploy
```

Or deploy individually:
```bash
npm run deploy:updater    # News updater (writes to D1)
npm run deploy:processor  # News processor (reads D1, updates cache)
npm run deploy:api        # API worker (reads cache, falls back to D1)
```

### Step 5: Verify Deployment (1 minute)

Check if everything is working:

```bash
# 1. Check D1 has articles (wait ~1 hour for first updater cron)
wrangler d1 execute crypto-news-db --command "SELECT COUNT(*) FROM articles"

# 2. Test API endpoint
curl https://your-worker-name.workers.dev/api/bitcoin-news

# 3. Check response headers for cache status
curl -I https://your-worker-name.workers.dev/api/bitcoin-news
# Look for: X-Cache-Status: KV-HIT or D1-MISS
```

## Production Deployment

For production environment:

```bash
# 1. Create production database
wrangler d1 create crypto-news-db --env production

# 2. Update production database_id in wrangler.toml files
# Look for [env.production.d1_databases] sections

# 3. Initialize production schema
wrangler d1 execute crypto-news-db --file=schema.sql --env production

# 4. Deploy to production
wrangler deploy --config worker-api/wrangler.toml --env production
wrangler deploy --config worker-news-updater/wrangler.toml --env production
wrangler deploy --config worker-news-processor/wrangler.toml --env production
```

## Monitoring (First 24 Hours)

### Cloudflare Dashboard
1. Go to **Workers & Pages** → Your workers
2. Check **Metrics** tab for:
   - Request counts
   - Error rates
   - Execution time
3. Go to **D1** → crypto-news-db for:
   - Read/write operations
   - Storage usage
4. Go to **KV** → CRYPTO_NEWS_CACHE for:
   - Read/write operations
   - Storage usage

### Command Line Checks

```bash
# Check article count (should grow over time)
wrangler d1 execute crypto-news-db --command "SELECT COUNT(*) FROM articles"

# Check pending articles (should be low, ideally 0-10)
wrangler d1 execute crypto-news-db --command "SELECT COUNT(*) FROM articles WHERE needsSentiment = 1 OR needsSummary = 1"

# View recent articles
wrangler d1 execute crypto-news-db --command "SELECT id, title, sentiment, processedAt FROM articles ORDER BY pubDate DESC LIMIT 5"

# Check processor logs
wrangler tail worker-news-processor --format pretty

# Check updater logs  
wrangler tail worker-news-updater --format pretty
```

### Expected Metrics (After 24 Hours)

- **D1 writes**: ~1,500 operations
- **KV writes**: ~300 operations
- **Articles in D1**: 50-150 articles
- **Pending articles**: 0-20 articles
- **Cache hit rate**: 95%+ (most requests from KV)

## Troubleshooting

### "Database not found"
```bash
# List your databases
wrangler d1 list

# Make sure database_id in wrangler.toml matches
```

### "Table does not exist"
```bash
# Run the schema migration
wrangler d1 execute crypto-news-db --file=schema.sql

# Verify tables exist
wrangler d1 execute crypto-news-db --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### No articles appearing
```bash
# Check if updater is running (should run hourly)
wrangler tail worker-news-updater

# Manually trigger updater (if needed)
curl https://your-updater-worker.workers.dev

# Check if articles are in D1
wrangler d1 execute crypto-news-db --command "SELECT COUNT(*) FROM articles"
```

### High KV write usage
```bash
# Check processor frequency (should be every 5 minutes)
# View worker-news-processor/wrangler.toml crons setting

# Check processor logs for excessive updates
wrangler tail worker-news-processor

# Temporarily reduce frequency if needed
# Edit wrangler.toml: crons = ["*/10 * * * *"]
# Then: npm run deploy:processor
```

## Rollback (If Needed)

If you encounter critical issues:

```bash
# Reduce processor frequency to 10 minutes
# Edit worker-news-processor/wrangler.toml
# Change: crons = ["*/5 * * * *"]
# To: crons = ["*/10 * * * *"]

# Redeploy
npm run deploy:processor

# Monitor for 1 hour to see if issue resolves
```

If issues persist, contact support or open an issue with logs.

## Performance Expectations

### Before Migration (KV-Only)
- KV writes: ~1,200/day (near limit)
- Processing latency: 10 minutes average
- Cache hit rate: 95%
- Scalability: Limited (near KV write limit)

### After Migration (D1+KV)
- D1 writes: ~1,500/day (1.5% of limit)
- KV writes: ~300/day (30% of limit)
- Processing latency: 5 minutes average
- Cache hit rate: 95%+ (maintained)
- Scalability: Can grow 3-5x before limits

## Support & Documentation

- **Full Setup Guide**: `D1_SETUP_GUIDE.md`
- **Migration Summary**: `D1_KV_MIGRATION_SUMMARY.md`
- **Frequency Analysis**: `PROCESSOR_FREQUENCY_OPTIMIZATION.md`
- **Database Schema**: `schema.sql`
- **Utilities**: `shared/d1-utils.js`

## Success Checklist

After deployment, verify:

- [ ] D1 database created and schema initialized
- [ ] All three workers deployed successfully
- [ ] Worker logs show no errors
- [ ] Articles appearing in D1 (after first cron run)
- [ ] API endpoint returning data
- [ ] Cache headers showing KV-HIT or D1-MISS
- [ ] D1 usage under 5% of daily limits
- [ ] KV usage under 50% of daily limits
- [ ] No 5xx errors in dashboard metrics

---

**Questions or issues?** Check the troubleshooting section above or review the detailed guides in the worker/ directory.
