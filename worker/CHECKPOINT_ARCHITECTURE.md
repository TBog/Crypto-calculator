# Bitcoin News Processing - Checkpoint-Based Architecture

This document describes the **checkpoint-based architecture** for Bitcoin news aggregation and AI analysis. This architecture prevents race conditions between workers and ensures no articles are lost during concurrent execution.

## Architecture Overview

The system uses **three Cloudflare Workers** with a checkpoint-based processing model:

1. **Updater** (`worker-news-updater`) - Fetches articles and adds to pending list
2. **Processor** (`worker-news-processor`) - Processes articles one at a time with checkpoint tracking
3. **API** (`worker-api`) - Serves enriched articles to users

### Why Checkpoint-Based Architecture?

**Problems Solved:**
- ❌ Race conditions when updater and processor write to same articles
- ❌ Lost changes when two workers update the same KV key simultaneously
- ❌ Articles lost when more than MAX_ARTICLES_PER_RUN added at once
- ❌ No way to recover from crashes during processing

**Solutions:**
- ✅ Updater writes only to pending list (BTC_PENDING_LIST)
- ✅ Processor writes to individual articles and checkpoint (BTC_CHECKPOINT)
- ✅ Checkpoint tracks processing state and enables crash recovery
- ✅ Try-later list for failed articles with automatic retry
- ✅ Conflict-free operations - no two workers write to same key

## Data Flow

```
┌─────────────────────────────────────────┐
│  Updater Worker                         │
│  (worker-news-updater)                  │
│  Runs: Every hour                       │
│                                         │
│  1. Fetch articles from news API       │
│  2. Mark with processing flags         │
│  3. Read checkpoint (processed IDs)    │
│  4. Add NEW articles to pending list   │
│  5. Trim processed articles            │
│  WRITES: BTC_PENDING_LIST only         │
└─────────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  BTC_PENDING_LIST │
         │                   │
         │  [{id, article,   │
         │    addedAt}]      │
         └──────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  Processor Worker                       │
│  (worker-news-processor)                │
│  Runs: Every minute                     │
│                                         │
│  1. Read checkpoint                    │
│  2. Check if previous article done     │
│  3. Get next article from:             │
│     - Current (if in progress)         │
│     - Pending list (if available)      │
│     - Try-later list (if pending empty)│
│  4. Update checkpoint with article     │
│  5. Process article (one phase)        │
│  6. Write article to article:<id>      │
│  7. Update ID index                    │
│  8. Update checkpoint (success/fail)   │
│  WRITES: article:<id>, BTC_ID_INDEX,   │
│          BTC_CHECKPOINT                 │
└─────────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  BTC_CHECKPOINT   │
         │                   │
         │  {                │
         │   currentArticleId│
         │   currentArticle  │
         │   processedIds[]  │
         │   tryLater[]      │
         │  }                │
         └──────────────────┘
```

## KV Storage Structure

### BTC_PENDING_LIST
Array of articles waiting to be processed (updater writes only):
```json
[
  {
    "id": "article-123",
    "article": { /* full article data */ },
    "addedAt": 1704067200000
  },
  ...
]
```

### BTC_CHECKPOINT
Processing state and recovery information (processor writes only):
```json
{
  "currentArticleId": "article-123",
  "currentArticle": { /* article being processed */ },
  "processedIds": ["article-1", "article-2", ...],
  "tryLater": [
    {
      "id": "article-failed",
      "article": { /* failed article */ },
      "failedAt": 1704067200000,
      "reason": "max_retries_reached"
    }
  ],
  "lastUpdate": 1704067200000
}
```

### article:<id>
Individual article storage (processor writes only):
```json
{
  "id": "article-123",
  "title": "Bitcoin news...",
  "needsSentiment": false,
  "needsSummary": false,
  "sentiment": "positive",
  "aiSummary": "Summary text...",
  ...
}
```

### BTC_ID_INDEX
Ordered list of article IDs (processor writes only):
```json
["article-123", "article-122", "article-121", ...]
```

## Processing Flow

### Updater Workflow

1. **Fetch Articles**: Get new articles from news API
2. **Read Pending List**: Get current pending articles (1 read)
3. **Read Checkpoint**: Get list of processed article IDs (1 read)
4. **Filter New**: Only keep articles not in pending or processed
5. **Add to Pending**: Prepend new articles to pending list
6. **Trim List**: Remove articles that checkpoint shows as processed
7. **Limit Size**: Trim to MAX_PENDING_LIST_SIZE (default: 500)
8. **Write**: Single KV write to BTC_PENDING_LIST (1 write)

**KV Operations per Run:**
- **Reads**: 2 (BTC_PENDING_LIST + BTC_CHECKPOINT)
- **Writes**: 1 (BTC_PENDING_LIST)
- **Total**: 3 operations

**Key Points:**
- Only writes to BTC_PENDING_LIST
- Never modifies articles or checkpoint
- Automatically trims based on checkpoint
- Pending list size limited to prevent unbounded growth
- No race conditions possible

### Processor Workflow

1. **Read Checkpoint**: Determine current state (1 read)
   - `currentArticleId` = article in progress (if any)
   - `processedIds` = completed articles
   - `tryLater` = failed articles to retry

2. **Check Previous Article**: If article in checkpoint
   - If fully processed → mark complete, clear checkpoint
   - If still needs work → continue processing

3. **Get Next Article**: Priority order (0-1 reads)
   - Continue `currentArticle` if still processing (0 reads)
   - Get first unprocessed from BTC_PENDING_LIST (1 read if needed)
   - Get first from `tryLater` list if pending empty (0 reads)

4. **Update Checkpoint**: Before processing (1 write)
   - Set `currentArticleId` and `currentArticle`
   - Enables crash recovery

5. **Process Article**: Execute one processing phase
   - Phase 0: Sentiment analysis
   - Phase 1: Content scraping  
   - Phase 2: AI summary generation

6. **Write Article**: Save progress to article:<id> (1 write)

7. **Update ID Index**: Add article to BTC_ID_INDEX if new (0-1 reads, 0-1 writes)
   - Read current index (1 read if article is new)
   - Write updated index (1 write if article is new)
   - Delete old articles if DELETE_OLD_ARTICLES enabled (0-N deletes)

8. **Update Checkpoint**: After processing (1 write)
   - Success → add to `processedIds`, clear current
   - Failure (max retries) → mark as processed with empty values (1 additional write)
   - Partial → keep in `currentArticle`

**KV Operations per Article (typical case - new article):**
- **Reads**: 3 (BTC_CHECKPOINT + BTC_PENDING_LIST + BTC_ID_INDEX)
- **Writes**: 4 (BTC_CHECKPOINT before + article:<id> + BTC_ID_INDEX + BTC_CHECKPOINT after)
- **Total**: 7 operations per article

**KV Operations per Article (continuing multi-phase article):**
- **Reads**: 2 (BTC_CHECKPOINT + article already in checkpoint = no pending read)
- **Writes**: 3 (BTC_CHECKPOINT before + article:<id> + BTC_CHECKPOINT after)
- **Total**: 5 operations per article

**KV Operations per Article (max retries reached):**
- **Reads**: 3 (same as typical case)
- **Writes**: 5 (BTC_CHECKPOINT before + article:<id> twice + BTC_ID_INDEX + BTC_CHECKPOINT after)
- **Total**: 8 operations per article

**Optional DELETE_OLD_ARTICLES:**
- If enabled and articles exceed MAX_STORED_ARTICLES:
  - Additional deletes: N (where N = number of articles over limit)

**Key Points:**
- Processes ONE article per run
- Checkpoint enables crash recovery
- Failed articles at max retries marked as processed (not infinite retry)
- processedIds trimmed on every run to prevent unbounded growth
- No race conditions with updater

## Benefits

### Conflict-Free Operations
✅ **Separate Write Domains**
- Updater: Only writes to BTC_PENDING_LIST
- Processor: Only writes to article:<id>, BTC_ID_INDEX, BTC_CHECKPOINT
- **Result**: No two workers write to same key = zero race conditions

### Crash Recovery
✅ **Checkpoint System**
- Current article saved in checkpoint before processing
- If worker crashes, next run resumes from checkpoint
- No duplicate processing
- No lost work

### Unlimited Capacity
✅ **Pending List**
- Can handle any number of new articles
- Automatically trimmed of processed articles
- Size limited to MAX_PENDING_LIST_SIZE (default: 500) to prevent unbounded growth
- No articles lost when >5 added at once

### Automatic Retry
✅ **Try-Later Queue**
- Failed articles moved to try-later list
- Automatically retry when pending list empty
- Articles at max retries (MAX_CONTENT_FETCH_ATTEMPTS) marked as processed with empty values
- Prevents infinite retry loops

### Memory Efficiency
✅ **Bounded Data Structures**
- processedIds automatically trimmed each run to only include articles in current index
- Pending list limited to MAX_PENDING_LIST_SIZE
- Try-later list self-cleaning (articles at max retries removed)
- No unbounded growth

### Configurable Cleanup
✅ **DELETE_OLD_ARTICLES Option**
- When enabled: Old articles deleted when removed from index
- When disabled (default): Articles remain until TTL expires
- Balances KV space usage vs delete operation costs
- Documented with Free Tier considerations
- Updater writes: BTC_PENDING_LIST
- Processor writes: article:<id>, BTC_ID_INDEX, BTC_CHECKPOINT
- No overlapping writes = no race conditions

✅ **Atomic Operations**
- Each KV write is atomic
- Checkpoint provides transaction-like semantics
- Recovery possible after any crash

### Crash Recovery
✅ **Checkpoint State**
- If processor crashes, checkpoint shows last article
- Next run resumes from checkpoint
- No lost work or duplicate processing

✅ **Try-Later Queue**
- Failed articles automatically retry
- Max retries prevents infinite loops
- Diagnostic information preserved

### Scalability
✅ **Efficient Resource Usage**
- One article at a time = predictable resource usage
- Phase-based processing spreads work across runs
- processedIds uses Set for O(1) lookup performance
- Helper functions (articleNeedsProcessing, articleIsComplete) reduce code duplication

## Configuration Options

### Core Settings

**MAX_STORED_ARTICLES** (default: 500)
- Maximum articles kept in BTC_ID_INDEX
- Older articles removed when limit exceeded
- Should be increased gradually during initial deployment
- Conservative default prevents spike in requests/neuron usage

**MAX_PENDING_LIST_SIZE** (default: 500)
- Maximum articles in pending list
- Prevents unbounded growth if processor falls behind
- Same as MAX_STORED_ARTICLES by default
- Important during initial deployment with empty KV

**MAX_CONTENT_FETCH_ATTEMPTS** (default: 5)
- Maximum retries for content fetching
- Articles reaching this limit marked as processed with empty values
- Prevents infinite retry loops
- Configurable per deployment needs

**DELETE_OLD_ARTICLES** (default: false)
- When true: Delete articles when removed from index
- When false: Keep until TTL expires (30 days)
- Trade-off: KV space vs delete operations
- Free Tier: Deletes count separately from writes (1000/day limit)
- Paid Tier: All operations billed equally

**ID_INDEX_TTL** (default: 2592000 = 30 days)
- TTL for all KV entries
- Automatic cleanup after expiration
- Balances storage costs with data retention

### Initial Deployment Recommendations

When deploying with empty KV store:
1. Start with conservative MAX_STORED_ARTICLES (e.g., 50-100)
2. Gradually increase over days/weeks
3. Monitor KV operations and neuron usage
4. Prevents spike in:
   - API requests to news providers
   - Neuron consumption for AI processing
   - Worker execution time
   - KV write operations

## Environment Variables

```toml
# News Updater
MAX_STORED_ARTICLES = 500     # Max articles in ID index
MAX_PENDING_LIST_SIZE = 500   # Max articles in pending list
MAX_PAGES = 15                # Max news API pages to fetch
ID_INDEX_TTL = 2592000        # 30 days in seconds

# News Processor  
MAX_ARTICLES_PER_RUN = 1      # Always 1 in checkpoint architecture
MAX_CONTENT_CHARS = 10240     # 10KB content extraction limit
MAX_CONTENT_FETCH_ATTEMPTS = 5 # Max retries before marking as processed
DELETE_OLD_ARTICLES = false   # Delete old articles vs wait for TTL
```

### Cron Schedules

**Updater** (every hour or less frequent):
```toml
crons = ["0 * * * *"]    # Every hour
```

**Processor** (every minute for fast processing):
```toml
crons = ["* * * * *"]    # Every minute
```

## Monitoring

### Check Pending Articles
```bash
wrangler kv:key get BTC_PENDING_LIST \
  --binding CRYPTO_NEWS_CACHE | jq 'length'
```

### Check Checkpoint State
```bash
wrangler kv:key get BTC_CHECKPOINT \
  --binding CRYPTO_NEWS_CACHE | jq '{
    current: .currentArticleId,
    processed: (.processedIds | length),
    tryLater: (.tryLater | length)
  }'
```

### Check Try-Later Articles
```bash
wrangler kv:key get BTC_CHECKPOINT \
  --binding CRYPTO_NEWS_CACHE | \
  jq '.tryLater[] | {id, reason}'
```

### View Processing Progress
```bash
# Watch processor logs
wrangler tail worker-news-processor

# Look for:
# - "Processing article: <id>"
# - "✓ Article fully processed"
# - "Moving article to try-later list"
```

## Testing

### Unit Tests
Run comprehensive tests including race condition scenarios:
```bash
cd worker
npm test
```

Tests include:
- ✅ Concurrent updater/processor execution
- ✅ Checkpoint recovery after crash
- ✅ Try-later queue processing
- ✅ MAX_ARTICLES_PER_RUN = 1 and 5
- ✅ No lost articles during concurrent writes

### Integration Test
Manually test the full flow:
```bash
# 1. Clear all data
wrangler kv:key delete BTC_PENDING_LIST --binding CRYPTO_NEWS_CACHE
wrangler kv:key delete BTC_CHECKPOINT --binding CRYPTO_NEWS_CACHE
wrangler kv:key delete BTC_ID_INDEX --binding CRYPTO_NEWS_CACHE

# 2. Trigger updater
wrangler cron trigger worker-news-updater

# 3. Check pending list
wrangler kv:key get BTC_PENDING_LIST --binding CRYPTO_NEWS_CACHE | jq 'length'

# 4. Trigger processor multiple times
wrangler cron trigger worker-news-processor
wrangler cron trigger worker-news-processor
wrangler cron trigger worker-news-processor

# 5. Check checkpoint
wrangler kv:key get BTC_CHECKPOINT --binding CRYPTO_NEWS_CACHE | jq
```

## Troubleshooting

### Articles Stuck in Pending
**Symptom**: Pending list not decreasing

**Check**: Is processor running?
```bash
wrangler tail worker-news-processor
```

**Fix**: Manually trigger processor
```bash
wrangler cron trigger worker-news-processor
```

### Articles in Try-Later
**Symptom**: Articles in tryLater list

**Check**: View failed articles
```bash
wrangler kv:key get BTC_CHECKPOINT --binding CRYPTO_NEWS_CACHE | \
  jq '.tryLater[] | {id, reason, article: .article.title}'
```

**Fix**: Articles will retry when pending list is empty. Or manually remove from try-later:
```bash
# Get checkpoint
wrangler kv:key get BTC_CHECKPOINT --binding CRYPTO_NEWS_CACHE > checkpoint.json

# Edit checkpoint.json to remove articles from tryLater array

# Put back
wrangler kv:key put BTC_CHECKPOINT --binding CRYPTO_NEWS_CACHE < checkpoint.json
```

### Checkpoint Corruption
**Symptom**: Processor errors or stuck

**Fix**: Reset checkpoint
```bash
echo '{"currentArticleId":null,"currentArticle":null,"processedIds":[],"tryLater":[],"lastUpdate":null}' | \
  wrangler kv:key put BTC_CHECKPOINT --binding CRYPTO_NEWS_CACHE
```

## Migration from Old Architecture

If upgrading from the previous architecture:

1. **Deploy new code**: Both updater and processor
2. **Let processor finish**: Process remaining articles from old system
3. **Clear old data**: After all articles processed
```bash
wrangler kv:key delete BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE
```
4. **Initialize checkpoint**: Processor will auto-create on first run

Old articles in BTC_ID_INDEX and article:<id> format remain compatible.

## Performance

### Throughput
- **Updater**: Adds N articles per run (instant)
- **Processor**: Processes 1 article per run (~10-30 seconds)
- **Total**: ~60-180 articles per hour

### Latency
- **Article appears**: Immediate (in pending list)
- **Fully processed**: 3 runs (sentiment + scrape + summary) = 3 minutes
- **Failed article retry**: After pending list empty

### KV Operations

**Updater (per run):**
- **Reads**: 2 operations
  - BTC_PENDING_LIST (get current pending articles)
  - BTC_CHECKPOINT (get processed IDs for filtering)
- **Writes**: 1 operation
  - BTC_PENDING_LIST (write trimmed and updated list)
- **Total**: 3 operations per run

**Processor (per article - typical new article):**
- **Reads**: 3 operations
  - BTC_CHECKPOINT (get current state)
  - BTC_PENDING_LIST (get next article to process)
  - BTC_ID_INDEX (check if article exists in index)
- **Writes**: 4 operations
  - BTC_CHECKPOINT (update before processing)
  - article:<id> (save processed article)
  - BTC_ID_INDEX (add article to index)
  - BTC_CHECKPOINT (update after processing)
- **Total**: 7 operations per article

**Processor (continuing multi-phase article):**
- **Reads**: 2 operations (no pending list read needed)
- **Writes**: 3 operations (no ID index update needed)
- **Total**: 5 operations per article

**Processor (article at max retries):**
- **Reads**: 3 operations
- **Writes**: 5 operations (includes extra article write with empty values)
- **Total**: 8 operations per article

**Total per Hour Estimate:**
- Updater: ~3 operations/hour (runs hourly)
- Processor: ~420 operations/hour (60 runs × 7 ops average)
- **Combined**: ~423 operations/hour
- **Daily**: ~10,152 operations (well under 100K free tier limit)

**Notes:**
- If DELETE_OLD_ARTICLES enabled: Additional deletes when articles exceed MAX_STORED_ARTICLES
- Pending list limited to MAX_PENDING_LIST_SIZE (default: 500) to prevent unbounded growth
- processedIds automatically trimmed each run to prevent memory bloat

## Further Documentation

- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - Deployment instructions
- [TEST_README.md](./TEST_README.md) - Testing guide
- [README.md](./README.md) - General worker overview
