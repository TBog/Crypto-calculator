# Bitcoin News Updater - Scheduled Worker

This scheduled worker runs hourly to aggregate and analyze Bitcoin news, storing the results in Cloudflare KV for fast retrieval by the main API worker.

## Architecture

### New Architecture (Scheduled Worker)
```
┌─────────────────────────────────────────┐
│  Scheduled Worker (Cron Job)           │
│  Runs: Every hour                       │
│                                         │
│  1. Fetch 100+ articles (pagination)   │
│  2. Fetch article content from URLs    │
│  3. Generate AI summaries               │
│  4. Analyze sentiment with LLM         │
│  5. Store in KV                        │
└─────────────────────────────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  Cloudflare KV   │
         │  BTC_ANALYZED_   │
         │      NEWS        │
         └──────────────────┘
                    │
                    ▼
         ┌──────────────────┐
         │  API Endpoint    │
         │  (Read KV only)  │
         │  Ultra-fast!     │
         └──────────────────┘
```

### Benefits
- **API Credit Optimization**: Uses API credits only once per hour (not per user request)
- **Consistent Performance**: All users get millisecond-latency responses from KV
- **Fresh Data**: 100+ articles with sentiment analysis, updated hourly
- **AI-Enhanced Content**: Fetches full article content and generates concise AI summaries
- **Content Validation**: AI validates that webpage content matches article title before generating summary
- **Reliable**: Scheduled execution ensures data is always available

## Deployment Steps

### 1. Create Cloudflare KV Namespace

First, create a KV namespace for storing the news data:

```bash
cd worker
wrangler kv:namespace create "CRYPTO_NEWS_CACHE"
```

This will output a namespace ID. Copy this ID and update both wrangler config files:
- `wrangler-news-updater.toml`: Update `id` under `[[kv_namespaces]]`
- `wrangler.toml`: Update `id` under `[[kv_namespaces]]`

For production environment, also create a production namespace:
```bash
wrangler kv:namespace create "CRYPTO_NEWS_CACHE" --env production
```

Update the production IDs in both config files under `[[env.production.kv_namespaces]]`.

### 2. Deploy the Scheduled Worker

Deploy the news updater worker with its cron configuration:

```bash
wrangler deploy --config wrangler-news-updater.toml
```

### 3. Set API Key Secret

Set the NewsData.io API key for the scheduled worker:

```bash
wrangler secret put NEWSDATA_API_KEY --config wrangler-news-updater.toml
```

When prompted, enter your NewsData.io API key.

### 4. Deploy the Main API Worker

Deploy the updated main worker that reads from KV:

```bash
wrangler deploy
```

Note: The main worker no longer needs the NEWSDATA_API_KEY since it only reads from KV.

### 5. Verify Deployment

Check the scheduled worker's cron triggers:

```bash
wrangler deployments list --config wrangler-news-updater.toml
```

Monitor the scheduled worker's logs:

```bash
wrangler tail --config wrangler-news-updater.toml
```

You should see logs every hour when the cron job runs.

## Configuration

### Cron Schedule

The worker is configured to run every hour at the top of the hour:

```toml
[triggers]
crons = ["0 * * * *"]
```

You can adjust this schedule in `wrangler-news-updater.toml`. For example:
- `"0 */2 * * *"` - Every 2 hours
- `"0 */6 * * *"` - Every 6 hours
- `"*/30 * * * *"` - Every 30 minutes (higher API usage)

### Article Limits

In `news-updater-cron.js`:
- `TARGET_ARTICLES = 100` - Target number of new articles to fetch
- `MAX_PAGES = 15` - Maximum pagination pages (safety limit)

### KV Storage

The worker stores data under the key `BTC_ANALYZED_NEWS` with this structure:

```json
{
  "articles": [
    {
      "title": "...",
      "description": "...",
      "link": "...",
      "pubDate": "...",
      "source_id": "...",
      "sentiment": "positive|negative|neutral"
    }
  ],
  "totalArticles": 150,
  "lastUpdatedExternal": 1701234567890,
  "sentimentCounts": {
    "positive": 50,
    "negative": 30,
    "neutral": 70
  }
}
```

## Monitoring

### View Cron Logs

```bash
wrangler tail --config wrangler-news-updater.toml
```

### Check KV Storage

```bash
# List all keys
wrangler kv:key list --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml

# Get the stored news data
wrangler kv:key get BTC_ANALYZED_NEWS --binding CRYPTO_NEWS_CACHE --config wrangler-news-updater.toml
```

### Manual Trigger (Testing)

To manually trigger the scheduled worker for testing:

```bash
wrangler dev --config wrangler-news-updater.toml --test-scheduled
```

## API Credit Usage

With the old architecture (on-demand):
- Every user request = 1 API credit
- 1000 requests/day = 1000 credits/day

With the new architecture (scheduled):
- 1 cron execution = ~5-11 API credits (depending on pagination)
- Running hourly = ~132-264 credits/day (11 credits × 24 hours)
- **Savings**: Supports unlimited user requests with fixed API cost

## Troubleshooting

### Worker not running on schedule

1. Check deployments: `wrangler deployments list --config wrangler-news-updater.toml`
2. Verify cron triggers are configured in wrangler-news-updater.toml
3. Check worker logs for errors: `wrangler tail --config wrangler-news-updater.toml`

### API endpoint returning "temporarily unavailable"

This means KV is empty. Possible causes:
1. Scheduled worker hasn't run yet (wait up to 1 hour for first run)
2. Scheduled worker failed (check logs)
3. API key not set (use `wrangler secret put NEWSDATA_API_KEY`)

### Sentiment analysis not working

1. Verify AI binding is configured in wrangler-news-updater.toml
2. Check worker logs for AI-related errors
3. Ensure Cloudflare Workers AI is enabled for your account

## Cost Estimation

### NewsData.io Free Tier
- 200 requests/day
- With hourly cron: ~264 credits/day (11 per run × 24 hours)
- **Status**: Exceeds free tier, consider upgrading or reducing frequency

### Alternative: Run every 2 hours
- ~132 credits/day (11 per run × 12 hours)
- Fits within free tier limits
- Update cron: `crons = ["0 */2 * * *"]`

### Cloudflare Workers
- Scheduled workers: Free tier includes 1 million requests/month
- KV operations: 100,000 reads/day free, 1,000 writes/day free
- Workers AI: Refer to Cloudflare Workers AI pricing

## Files

- `news-updater-cron.js` - Scheduled worker implementation
- `wrangler-news-updater.toml` - Configuration for scheduled worker
- `index.js` - Main API worker (updated to read from KV)
- `wrangler.toml` - Configuration for main API worker
