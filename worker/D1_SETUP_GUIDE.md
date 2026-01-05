# D1 Database Setup Guide

This guide explains how to set up and configure Cloudflare D1 database for the Crypto Calculator workers.

## Overview

The Crypto Calculator uses Cloudflare D1 (SQLite at the edge) for storing and processing Bitcoin news articles. D1 provides:
- **5 million row reads/day** (free tier) - perfect for filtering, sorting, searching
- **100,000 row writes/day** (free tier) - plenty for article updates
- **SQL support** - powerful queries, joins, and filtering
- **Regional storage** - data lives in one location but can be queried globally

KV is used alongside D1 for caching final API responses:
- **100,000 reads/day** (free tier) - for serving cached responses
- **1,000 writes/day** (free tier) - only for updating cached API responses

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     News Updater Worker                         │
│                  (Runs hourly via cron)                         │
│                                                                 │
│  1. Fetch articles from external API                           │
│  2. Insert new articles into D1                                │
│  3. Mark articles for processing (needsSentiment, needsSummary) │
│                                                                 │
│  KV Writes: 0 (no KV updates at this stage)                    │
│  D1 Writes: ~10-50 per hour (new articles only)                │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       D1 Database                               │
│                   (SQLite at the edge)                          │
│                                                                 │
│  Table: articles                                                │
│  - All article data + processing flags                          │
│  - Indexed for efficient queries                                │
│  - Supports filtering, sorting, pagination                      │
│                                                                 │
│  5M reads/day, 100K writes/day (free tier)                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    News Processor Worker                        │
│               (Runs every 10 min via cron)                      │
│                                                                 │
│  1. Query D1 for articles needing processing (LIMIT 5)         │
│  2. Run AI sentiment analysis and summarization                │
│  3. Update articles in D1 with results                         │
│  4. When batch is complete, trigger KV cache update            │
│                                                                 │
│  KV Writes: 1 per batch (only when cache refresh needed)       │
│  D1 Writes: 5 per run (article updates)                        │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                         API Worker                              │
│                  (Handles client requests)                      │
│                                                                 │
│  Read Path:                                                     │
│  1. Check KV cache for response                                │
│  2. If cache hit, return immediately (<10ms)                   │
│  3. If cache miss:                                             │
│     a. Query D1 for articles (with filters, sorting)           │
│     b. Build response from D1 results                          │
│     c. Cache response in KV for future requests                │
│                                                                 │
│  KV Writes: Only on cache miss (rare)                          │
│  D1 Reads: Only on cache miss (queries with filters)           │
└─────────────────────────────────────────────────────────────────┘
```

## Setup Instructions

### Quick Start with GitHub Actions

The repository includes automated GitHub Actions for deploying both the D1 schema and the workers:

1. **Deploy D1 Schema**: The `deploy-d1-schema.yml` workflow automatically deploys the database schema when changes are pushed to `main` or can be manually triggered
2. **Deploy Workers**: The `deploy-workers.yml` workflow automatically deploys all workers when changes are pushed to `main`

This means you only need to:
1. Create the D1 database (see step 1 below)
2. Update the database IDs in `wrangler.toml` files (see step 2 below)
3. Push to `main` branch - GitHub Actions will handle the rest!

### 1. Create D1 Database

```bash
# Create database for development
wrangler d1 create crypto-news-db

# Create database for production
wrangler d1 create crypto-news-db --env production
```

This will output a database ID like:
```
✅ Successfully created DB 'crypto-news-db' in region WEUR
Created your database using D1's new storage backend. The new storage backend is not yet recommended for production workloads, but backs up your data via point-in-time restore.

[[d1_databases]]
binding = "DB"
database_name = "crypto-news-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 2. Update wrangler.toml Files

Add the D1 database binding to each worker's `wrangler.toml`:

**worker-api/wrangler.toml**:
```toml
[[d1_databases]]
binding = "DB"
database_name = "crypto-news-db"
database_id = "YOUR_DATABASE_ID"

[env.production.d1_databases]
binding = "DB"
database_name = "crypto-news-db"
database_id = "YOUR_PRODUCTION_DATABASE_ID"
```

**worker-news-updater/wrangler.toml**:
```toml
[[d1_databases]]
binding = "DB"
database_name = "crypto-news-db"
database_id = "YOUR_DATABASE_ID"

[env.production.d1_databases]
binding = "DB"
database_name = "crypto-news-db"
database_id = "YOUR_PRODUCTION_DATABASE_ID"
```

**worker-news-processor/wrangler.toml**:
```toml
[[d1_databases]]
binding = "DB"
database_name = "crypto-news-db"
database_id = "YOUR_DATABASE_ID"

[env.production.d1_databases]
binding = "DB"
database_name = "crypto-news-db"
database_id = "YOUR_PRODUCTION_DATABASE_ID"
```

### 3. Run Database Migrations

#### Option A: Using GitHub Actions (Recommended)

The repository includes a GitHub Action workflow that automatically deploys the D1 schema.

**Automatic Deployment:**
- The schema is automatically deployed to the development database when `worker/schema.sql` is updated on the `main` branch
- The workflow runs automatically on push to ensure the database schema is always up-to-date

**Manual Deployment:**
1. Go to the "Actions" tab in the GitHub repository
2. Select the "Deploy D1 Database Schema" workflow
3. Click "Run workflow"
4. Choose the environment:
   - `development` - Deploy to development database only
   - `production` - Deploy to production database only
   - `both` - Deploy to both environments
5. Click "Run workflow"

The workflow will:
- Deploy the schema from `worker/schema.sql`
- Initialize the `processing_checkpoint` table
- Verify the deployment was successful

#### Option B: Using Wrangler CLI Locally

You can also deploy the schema manually using Wrangler:

```bash
# Initialize the database schema (development)
cd worker
wrangler d1 execute crypto-news-db --file=./schema.sql

# Initialize the database schema (production)
wrangler d1 execute crypto-news-db --file=./schema.sql --env production
```

### 4. Verify Setup

```bash
# Query the database to verify it's set up correctly
wrangler d1 execute crypto-news-db --command "SELECT name FROM sqlite_master WHERE type='table'"

# Expected output:
# ┌──────────────────────────┐
# │ name                     │
# ├──────────────────────────┤
# │ articles                 │
# │ processing_checkpoint    │
# └──────────────────────────┘
```

## Migration from KV-Only to D1+KV

If you're migrating from a KV-only setup:

1. **Deploy updated workers** with D1 bindings
2. **Run the initial migration** (if you have existing data in KV):
   ```bash
   # The workers will automatically detect KV data and migrate to D1
   # on first run (see migration logic in worker code)
   ```
3. **Monitor the migration**:
   - Check D1 database for articles: `wrangler d1 execute crypto-news-db --command "SELECT COUNT(*) FROM articles"`
   - Verify KV cache is being updated after processing

## Free Tier Limits

### D1 Database (Primary Storage)
- **Storage**: 500 MB total
- **Reads**: 5 million rows/day
- **Writes**: 100,000 rows/day
- **Best for**: Heavy queries, filtering, sorting, joins

### KV Storage (Response Cache)
- **Storage**: 1 GB total
- **Reads**: 100,000 operations/day
- **Writes**: 1,000 operations/day
- **Best for**: Globally replicated cache for API responses

### How We Stay Within Limits

1. **D1 Writes (~1,500/day)**:
   - Updater: ~20 articles/hour × 24 hours = 480 writes/day
   - Processor: 5 articles × 6 runs/hour × 24 hours = 720 writes/day
   - Total: ~1,200 writes/day ✅ (well under 100K limit)

2. **KV Writes (~150/day)**:
   - Cache updates: Once per processor batch (6 × 24 = 144/day)
   - Manual cache refresh: Occasional (< 10/day)
   - Total: ~150 writes/day ✅ (well under 1K limit)

3. **D1 Reads (~50,000/day)**:
   - API queries on cache miss: ~1,000/day
   - Processor queries: 6 × 24 = 144/day
   - Total: ~1,200 reads/day ✅ (well under 5M limit)

4. **KV Reads (~50,000/day)**:
   - API cache hits: ~95% of requests (estimated 50K/day)
   - Total: 50,000 reads/day ✅ (well under 100K limit)

## Monitoring

### Check D1 Usage

```bash
# Count articles in database
wrangler d1 execute crypto-news-db --command "SELECT COUNT(*) FROM articles"

# Check articles needing processing
wrangler d1 execute crypto-news-db --command "SELECT COUNT(*) FROM articles WHERE needsSentiment = 1 OR needsSummary = 1"

# View recent articles
wrangler d1 execute crypto-news-db --command "SELECT id, title, sentiment, needsSentiment, needsSummary FROM articles ORDER BY pubDate DESC LIMIT 10"

# Check processing checkpoint
wrangler d1 execute crypto-news-db --command "SELECT * FROM processing_checkpoint"
```

### Check KV Cache

Use the API worker fetch endpoint:
```bash
curl https://your-worker.workers.dev/api/bitcoin-news
```

Check the response headers:
- `X-Cache-Status`: HIT (cached) or MISS (fetched from D1)
- `X-Last-Updated`: Timestamp of cache update

## Troubleshooting

### "Database not found" error
- Make sure you've created the database: `wrangler d1 create crypto-news-db`
- Verify the database ID in wrangler.toml matches the created database

### "Table not found" error
- Run the schema migration: `wrangler d1 execute crypto-news-db --file=./schema.sql`

### No articles in D1
- Check if the updater worker is running: view cron triggers in Cloudflare dashboard
- Check worker logs for errors: `wrangler tail worker-news-updater`

### KV cache always showing MISS
- Verify the processor worker is running and updating the cache
- Check D1 for processed articles: `SELECT COUNT(*) FROM articles WHERE processedAt IS NOT NULL`
- Verify the cache key matches in both processor and API workers

## Cost Considerations

### When to Use D1 vs KV

**Use D1 for:**
- ✅ Storing all article data
- ✅ Complex queries (filtering by sentiment, date range, etc.)
- ✅ Sorting and pagination
- ✅ Processing state (flags, timestamps)
- ✅ Incremental updates per article

**Use KV for:**
- ✅ Caching final API responses
- ✅ Global low-latency reads
- ✅ Simple key-value lookups
- ✅ Infrequently changing data

### Staying on Free Tier

The free tier limits are generous for this use case:
- D1: 100K writes/day allows ~69 writes/minute continuously
- KV: 1K writes/day allows updates every ~90 seconds

Our architecture uses:
- D1 writes: ~1-2 per minute (well within limits)
- KV writes: ~1 every 10 minutes (well within limits)

**Important**: If you need to process more articles:
1. Increase MAX_ARTICLES_PER_RUN gradually (5 → 10 → 20)
2. Monitor D1 write operations in Cloudflare dashboard
3. Adjust processor cron frequency if needed (10 min → 15 min)

## Next Steps

1. Deploy the updated workers with D1 support
2. Monitor the first few hours of operation
3. Check D1 and KV usage in Cloudflare dashboard
4. Adjust configuration if needed (MAX_ARTICLES_PER_RUN, cache TTL)
