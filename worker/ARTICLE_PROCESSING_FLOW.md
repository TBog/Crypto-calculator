# Article Processing Flow Documentation

## Overview

This document explains the complete flow of how Bitcoin news articles are fetched, stored, and processed in the Crypto Calculator system. The system uses a queue-based architecture with conflict-free operations to ensure all articles are eventually processed, even when many articles are added at once.

## System Architecture

The system consists of three main components:

1. **Worker-News-Updater** (Cron: Hourly)
   - Fetches new Bitcoin articles from news APIs
   - Adds new article IDs to the pending additions log
   - Trims processed articles from the additions log
   - Stores article data in KV storage

2. **Worker-News-Processor** (Cron: Every Minute)
   - Loads articles from the pending queue
   - Processes articles (fetch content, generate AI summaries)
   - Manages the main processing queue
   - Merges new additions from the updater

3. **Cloudflare KV Storage**
   - Stores article data and processing state
   - Provides fast access to articles
   - Maintains processing queues and checkpoints

## KV Storage Keys

### Article Storage
- **`article:<id>`**: Individual article data (title, link, date, sentiment, summary, processing flags)
- **`BTC_ID_INDEX`**: Array of all article IDs (newest first, used for deduplication)
- **`BTC_ANALYZED_NEWS`**: Legacy key (deprecated, kept for compatibility)

### Queue System (Priority Processing)
- **`BTC_PENDING_QUEUE`**: Main processing queue managed by processor
  - Contains article IDs that need processing
  - Processor loads from front, processes, then removes/reorders
  - Articles stay in queue through all processing phases

- **`BTC_PENDING_ADDITIONS`**: Append-only log managed by both workers
  - Updater appends new article IDs
  - Updater trims processed articles based on checkpoint
  - Processor reads and merges new additions

- **`BTC_ADDITIONS_CHECKPOINT`**: Article ID checkpoint managed by processor
  - Stores the last article ID that was merged into main queue
  - Allows updater to safely trim processed articles
  - Prevents duplicate processing across runs

### Deprecated Keys
- **`BTC_LAST_PROCESSED_ID`**: Old sequential processing checkpoint (no longer used)

## Complete Processing Flow

### Phase 1: Article Discovery (Worker-News-Updater - Hourly)

```
┌─────────────────────────────────────────────────────────────┐
│                    UPDATER WORKER (Hourly)                  │
└─────────────────────────────────────────────────────────────┘
         │
         ├──[1]─► Read BTC_ID_INDEX from KV
         │        (Get list of known article IDs for deduplication)
         │
         ├──[2]─► Fetch articles from News API
         │        • Paginate through results
         │        • Early exit when hitting known article
         │        • Normalize article format
         │
         ├──[3]─► Filter new articles
         │        • Check against known IDs
         │        • Mark as needing sentiment & summary
         │
         ├──[4]─► Store new articles
         │        • Write to individual article:<id> keys
         │        • Update BTC_ID_INDEX with new IDs
         │
         └──[5]─► Update pending additions log
                  ├─► Read BTC_PENDING_ADDITIONS
                  ├─► Read BTC_ADDITIONS_CHECKPOINT
                  ├─► Trim processed articles (up to checkpoint)
                  ├─► Append new article IDs
                  └─► Write back to BTC_PENDING_ADDITIONS
```

#### Step-by-Step: Updater Worker

**Step 1: Load Known Article IDs**
```javascript
const knownIds = new Set();
const idIndexData = await kv.get('BTC_ID_INDEX', { type: 'json' });
if (idIndexData) {
  knownIds = new Set(idIndexData);
}
```

**Step 2: Fetch New Articles**
```javascript
// Example: Fetching from NewsData.io
const response = await fetch(`https://newsdata.io/api/1/news?apikey=...&q=bitcoin`);
const articles = response.results;

// Check each article
for (const article of articles) {
  const id = getArticleId(article);
  
  if (knownIds.has(id)) {
    // Early exit: Found known article, stop fetching more pages
    break;
  }
  
  // New article found
  newArticles.push(normalizeArticle(article));
  knownIds.add(id);
}
```

**Step 3: Store New Articles**
```javascript
// Store each article individually
for (const article of newArticles) {
  await kv.put(`article:${article.id}`, JSON.stringify(article));
}

// Update ID index
const allIds = [newArticleIds, ...existingIds].slice(0, MAX_STORED_ARTICLES);
await kv.put('BTC_ID_INDEX', JSON.stringify(allIds));
```

**Step 4: Update Pending Additions with Trimming**
```javascript
// Read existing additions log
let pendingAdditions = await kv.get('BTC_PENDING_ADDITIONS', { type: 'json' }) || [];

// Trim processed articles based on checkpoint
const checkpoint = await kv.get('BTC_ADDITIONS_CHECKPOINT');
if (checkpoint) {
  const checkpointIndex = pendingAdditions.indexOf(checkpoint);
  if (checkpointIndex !== -1) {
    // Remove all articles up to and including checkpoint
    pendingAdditions = pendingAdditions.slice(checkpointIndex + 1);
    console.log(`Trimmed ${checkpointIndex + 1} processed articles`);
  }
}

// Append new articles
pendingAdditions.push(...newArticleIds);

// Save updated additions log
await kv.put('BTC_PENDING_ADDITIONS', JSON.stringify(pendingAdditions));
```

### Phase 2: Article Processing (Worker-News-Processor - Every Minute)

```
┌─────────────────────────────────────────────────────────────┐
│                  PROCESSOR WORKER (Every Minute)            │
└─────────────────────────────────────────────────────────────┘
         │
         ├──[1]─► Read BTC_PENDING_QUEUE from KV
         │        (Get current processing queue)
         │
         ├──[2]─► Merge new additions
         │        ├─► Read BTC_PENDING_ADDITIONS
         │        ├─► Read BTC_ADDITIONS_CHECKPOINT
         │        ├─► Find articles after checkpoint ID
         │        ├─► Append to pending queue
         │        └─► Update checkpoint to last article ID
         │
         ├──[3]─► Load articles from queue
         │        • Take first MAX_ARTICLES_PER_RUN (default: 5)
         │        • Load full article data from KV
         │
         ├──[4]─► Process each article
         │        ├─► Fetch webpage content
         │        ├─► Extract main article text
         │        ├─► Generate AI summary
         │        ├─► Analyze sentiment (if needed)
         │        └─► Update article in KV
         │
         └──[5]─► Update queue based on results
                  ├─► Fully processed → Remove from queue
                  ├─► Timeout/error → Move to end for retry
                  ├─► Partial → Keep in queue for next phase
                  └─► Write updated queue to KV
```

#### Step-by-Step: Processor Worker

**Step 1: Load Current Queue**
```javascript
let pendingQueue = await kv.get('BTC_PENDING_QUEUE', { type: 'json' }) || [];
```

**Step 2: Merge New Additions**
```javascript
const additionsData = await kv.get('BTC_PENDING_ADDITIONS', { type: 'json' });
const checkpointArticleId = await kv.get('BTC_ADDITIONS_CHECKPOINT');

// Find where to start based on checkpoint
let startIndex = 0;
if (checkpointArticleId) {
  const checkpointIndex = additionsData.indexOf(checkpointArticleId);
  if (checkpointIndex !== -1) {
    startIndex = checkpointIndex + 1; // Start AFTER checkpoint
  }
}

// Merge new additions
const newAdditions = additionsData.slice(startIndex);
pendingQueue.push(...newAdditions);

// Update checkpoint to last article ID
const lastArticleId = additionsData[additionsData.length - 1];
await kv.put('BTC_ADDITIONS_CHECKPOINT', lastArticleId);
```

**Step 3: Load Articles**
```javascript
const idsToLoad = pendingQueue.slice(0, MAX_ARTICLES_PER_RUN);
const articles = await Promise.all(
  idsToLoad.map(id => kv.get(`article:${id}`, { type: 'json' }))
);
```

**Step 4: Process Articles**
```javascript
for (const article of articles) {
  if (!article.summary && article.needsSummary) {
    // Fetch webpage content
    const content = await fetchArticleContent(article.link);
    
    // Generate AI summary
    const summary = await generateSummary(content, env.AI);
    
    // Update article
    article.summary = summary;
    article.needsSummary = false;
    
    await kv.put(`article:${article.id}`, JSON.stringify(article));
  }
}
```

**Step 5: Update Queue**
```javascript
const updatedQueue = [];

for (const id of idsToLoad) {
  const article = articles.find(a => a.id === id);
  
  if (article.needsSummary || article.needsSentiment || article.contentTimeout) {
    // Still needs processing
    if (article.contentTimeout >= MAX_CONTENT_FETCH_ATTEMPTS) {
      // Failed too many times, move to end for later retry
      updatedQueue.push(id);
    } else {
      // Keep in queue for next run
      updatedQueue.unshift(id);
    }
  }
  // Else: fully processed, don't add back to queue (removed)
}

// Add remaining articles from queue
updatedQueue.push(...pendingQueue.slice(idsToLoad.length));

await kv.put('BTC_PENDING_QUEUE', JSON.stringify(updatedQueue));
```

## Conflict-Free Queue Design

### Problem: Race Conditions with JSON Storage

KV stores data as JSON strings. Both updater and processor need to add articles to the queue, but there's a race condition:

```
Time  Updater                    Processor
----- -------------------------- --------------------------
T0    Read queue: [A, B, C]      Read queue: [A, B, C]
T1    Append: [A, B, C, D, E]    Process A, remove: [B, C]
T2    Write: [A, B, C, D, E]     Write: [B, C]
T3    ❌ Lost D and E!           ✅ Written
```

### Solution: Separate Additions Log with ID-Based Checkpoint

Instead of both workers modifying the same queue, we use:

1. **Separate Keys**: Updater writes to `BTC_PENDING_ADDITIONS`, processor writes to `BTC_PENDING_QUEUE`
2. **ID-Based Checkpoint**: Processor tracks last processed article ID (not index)
3. **Safe Trimming**: Updater can trim up to checkpoint ID without conflicts

```
Time  Updater                           Processor
----- --------------------------------- ----------------------------------
T0    Read additions: [A, B, C]         Read additions: [A, B, C]
      Read checkpoint: null             Read queue: []
                                        
T1    Trim: nothing to trim             Merge [A, B, C] to queue
      Append: [A, B, C, D, E]           Update checkpoint: C
      Write additions: [A,B,C,D,E]      Process A, remove from queue
                                        Write queue: [B, C]
                                        
T2    Read additions: [A,B,C,D,E]       Read additions: [A,B,C,D,E]
      Read checkpoint: C                Read checkpoint: C
      Trim: remove [A,B,C]              Find index of C: position 2
      Append: [D,E,F,G]                 Merge [D, E] (after C)
      Write additions: [D,E,F,G]        Update checkpoint: E
                                        
✅ No conflicts! Both workers succeed.
```

### Key Properties

1. **Updater Operations**:
   - Reads additions log
   - Reads checkpoint (article ID)
   - Trims processed articles (up to checkpoint)
   - Appends new article IDs
   - Writes additions log
   - **Never touches**: Queue or checkpoint (writing)

2. **Processor Operations**:
   - Reads additions log
   - Reads checkpoint (article ID)
   - Finds new articles after checkpoint
   - Merges to main queue
   - Updates checkpoint to last article ID
   - Processes and updates main queue
   - **Never touches**: Additions log (writing)

3. **Why ID-Based Checkpoint?**:
   - Article IDs are stable (never change)
   - When updater trims the additions log, indices shift
   - An index-based checkpoint would point to the wrong article after trimming
   - An ID-based checkpoint always points to the correct article

## Processing Phases

Articles go through multiple processing phases:

### Phase 1: Content Fetching
- **Flag**: `contentTimeout` (undefined or < MAX_ATTEMPTS)
- **Action**: Fetch webpage, extract main content
- **Success**: Content extracted, move to next phase
- **Failure**: Increment `contentTimeout`, move to end of queue for retry

### Phase 2: AI Summary Generation  
- **Flag**: `needsSummary = true`
- **Action**: Send content to AI model for summarization
- **Success**: Summary generated, clear flag
- **Failure**: Set `summaryError`, may retry based on error type

### Phase 3: Sentiment Analysis
- **Flag**: `needsSentiment = true`
- **Action**: Analyze article sentiment with AI
- **Success**: Sentiment set, clear flag
- **Note**: Some providers (APITube) include sentiment, skip this phase

### Completion
- When all flags are cleared (`needsSummary = false`, `needsSentiment = false`, no `contentTimeout`)
- Article is removed from processing queue
- Available to API consumers

## Performance Characteristics

### Before Queue System (Sequential Processing)
- **Problem**: 480 existing + 20 new articles
- **Behavior**: Process articles 0-4, then 5-9, then 10-14...
- **Time to New Articles**: 480 articles ÷ 5 per run = 96 runs = 96 minutes
- **Result**: New articles unreachable for 1.5+ hours ❌

### After Queue System (Priority Processing)
- **Behavior**: New articles added to queue immediately
- **Processing**: Queue processed from front (FIFO)
- **Time to New Articles**: Immediate (next processor run)
- **Result**: 20 new articles processed in ~7 minutes ✅

### KV Operations per Cycle

**Updater (Hourly)**:
- Reads: 2-3 (ID index, additions, checkpoint)
- Writes: 3 + N (ID index, additions, N new articles)

**Processor (Every Minute)**:
- Reads: 3 + M (queue, additions, checkpoint, M articles to process)
- Writes: 2 + M (queue, checkpoint, M updated articles)

Where:
- N = number of new articles found (typically 5-15 per hour)
- M = MAX_ARTICLES_PER_RUN (default: 5)

## Error Handling

### Content Fetch Failures
```javascript
if (fetchFailed) {
  article.contentTimeout = (article.contentTimeout || 0) + 1;
  
  if (article.contentTimeout >= MAX_CONTENT_FETCH_ATTEMPTS) {
    // Too many failures, move to end for later
    queueToEnd.push(article.id);
  } else {
    // Retry soon, keep near front
    queueToRetry.push(article.id);
  }
}
```

### AI Generation Errors
```javascript
try {
  summary = await generateSummary(content, env.AI);
} catch (error) {
  article.summaryError = `error: ${error.message} (attempt ${attempts}/${MAX_ATTEMPTS})`;
  // May retry based on error type
}
```

### Queue Corruption Recovery
- If queue becomes invalid, processor starts fresh
- Additions log provides source of truth
- Checkpoint prevents duplicate processing

## Monitoring & Observability

### Key Metrics

**Updater**:
- New articles found per run
- Articles trimmed from additions log
- API credits used
- Total articles in additions log

**Processor**:
- Articles loaded per run
- Articles processed per run
- Articles removed from queue
- Articles moved to end for retry
- Queue length remaining

### Log Examples

```
Updater:
✓ Fetched 12 new articles
✓ Trimmed 8 processed articles from additions log (checkpoint: article-123)
✓ Added 12 articles to pending additions staging area (total: 15, trimmed 8)

Processor:
Merged 12 new articles from additions (checkpoint updated to article ID: article-134)
Loaded: 5 articles
Processed: 5 articles
Removed from queue: 3 articles
Moved to end for retry: 0 articles
Queue length: 7 articles remaining
```

## Configuration

### Environment Variables

```javascript
// Updater
MAX_STORED_ARTICLES = 500  // Maximum articles to keep in KV
MAX_PAGES = 15             // Maximum API pages to fetch
ID_INDEX_TTL = 2592000     // 30 days in seconds

// Processor
MAX_ARTICLES_PER_RUN = 5           // Articles to load per run
MAX_CONTENT_CHARS = 10240          // Max content size (10KB)
MAX_CONTENT_FETCH_ATTEMPTS = 5     // Max retries for fetch
```

### Tuning Recommendations

**For High-Volume News Periods** (>20 articles/hour):
- Increase `MAX_ARTICLES_PER_RUN` to 8-10
- Consider running processor more frequently (every 30 seconds)

**For Low-Volume Periods** (<5 articles/hour):
- Decrease `MAX_ARTICLES_PER_RUN` to 3
- Keep processor at 1-minute intervals

**For Large Backlogs**:
- Temporarily increase `MAX_ARTICLES_PER_RUN` to 15-20
- Monitor KV read/write quotas
- Return to normal after backlog cleared

## Testing

### Unit Tests with Mock KV

```javascript
const mockKV = {
  storage: new Map(),
  async get(key, options) {
    const value = this.storage.get(key);
    return options?.type === 'json' ? JSON.parse(value) : value;
  },
  async put(key, value) {
    this.storage.set(key, value);
  }
};

// Test processor with mock
const result = await processArticlesBatch(mockKV, env, config);
expect(result.processedCount).toBe(5);
```

### Integration Tests

- Simulate updater adding 20 articles
- Run processor multiple times
- Verify all articles eventually processed
- Verify checkpoint advances correctly
- Verify trimming works as expected

### Race Condition Tests

- Simulate concurrent updater and processor runs
- Verify no articles lost
- Verify checkpoint remains valid
- Verify trimming doesn't affect unprocessed articles

## Common Issues & Solutions

### Issue: Articles Not Processing
**Symptoms**: Queue length stays constant, no articles processed
**Causes**:
1. All articles failing content fetch
2. AI service unavailable
3. Articles missing required fields

**Solution**:
1. Check `contentTimeout` values
2. Verify AI service connectivity
3. Review article data structure

### Issue: Duplicate Processing
**Symptoms**: Same article processed multiple times
**Causes**:
1. Checkpoint not updating
2. Queue corruption

**Solution**:
1. Verify checkpoint is being written
2. Check KV write permissions
3. Review processor logs for errors

### Issue: Growing Additions Log
**Symptoms**: Additions log size increasing indefinitely
**Causes**:
1. Checkpoint not being updated
2. Updater trimming logic not running

**Solution**:
1. Verify processor updates checkpoint
2. Verify updater reads checkpoint
3. Check trimming logic execution

## Best Practices

### For Updater
1. Always trim before appending
2. Log trimmed article count
3. Monitor additions log size
4. Use early-exit for efficiency

### For Processor
1. Update checkpoint after every merge
2. Handle missing checkpoint gracefully
3. Batch article reads for efficiency
4. Remove fully processed articles promptly

### For Both
1. Use consistent article ID generation
2. Set appropriate TTLs on KV keys
3. Log all queue operations
4. Monitor queue depths

## Future Enhancements

### Possible Improvements
1. **Priority Levels**: High-priority articles processed first
2. **Batch Processing**: Process articles in larger batches for efficiency
3. **Smart Retry**: Exponential backoff for failed fetches
4. **Partial Checkpoints**: Multiple checkpoints for different processing phases
5. **Metrics Dashboard**: Real-time queue depth and processing rate visualization

### Scalability Considerations
- Current design handles 50+ articles/hour efficiently
- Queue-based approach scales to 500+ articles/hour
- For 1000+ articles/hour, consider:
  - Dedicated queue service (Cloudflare Queues)
  - Multiple processor workers
  - Sharded queue by article source
