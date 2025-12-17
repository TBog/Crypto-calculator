# Bitcoin News Processing - KV-Based Architecture

This document describes the KV-based "todo list" architecture for Bitcoin news aggregation and AI analysis, which solves the "Too many subrequests" error while maintaining FREE tier compatibility.

## Architecture Overview

The system uses **three Cloudflare Workers** to process Bitcoin news articles:

1. **Producer** (`news-updater-cron.js`) - Fetches articles hourly and marks them for processing
2. **Consumer** (`news-processor-cron.js`) - Processes 5 articles every 10 minutes with AI
3. **API** (`index.js`) - Serves enriched articles to users

### Why This Architecture?

**Problem**: Processing 100 articles × 3 subrequests = 300 subrequests → Exceeds 50 limit ❌

**Solution**: Split processing across multiple cron runs:
- Producer: 11 subrequests (fetch only)
- Consumer: 15 subrequests (5 articles × 3) per run
- Each run stays under 50 limit ✅

## Data Flow

```
┌─────────────────────────────────────────┐
│  Producer Worker                        │
│  (news-updater-cron.js)                │
│  Runs: Every hour                       │
│                                         │
│  1. Fetch 100+ articles from API       │
│  2. Mark with processing flags:        │
│     - needsSentiment: true             │
│     - needsSummary: true               │
│  3. Store in KV                        │
│  (~11 subrequests)                     │
└─────────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  Cloudflare KV   │
         │  "Todo List"     │
         │                  │
         │  Articles with   │
         │  pending flags   │
         └──────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  Consumer Worker                        │
│  (news-processor-cron.js)               │
│  Runs: Every 10 minutes                 │
│                                         │
│  1. Read articles from KV               │
│  2. Filter articles with flags          │
│  3. Process 5 articles:                 │
│     - Analyze sentiment (AI)            │
│     - Fetch article content             │
│     - Generate AI summary               │
│  4. Update KV after EACH article        │
│  (~15 subrequests per run)             │
└─────────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  Updated KV      │
         │                  │
         │  Enriched        │
         │  articles        │
         └──────────────────┘
                    │
                    ▼
          ┌──────────────────┐
          │  API Worker      │
          │  (index.js)      │
          │                  │
          │  Read KV only    │
          │  <10ms response  │
          └──────────────────┘
```

## Key Features

### Postprocessing Flags

Articles are stored in KV with boolean flags:
- `needsSentiment: true` → Needs sentiment analysis
- `needsSummary: true` → Needs AI summary generation
- `contentTimeout: integer` → Failed fetch attempts (retry if < 5)
- `summaryError: string` → Diagnostic error information

### Incremental Processing

- Consumer processes 5 articles per run (every 10 minutes)
- KV updated after EACH article (not at end of batch)
- If error occurs, already-processed articles are saved
- ~3 hours to process 100 articles (acceptable trade-off for FREE tier)

### Automatic Retry Logic

- Failed articles tracked with `contentTimeout` counter
- Retry up to 5 times before giving up
- `summaryError` field stores diagnostic info:
  - `"fetch_failed (attempt 3/5)"` - Network/timeout issues
  - `"content_mismatch"` - Paywall/wrong content
  - `"error: <msg> (attempt 2/5)"` - AI processing errors

### On-Demand Processing

Consumer worker also supports HTTP requests:
```bash
GET /process?articleId=<id>
```

Returns full article JSON with processing status.

## Benefits

✅ **FREE Tier Compatible**
- No paid Cloudflare Queues needed
- All processing uses free KV storage
- Cron triggers are free
- Workers AI included in free tier

✅ **Solves Subrequest Limit**
- Producer: 11 subrequests (well under 50)
- Consumer: 15 subrequests per run (well under 50)
- Scales to unlimited articles

✅ **Resilient to Errors**
- Incremental KV writes preserve progress
- Automatic retry with attempt counting
- Diagnostic error tracking
- Dead articles stop retrying after 5 failures

✅ **Fast User Experience**
- API reads from KV (<10ms response)
- Users see content immediately (mix of pending/processed)
- Newest articles processed first

## Deployment

See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for step-by-step deployment instructions.

Quick start:
```bash
# Deploy producer
wrangler deploy --config wrangler-news-updater.toml
wrangler secret put NEWSDATA_API_KEY --config wrangler-news-updater.toml

# Deploy consumer
wrangler deploy --config wrangler-news-processor.toml

# Deploy API
wrangler deploy
```

## Monitoring

### Producer Logs
```bash
wrangler tail --config wrangler-news-updater.toml
```

Look for:
- "Queued X articles for AI processing"
- "Phase 3: Updating KV (2 writes)..."

### Consumer Logs
```bash
wrangler tail --config wrangler-news-processor.toml
```

Look for:
- "Processing 5 articles this run..."
- "Processed: 5 articles"
- "Remaining: X articles"

### Check Article Status
```bash
wrangler kv:key get BTC_ANALYZED_NEWS \
  --binding CRYPTO_NEWS_CACHE \
  --config wrangler-news-updater.toml | \
  jq '.articles[0] | {title, needsSentiment, needsSummary, sentiment}'
```

## Configuration

### Adjust Processing Speed

**Producer frequency** (edit `wrangler-news-updater.toml`):
```toml
crons = ["0 * * * *"]    # Every hour (default, may exceed API credits)
crons = ["0 */2 * * *"]  # Every 2 hours (recommended for free tier)
```

**Consumer frequency** (edit `wrangler-news-processor.toml`):
```toml
crons = ["*/10 * * * *"]  # Every 10 minutes (default)
crons = ["*/5 * * * *"]   # Every 5 minutes (faster)
```

**Batch size** (edit `news-processor-cron.js`):
```javascript
const MAX_ARTICLES_PER_RUN = 5;   # Default
const MAX_ARTICLES_PER_RUN = 10;  # Faster (30 SR - still safe)
```

## Cost Analysis

### FREE Tier Usage

**NewsData.io API:**
- Hourly: 264 credits/day ⚠️ (exceeds 200 limit)
- Every 2 hours: 132 credits/day ✅ (within limit)

**Cloudflare:**
- KV Writes: 768/day (under 1000 limit) ✅
- Subrequests: < 50 per run ✅
- Cron triggers: Unlimited ✅

**Total Cost: $0/month**

## Troubleshooting

### Articles Stuck with Flags

Check `summaryError` field:
```bash
wrangler kv:key get BTC_ANALYZED_NEWS \
  --binding CRYPTO_NEWS_CACHE \
  --config wrangler-news-updater.toml | \
  jq '.articles[] | select(.needsSummary == true) | {title, summaryError, contentTimeout}'
```

### Too Many Pending Articles

- Check consumer is running: `wrangler tail --config wrangler-news-processor.toml`
- Increase batch size or frequency
- Check for errors in logs

### Max Retries Reached

Articles with `contentTimeout: 5`:
```bash
wrangler kv:key get BTC_ANALYZED_NEWS \
  --binding CRYPTO_NEWS_CACHE \
  --config wrangler-news-updater.toml | \
  jq '.articles[] | select(.contentTimeout >= 5) | {title, link, summaryError}'
```

These articles failed 5 times and stopped retrying.

## Further Documentation

- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - Deployment instructions
- [KV_DEPLOYMENT_GUIDE.md](./KV_DEPLOYMENT_GUIDE.md) - Detailed KV architecture guide
- [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md) - Visual diagrams
- [IMPLEMENTATION_SUMMARY_KV.md](./IMPLEMENTATION_SUMMARY_KV.md) - Technical details
