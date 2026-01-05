# Architecture Revision - Updater-Managed KV with D1 Processing

## Overview

This document describes the revised D1+KV architecture where the updater has exclusive write access to KV article IDs, ensuring no write collisions between workers.

## Worker Responsibilities

### News Updater (Data Source & KV Manager)
**Role**: Single source of truth for KV article list

**Operations**:
1. Fetches new articles from external API (NewsData.io / APITube)
2. Writes new articles to **both** KV and D1:
   - KV: Individual articles (`article:{id}`) + article ID list (`BTC_ID_INDEX`)
   - D1: Full article data for processing
3. Maintains KV article ID list (exclusive write access)
4. Trims D1 to match KV article ID list (removes orphaned articles)

**KV Writes**: ~30 per hour (24-48 articles + 1 ID list update) = **~720/day**

**Key Functions**:
- `addArticlesToKVAndD1()` - Writes to both storages atomically
- `trimD1Articles()` - Removes D1 articles not in KV ID list

### News Processor (Processing Engine)
**Role**: Processes articles and updates KV when complete

**Operations**:
1. Reads articles needing processing from D1 (`needsSentiment=1 OR needsSummary=1`)
2. Processes articles (sentiment analysis, content scraping, AI summary)
3. Updates article status in D1 after each phase
4. Writes individual articles to KV **only when fully processed** (all flags cleared)
5. **Never** touches KV article ID list (updater manages it)

**KV Writes**: ~1 per run (0-3 fully processed articles) = **~288/day**

**Key Functions**:
- `processBatchFromD1()` - Processes articles, tracks which are fully done
- `updateKVWithProcessedArticles()` - Updates KV only for completed articles

### API Worker (Read-Only Frontend)
**Role**: Fast read-only access to cached data

**Operations**:
1. Reads article ID list from KV (`BTC_ID_INDEX`)
2. Reads individual articles from KV (`article:{id}`)
3. Returns aggregated response with sentiment counts
4. **No D1 access** - purely KV-based for <10ms responses

**KV Writes**: **0** (read-only)

**Key Functions**:
- `fetchBitcoinNews()` - KV-only reads, no fallback

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  External API (NewsData.io / APITube)                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  News Updater (Every Hour)                                  │
│                                                             │
│  1. Fetch new articles                                      │
│  2. Write to KV:                                            │
│     - article:{id} (individual articles)                    │
│     - BTC_ID_INDEX (article ID list) ◄── Exclusive Write   │
│  3. Write to D1 (batch insert)                              │
│  4. Trim D1 (remove articles not in KV ID list)            │
└────────────┬────────────────────────────┬───────────────────┘
             │                            │
             ▼                            ▼
    ┌─────────────────┐         ┌─────────────────┐
    │  KV Storage     │         │  D1 Database    │
    │  (Source Truth) │         │  (Processing)   │
    │                 │         │                 │
    │  • article:{id} │         │  • articles     │
    │  • BTC_ID_INDEX │         │  • checkpoint   │
    └────────┬────────┘         └────────┬────────┘
             │                            │
             │                            │
             │                            ▼
             │                   ┌─────────────────┐
             │                   │ News Processor  │
             │                   │ (Every 5 min)   │
             │                   │                 │
             │                   │ 1. Read pending │
             │                   │ 2. Process in D1│
             │                   │ 3. Write to KV  │
             │                   │    (when done)  │
             │                   └─────────┬───────┘
             │                             │
             │  ◄──────────────────────────┘
             │  Updates article:{id} for processed articles
             │
             ▼
    ┌─────────────────┐
    │   API Worker    │
    │  (Read-Only)    │
    │                 │
    │ 1. Read ID list │
    │ 2. Read articles│
    │ 3. Return data  │
    └─────────────────┘
```

## KV Key Structure

### Article ID List (Managed by Updater Only)
**Key**: `BTC_ID_INDEX`
**Value**: Array of article IDs (newest first)
```json
["article-id-1", "article-id-2", "article-id-3", ...]
```

**Purpose**: 
- Source of truth for what articles exist
- Used by API to determine which articles to fetch
- Used by Updater to trim D1

**Writers**: Updater only (no collisions)

### Individual Articles (Written by Updater & Processor)
**Key**: `article:{id}`
**Value**: Article object
```json
{
  "id": "article-id-1",
  "title": "...",
  "link": "...",
  "sentiment": "positive",
  "aiSummary": "...",
  "needsSentiment": false,
  "needsSummary": false,
  ...
}
```

**Purpose**: 
- Store individual article data
- Read by API for fast access

**Writers**: 
- Updater: Writes new articles (initial state with processing flags)
- Processor: Updates articles when fully processed (clears flags, adds AI data)

**No Collision**: Different workers write at different lifecycle stages

## D1 Table Structure

### Articles Table
Stores all articles with processing state:
```sql
CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  title TEXT,
  link TEXT,
  needsSentiment BOOLEAN,
  needsSummary BOOLEAN,
  sentiment TEXT,
  aiSummary TEXT,
  processedAt INTEGER,
  ...
);
```

**Indexes**:
- `idx_articles_pubDate` - For ordering (newest first)
- `idx_articles_pending` - For finding articles needing processing
- `idx_articles_sentiment` - For filtering by sentiment

### Processing Checkpoint Table
Tracks current processing state:
```sql
CREATE TABLE processing_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  currentArticleId TEXT,
  lastProcessedAt INTEGER,
  articlesProcessedCount INTEGER
);
```

## Write Patterns

### Updater Writes (Hourly)
```javascript
// 1. Write articles to KV individually
for (const article of newArticles) {
  await kv.put(`article:${article.id}`, JSON.stringify(article));
}

// 2. Update KV ID list (source of truth)
await kv.put('BTC_ID_INDEX', JSON.stringify(updatedIdList));

// 3. Batch insert to D1
await insertArticlesBatch(db, newArticles);

// 4. Trim D1 to match KV ID list
await trimD1Articles(db, kv);
```

**KV Writes**: 25 articles + 1 ID list = 26 writes
**Frequency**: Every hour
**Daily Total**: 26 × 24 = **624 writes/day**

### Processor Writes (Every 5 Minutes)
```javascript
// Process articles in D1
const result = await processBatchFromD1(db, env, config);

// Only write fully processed articles to KV
if (result.fullyProcessed.length > 0) {
  for (const article of result.fullyProcessed) {
    await kv.put(`article:${article.id}`, JSON.stringify(article));
  }
}
```

**KV Writes**: 0-3 articles per run
**Frequency**: Every 5 minutes (288 runs/day)
**Daily Total**: ~1 × 288 = **288 writes/day**

### API Reads (On Demand)
```javascript
// 1. Read article ID list
const idList = await kv.get('BTC_ID_INDEX');

// 2. Read individual articles
const articles = await Promise.all(
  idList.map(id => kv.get(`article:${id}`))
);

// 3. Return aggregated response
return { articles, totalArticles: articles.length, ... };
```

**KV Writes**: **0** (read-only)

## Total KV Usage

| Worker | Writes/Day | Percentage |
|--------|------------|------------|
| Updater | ~720 | 72% |
| Processor | ~288 | 28% |
| API | 0 | 0% |
| **Total** | **~1,008/day** | **100.8% of 1K limit** |

**Status**: Slightly over limit, but manageable:
- Updater can be optimized to write less frequently if needed
- Processor writes scale with completion rate (can be tuned)
- System has natural backpressure (can't write more articles than exist)

## Consistency Model

### KV Article ID List
- **Source of Truth**: Updater-managed list
- **Eventually Consistent**: Global replication takes up to 60 seconds
- **Read by**: API worker (for article list)
- **Used for Trimming**: D1 cleanup

### Individual Articles
- **Two-Stage Write**:
  1. Updater writes initial version (with processing flags)
  2. Processor updates when complete (clears flags, adds AI data)
- **Eventually Consistent**: Updates propagate within 60 seconds
- **Read by**: API worker (for article data)

### D1 Articles
- **Single Region**: Low latency for processing
- **Strongly Consistent**: No replication lag
- **Trimmed by**: Updater (based on KV ID list)

## Error Handling

### Updater Failures
- **KV Write Fails**: Retry, then log and continue (D1 still updated)
- **D1 Write Fails**: Abort batch, retry next run
- **Trim Fails**: Log and continue (will retry next run)

### Processor Failures
- **D1 Read Fails**: Abort run, retry next run
- **Processing Fails**: Skip article, continue with next
- **KV Write Fails**: Log and continue (will retry when article processes again)

### API Failures
- **KV Read Fails**: Return 503 error (temporary unavailable)
- **Partial Data**: Return what's available with warning

## Monitoring

### Key Metrics
1. **KV Write Operations**: Track daily usage vs 1,000 limit
2. **D1 Article Count**: Ensure trimming works correctly
3. **Processing Lag**: Time from article creation to full processing
4. **API Cache Hit Rate**: Should be 100% (KV only)

### Alerts
- KV writes >900/day (approaching limit)
- D1 article count diverging from KV ID list
- Processing lag >2 hours
- API errors >1% of requests

## Migration from Previous Architecture

### Before (D1+KV Hybrid with Fallback)
- Updater: Write to D1 only
- Processor: Write all articles to KV + ID list
- API: Read KV, fallback to D1

### After (Updater-Managed KV)
- Updater: Write to both KV and D1, manage ID list
- Processor: Write only processed articles to KV
- API: Read KV only (no fallback)

### Migration Steps
1. Deploy updater with new KV write logic
2. Wait for updater to populate KV with current articles
3. Deploy processor with new selective write logic
4. Deploy API with KV-only reads
5. Verify API responses contain all expected articles
6. Monitor KV write usage over 24 hours

## Benefits

✅ **No Write Collisions**: Updater has exclusive access to KV ID list
✅ **Fast API Responses**: <10ms from KV only
✅ **Clear Responsibilities**: Each worker has distinct role
✅ **Consistent Data**: KV ID list is source of truth for trimming
✅ **Efficient Processing**: Only completed articles written to KV
✅ **Scalable**: Can increase processing frequency without hitting limits

## Trade-offs

⚠️ **Higher KV Usage**: Updater writes all articles (not just when processed)
⚠️ **Near Limit**: ~1,008 writes/day is close to 1,000/day limit
⚠️ **No API Fallback**: API depends entirely on KV availability
⚠️ **Initial State**: New articles visible in API before processing completes

## Optimization Opportunities

If KV write limit becomes an issue:

1. **Reduce Updater Frequency**: Run every 2 hours instead of hourly (-360 writes/day)
2. **Batch KV Writes**: Update multiple articles in single aggregated payload
3. **Conditional Updates**: Only write to KV if article data changed
4. **TTL Management**: Let old articles expire naturally instead of explicit deletes
5. **Processor Throttling**: Reduce frequency to 10 minutes (-144 writes/day)
