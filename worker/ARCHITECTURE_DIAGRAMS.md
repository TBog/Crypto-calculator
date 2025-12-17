# Architecture Diagrams

## KV-Based "Todo List" Architecture (Current - Free Tier Compatible)

```
┌─────────────────────────────────────────────────────────────────┐
│           Scheduled Worker (news-updater-cron.js)               │
│                  Runs: Every Hour (Cron Job)                    │
│                  Role: PRODUCER                                  │
│                                                                  │
│  Stage 1: Aggregation (Pagination Loop)                        │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. Fetch page 1 from NewsData.io         │                  │
│  │ 2. Get nextPage token                     │                  │
│  │ 3. Fetch page 2, 3, 4...                 │                  │
│  │ 4. Continue until early-exit triggered   │                  │
│  │ 5. Deduplicate against existing data     │                  │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 2: Mark Articles for Processing                          │
│  ┌──────────────────────────────────────────┐                  │
│  │ For each article:                        │                  │
│  │   - Set needsSentiment = true            │                  │
│  │   - Set needsSummary = true              │                  │
│  │   - Add queuedAt timestamp               │                  │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 3: Store in KV (2 writes)                                │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. Write articles with processing flags  │                  │
│  │ 2. Update ID index                       │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                  │
│  Subrequests: ~11 (NewsData.io API calls only)                │
│  ✅ Well within 50 subrequest limit                            │
│  ✅ Works on FREE tier (no Queues needed)                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Cloudflare KV (Edge Storage)                  │
│                        "Todo List"                              │
│                                                                  │
│  Key: BTC_ANALYZED_NEWS                                        │
│  Value: {                                                       │
│    articles: [                                                  │
│      {                                                          │
│        ...articleData,                                          │
│        needsSentiment: true,      // Processing flag           │
│        needsSummary: true,        // Processing flag           │
│      },                                                         │
│      ...                                                        │
│    ],                                                           │
│    totalArticles: number,                                       │
│    sentimentCounts: {...}                                       │
│  }                                                              │
│                                                                  │
│  - Free tier compatible                                         │
│  - Acts as makeshift queue                                      │
│  - Updated incrementally by processor                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│         Processing Worker (news-processor-cron.js)              │
│              Runs: Every 10 Minutes (Cron Job)                  │
│              Role: CONSUMER                                      │
│                                                                  │
│  Stage 1: Read KV & Find Pending Articles                      │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. Read all articles from KV             │                  │
│  │ 2. Filter articles with processing flags │                  │
│  │ 3. Take first 5 (newest first)           │                  │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 2: Process Articles (Loop)                              │
│  ┌──────────────────────────────────────────┐                  │
│  │ For each of 5 articles:                  │                  │
│  │   1. If needsSentiment:                  │                  │
│  │      - env.AI.run(sentiment)  [1 SR]     │                  │
│  │      - Set needsSentiment = false        │                  │
│  │   2. If needsSummary:                    │                  │
│  │      - fetch(article.link)    [1 SR]     │                  │
│  │      - env.AI.run(summary)    [1 SR]     │                  │
│  │      - Set needsSummary = false          │                  │
│  │   3. Update article in KV     [1 KV write]│                  │
│  │                                            │                  │
│  │ Max: 5 × 3 = 15 subrequests              │                  │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 3: Incremental KV Updates                               │
│  ┌──────────────────────────────────────────┐                  │
│  │ After each article:                      │                  │
│  │   1. Update article in array             │                  │
│  │   2. Recalculate sentiment counts        │                  │
│  │   3. Write to KV                         │                  │
│  │                                            │                  │
│  │ Benefit: If error occurs, progress saved │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                  │
│  Subrequests per run: ~15 (5 articles × 3)                    │
│  ✅ Well within 50 subrequest limit                            │
│  ✅ Works on FREE tier                                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Cloudflare KV (Updated)                       │
│                                                                  │
│  Articles now have:                                             │
│  - sentiment: 'positive'/'negative'/'neutral'                  │
│  - needsSentiment: false (completed)                           │
│  - needsSummary: false (completed)                             │
│  - aiSummary: "..." (if successful)                            │
│  - processedAt: timestamp                                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                          User Request                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              Cloudflare Worker (index.js) - API Endpoint        │
│                                                                  │
│  1. Read from KV (CRYPTO_NEWS_CACHE.get)                       │
│  2. Return articles (some may still have flags)                │
│                                                                  │
│  Response Time: <10ms (KV read only)                           │
│  No external API calls                                          │
│  No waiting for analysis                                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Response to User                           │
│                                                                  │
│  - 100+ articles (mix of pending and processed)                │
│  - Pending articles have needsSentiment/needsSummary flags     │
│  - Processed articles have actual sentiment + AI summaries     │
│  - Fresh timestamp (when producer last ran)                    │
│  - Ultra-fast (<10ms)                                          │
└─────────────────────────────────────────────────────────────────┘

Benefits:
✅ Solves "Too many subrequests" error
✅ Works on FREE tier (no Queues needed - uses KV)
✅ Incremental processing (5 articles every 10 minutes)
✅ Resilient (progress saved after each article)
✅ Scales to unlimited articles (processed over time)
✅ Ultra-fast API response (<10ms)
```

See [KV_DEPLOYMENT_GUIDE.md](./KV_DEPLOYMENT_GUIDE.md) for deployment instructions.
