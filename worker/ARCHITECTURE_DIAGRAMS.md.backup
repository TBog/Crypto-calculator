# Architecture Diagrams

## Old Architecture (Request-Driven)

```
┌─────────────────────────────────────────────────────────────────┐
│                          User Request                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker (index.js)                 │
│                                                                  │
│  1. Check Cache (10-minute TTL)                                │
│  2. If MISS: Fetch from NewsData.io API                        │
│  3. Store in Cache                                              │
│  4. Return Response                                             │
│                                                                  │
│  Cost: 1 API credit per cache miss per user                    │
│  Response Time: 500-2000ms (external API dependency)           │
│  Articles: 10 per request (free tier limit)                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    NewsData.io API (External)                   │
│                                                                  │
│  - 200 credits/day (free tier)                                 │
│  - 12-hour delayed data                                        │
│  - 10 articles max per request                                 │
└─────────────────────────────────────────────────────────────────┘

Problems:
❌ Variable API costs (depends on user traffic)
❌ Slow response times (external API dependency)
❌ Limited articles (10 per request)
❌ No sentiment analysis
❌ Cache expiration causes user-facing delays
```

## Queue-Based Architecture (Current - Solves Subrequest Limit)

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
│  Stage 2: Queue Articles                                        │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. Send each article to Cloudflare Queue│                  │
│  │ 2. Store articles in KV (pending status) │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                  │
│  Subrequests: ~11 (NewsData.io API calls only)                │
│  ✅ Well within 50 subrequest limit                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Cloudflare Queue                              │
│                   crypto-article-queue                          │
│                                                                  │
│  - Holds articles waiting for AI processing                    │
│  - Delivers 1 article at a time to consumer                    │
│  - Retries failed messages up to 3 times                       │
│  - Failed messages go to dead letter queue                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│           Consumer Worker (news-processor-consumer.js)          │
│                  Triggered: On Queue Message                    │
│                  Role: CONSUMER                                  │
│                  Processes: 1 article per invocation            │
│                                                                  │
│  Stage 1: Fetch Content                                         │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. fetch(article.link)                   │ 1 subrequest    │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 2: AI Analysis                                           │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. env.AI.run (sentiment)                │ 1 subrequest    │
│  │ 2. env.AI.run (summary)                  │ 1 subrequest    │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 3: Update KV                                             │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. Read existing data from KV            │                  │
│  │ 2. Update article with enriched data     │                  │
│  │ 3. Recalculate sentiment counts          │                  │
│  │ 4. Write back to KV                      │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                  │
│  Subrequests per invocation: ~3                                │
│  ✅ Each article gets fresh 50 subrequest budget               │
│  ✅ Can process unlimited articles without limits              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Cloudflare KV (Edge Storage)                  │
│                                                                  │
│  Key: BTC_ANALYZED_NEWS                                        │
│  Value: {                                                       │
│    articles: Array<Article> (100+)                             │
│    totalArticles: number                                       │
│    lastUpdatedExternal: timestamp                              │
│    sentimentCounts: {positive, negative, neutral}              │
│  }                                                              │
│                                                                  │
│  - Replicated globally across Cloudflare's edge network        │
│  - <10ms read latency from anywhere in the world              │
│  - Updated asynchronously by consumer worker                   │
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
│  2. Return enriched articles                                   │
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
│  - 100+ articles with sentiment tags and AI summaries          │
│  - Sentiment distribution                                       │
│  - Fresh timestamp (when worker last ran)                      │
│  - Ultra-fast (<10ms)                                          │
└─────────────────────────────────────────────────────────────────┘

Benefits:
✅ Solves "Too many subrequests" error
✅ Each article gets its own subrequest budget (50 on free tier)
✅ Scales to unlimited articles
✅ Ultra-fast response (<10ms)
✅ AI sentiment analysis and content summarization
✅ Automatic retry for failed articles
✅ Dead letter queue for permanently failed messages
✅ Consistent performance
```

## Data Flow Timeline (Queue-Based)

```
Hour 0:00
├─ Scheduled Worker (Producer) Runs
│  ├─ Fetches 100 new articles (11 subrequests to NewsData.io)
│  ├─ Sends 100 messages to queue (100 queue operations)
│  └─ Stores articles in KV with "pending" sentiment (1 KV write)
│
├─ Queue Consumer Worker (triggered 100 times)
│  ├─ Invocation 1: Process article 1 (3 subrequests) → Update KV
│  ├─ Invocation 2: Process article 2 (3 subrequests) → Update KV
│  ├─ Invocation 3: Process article 3 (3 subrequests) → Update KV
│  └─ ... (continues for all 100 articles)
│
├─ User 1 requests news → Reads KV → <10ms response
│  └─ Gets articles (some with "pending", some enriched)
│
├─ User 2 requests news (5 minutes later) → Reads KV → <10ms response
│  └─ Gets more enriched articles as consumer processes them
│
└─ User 3 requests news (10 minutes later) → Reads KV → <10ms response
   └─ Gets fully enriched articles with sentiment and summaries

Hour 1:00
└─ (repeats every hour)
```

## Old Architecture (Had Subrequest Limit Issue)

```
┌─────────────────────────────────────────────────────────────────┐
│           Scheduled Worker (news-updater-cron.js)               │
│                  Runs: Every Hour (Cron Job)                    │
│                                                                  │
│  Stage 1: Aggregation (Pagination Loop)                        │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. Fetch page 1 from NewsData.io         │                  │
│  │ 2. Get nextPage token                     │                  │
│  │ 3. Fetch page 2, 3, 4...                 │                  │
│  │ 4. Continue until 100+ articles          │                  │
│  │ 5. Deduplicate against existing data     │                  │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 2: Sentiment Analysis (AI Loop) ❌ PROBLEM              │
│  ┌──────────────────────────────────────────┐                  │
│  │ For each article (100 articles):         │                  │
│  │   1. fetch(article.link)     [1 SR]      │                  │
│  │   2. env.AI.run (sentiment)   [1 SR]      │                  │
│  │   3. env.AI.run (summary)     [1 SR]      │                  │
│  │                                            │                  │
│  │ Total: 100 × 3 = 300 subrequests         │                  │
│  │ ❌ Exceeds 50 subrequest limit           │                  │
│  │ ❌ Worker fails with "Too many           │                  │
│  │    subrequests" error                    │                  │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 3: Storage (Never reached)                               │
│  ┌──────────────────────────────────────────┐                  │
│  │ Would store in KV, but worker fails      │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                  │
│  Subrequests: ~311 (11 fetch + 300 AI)                        │
│  ❌ Exceeds 50 subrequest limit on free tier                   │
└─────────────────────────────────────────────────────────────────┘

Problem:
❌ Too many subrequests in single execution
❌ Cannot process more than ~16 articles (50 / 3)
❌ Worker fails before completing
❌ No articles get enriched with AI analysis
```

## Subrequest Comparison

```
Old Architecture (Single Worker):
┌────────────────────────────────────────────┐
│ Articles │ Subrequests │ Status           │
├────────────────────────────────────────────┤
│ 10       │ 41          │ ✅ OK (< 50)     │
│ 16       │ 59          │ ❌ FAIL (> 50)   │
│ 25       │ 86          │ ❌ FAIL (> 50)   │
│ 100      │ 311         │ ❌ FAIL (> 50)   │
└────────────────────────────────────────────┘

Queue-Based Architecture:
┌────────────────────────────────────────────┐
│ Articles │ Subrequests/Invocation │ Status │
├────────────────────────────────────────────┤
│ 10       │ 3 per article          │ ✅ OK  │
│ 16       │ 3 per article          │ ✅ OK  │
│ 25       │ 3 per article          │ ✅ OK  │
│ 100      │ 3 per article          │ ✅ OK  │
│ 1000     │ 3 per article          │ ✅ OK  │
│ Unlimited│ 3 per article          │ ✅ OK  │
└────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────────┐
│           Scheduled Worker (news-updater-cron.js)               │
│                  Runs: Every Hour (Cron Job)                    │
│                                                                  │
│  Stage 1: Aggregation (Pagination Loop)                        │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. Fetch page 1 from NewsData.io         │                  │
│  │ 2. Get nextPage token                     │                  │
│  │ 3. Fetch page 2, 3, 4...                 │                  │
│  │ 4. Continue until 100+ articles          │                  │
│  │ 5. Deduplicate against existing data     │                  │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 2: Sentiment Analysis (AI Loop)                         │
│  ┌──────────────────────────────────────────┐                  │
│  │ For each article:                        │                  │
│  │   1. Call Cloudflare Workers AI          │                  │
│  │   2. Classify: positive/negative/neutral │                  │
│  │   3. Add sentiment tag to article        │                  │
│  └──────────────────────────────────────────┘                  │
│                     │                                            │
│                     ▼                                            │
│  Stage 3: Storage                                               │
│  ┌──────────────────────────────────────────┐                  │
│  │ 1. Merge with existing articles          │                  │
│  │ 2. Calculate sentiment distribution      │                  │
│  │ 3. Add timestamp                         │                  │
│  │ 4. Store in KV under BTC_ANALYZED_NEWS   │                  │
│  └──────────────────────────────────────────┘                  │
│                                                                  │
│  Cost: ~11 API credits per run (fixed)                         │
│  Frequency: 24 runs/day = 264 credits/day                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Cloudflare KV (Edge Storage)                  │
│                                                                  │
│  Key: BTC_ANALYZED_NEWS                                        │
│  Value: {                                                       │
│    articles: Array<Article> (100+)                             │
│    totalArticles: number                                       │
│    lastUpdatedExternal: timestamp                              │
│    sentimentCounts: {positive, negative, neutral}              │
│  }                                                              │
│                                                                  │
│  - Replicated globally across Cloudflare's edge network        │
│  - <10ms read latency from anywhere in the world              │
│  - Updated hourly by scheduled worker                          │
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
│  2. Return pre-analyzed data                                   │
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
│  - 100+ articles with sentiment tags                           │
│  - Sentiment distribution                                       │
│  - Fresh timestamp (when worker last ran)                      │
│  - Ultra-fast (<10ms)                                          │
└─────────────────────────────────────────────────────────────────┘

Benefits:
✅ Fixed API costs (264 credits/day max)
✅ Ultra-fast response (<10ms)
✅ 100+ articles per response
✅ AI sentiment analysis included
✅ Scales to unlimited users
✅ Consistent performance
```

## Data Flow Timeline

```
Hour 0:00
├─ Scheduled Worker Runs
│  ├─ Fetches 100+ articles (5-15 API calls)
│  ├─ Analyzes sentiment (100+ AI calls)
│  └─ Stores in KV with timestamp: 00:00
│
├─ User 1 requests news → Reads KV → <10ms response
├─ User 2 requests news → Reads KV → <10ms response
├─ User 3 requests news → Reads KV → <10ms response
└─ ... (unlimited users, all get same fast response)

Hour 1:00
├─ Scheduled Worker Runs
│  ├─ Fetches new articles
│  ├─ Analyzes sentiment
│  └─ Updates KV with timestamp: 01:00
│
├─ User 4 requests news → Reads KV → <10ms response (fresh data)
└─ ...

Hour 2:00
└─ (repeats every hour)
```

## Cost Comparison

```
Old Architecture (Request-Driven):
┌────────────────────────────────────────────┐
│ Users/Day  │ Cache Miss Rate  │ API Cost   │
├────────────────────────────────────────────┤
│ 100        │ 10% (10 misses)  │ 10 credits │
│ 1,000      │ 10% (100 misses) │ 100 credits│
│ 10,000     │ 10% (1k misses)  │ 1k credits │
│ 100,000    │ 10% (10k misses) │ 10k credits│
└────────────────────────────────────────────┘
Cost scales with users ❌

New Architecture (Scheduled):
┌────────────────────────────────────────────┐
│ Users/Day  │ Cron Runs    │ API Cost       │
├────────────────────────────────────────────┤
│ 100        │ 24 (hourly)  │ 264 credits   │
│ 1,000      │ 24 (hourly)  │ 264 credits   │
│ 10,000     │ 24 (hourly)  │ 264 credits   │
│ 100,000    │ 24 (hourly)  │ 264 credits   │
│ 1,000,000  │ 24 (hourly)  │ 264 credits   │
└────────────────────────────────────────────┘
Fixed cost regardless of users ✅
```

## Performance Comparison

```
Response Time Distribution:

Old Architecture:
Cache HIT:  ████████████████████░░░░░░░░  50-100ms
Cache MISS: ████████████████████████████████████████████████████  500-2000ms

New Architecture:
KV Read:    ██  <10ms (always)
```

## Deployment Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        GitHub Repository                         │
└─────────────────┬────────────────────────────┬───────────────────┘
                  │                            │
                  ▼                            ▼
    ┌─────────────────────────┐  ┌──────────────────────────────┐
    │   wrangler.toml         │  │  wrangler-news-updater.toml  │
    │   (Main API Worker)     │  │  (Scheduled Worker)          │
    └────────────┬────────────┘  └──────────────┬───────────────┘
                 │                               │
                 ▼                               ▼
    ┌─────────────────────────┐  ┌──────────────────────────────┐
    │  Cloudflare Worker      │  │  Cloudflare Scheduled Worker │
    │  crypto-cache           │  │  crypto-news-updater         │
    │                         │  │                              │
    │  URL: *.workers.dev/    │  │  Trigger: cron               │
    │       api/bitcoin-news  │  │  Schedule: 0 * * * *         │
    └────────────┬────────────┘  └──────────────┬───────────────┘
                 │                               │
                 │        ┌──────────────────────┘
                 │        │
                 ▼        ▼
    ┌─────────────────────────────────────────────────────────────┐
    │              Cloudflare KV: CRYPTO_NEWS_CACHE               │
    │                                                              │
    │  Namespace ID: abc123...                                   │
    │  Binding: CRYPTO_NEWS_CACHE                                │
    │  Key: BTC_ANALYZED_NEWS                                    │
    └─────────────────────────────────────────────────────────────┘
```

## Key Metrics Dashboard

```
┌──────────────────────────────────────────────────────────────────┐
│                         System Health                            │
├──────────────────────────────────────────────────────────────────┤
│ Scheduled Worker Executions   │ 24/24 today           │ ✅ OK    │
│ API Credits Used Today         │ 264/200               │ ⚠️ WARN  │
│ KV Storage Size               │ 512 KB / 25 MB        │ ✅ OK    │
│ API Endpoint Response Time     │ 8ms avg               │ ✅ OK    │
│ Error Rate                    │ 0.0%                  │ ✅ OK    │
│ Articles in KV                │ 150                   │ ✅ OK    │
│ Last Worker Run               │ 15 min ago            │ ✅ OK    │
├──────────────────────────────────────────────────────────────────┤
│                      Sentiment Distribution                      │
├──────────────────────────────────────────────────────────────────┤
│ Positive: ████████████████████ 45 (30%)                         │
│ Negative: ████████████ 30 (20%)                                 │
│ Neutral:  ██████████████████████████████ 75 (50%)               │
└──────────────────────────────────────────────────────────────────┘
```

## Scaling Characteristics

```
                Old Architecture          New Architecture
                ────────────────          ────────────────
Users           ═══════════════▶          ══════════════▶
API Cost        ╱╱╱╱╱╱╱╱╱╱╱╱╱╱          ──────────────
Response Time   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔          ______________
Reliability     ╲╲╲╲╲╲╲╲╲╲╲╲╲╲          ──────────────
                
Legend:
═══▶  Growing linearly
╱╱╱   Growing exponentially  
▔▔▔   Variable/unstable
__    Flat/constant
╲╲╲   Degrading with load
```
