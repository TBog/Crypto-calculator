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

## New Architecture (Scheduled Worker)

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
