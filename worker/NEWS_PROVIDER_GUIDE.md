# News Provider Configuration Guide

This guide explains how to configure and switch between different news providers for Bitcoin news aggregation.

## Available Providers

The system supports multiple news providers through a unified interface:

1. **NewsData.io** (default) - Requires separate sentiment analysis via AI
2. **APITube** - Includes built-in sentiment analysis

## Provider Selection

Provider selection is controlled via the `NEWS_PROVIDER` Cloudflare secret:

```bash
# Use NewsData.io (default if not set)
wrangler secret put NEWS_PROVIDER
# Enter: newsdata

# Use APITube
wrangler secret put NEWS_PROVIDER
# Enter: apitube
```

## Configuration Steps

### Step 1: Set Up API Keys

Each provider requires its own API key:

#### For NewsData.io:
```bash
wrangler secret put NEWSDATA_API_KEY
# Enter your NewsData.io API key from https://newsdata.io/
```

#### For APITube:
```bash
wrangler secret put APITUBE_API_KEY
# Enter your APITube API key
```

### Step 2: Select Provider

Set the `NEWS_PROVIDER` secret to choose which provider to use:

```bash
wrangler secret put NEWS_PROVIDER
# Enter either 'newsdata' or 'apitube'
```

**Note**: If `NEWS_PROVIDER` is not set, the system defaults to `newsdata`.

### Step 3: Deploy the Worker

Deploy the news updater worker with the new configuration:

```bash
cd worker
wrangler deploy --config wrangler-news-updater.toml
```

## Provider Differences

### NewsData.io
- **Sentiment Analysis**: Performed by Cloudflare Workers AI
- **Processing Time**: Requires AI sentiment analysis (1 extra API call per article)
- **Data Quality**: Very reliable, well-structured data
- **Cost**: Pay per API call + AI processing

### APITube
- **Sentiment Analysis**: Included in API response (no extra processing needed)
- **Processing Time**: Faster (skips sentiment analysis step)
- **Data Quality**: Depends on APITube's sentiment accuracy
- **Cost**: Pay per API call only

## KV Data Format

Both providers store articles in the same standardized format in Cloudflare KV:

```javascript
{
  article_id: "unique-id",
  title: "Article title",
  description: "Article description",
  link: "https://...",
  pubDate: "2025-01-01",
  source_id: "source-id",
  source_name: "Source Name",
  source_url: "https://...",
  source_icon: "https://...",
  image_url: "https://...",
  language: "en",
  country: "us",
  category: "crypto",
  
  // Sentiment (either from provider or AI)
  sentiment: "positive|negative|neutral",
  
  // Processing flags
  needsSentiment: false,  // true if needs AI sentiment
  needsSummary: true,     // always true initially
  queuedAt: 1234567890
}
```

## Monitoring Provider Selection

Check which provider is currently active by viewing the worker logs:

```bash
wrangler tail --config wrangler-news-updater.toml
```

You'll see log entries like:
- `Using NewsData.io provider` - NewsData is active
- `Using APITube provider` - APITube is active

## Switching Providers

To switch providers:

1. Ensure the new provider's API key is set
2. Update the `NEWS_PROVIDER` secret
3. Redeploy the worker (optional, will use new value on next scheduled run)

```bash
# Switch from NewsData to APITube
wrangler secret put NEWS_PROVIDER
# Enter: apitube

# Optional: Redeploy to take effect immediately
wrangler deploy --config wrangler-news-updater.toml
```

## Troubleshooting

### Error: "Unknown news provider"
- Check the value of `NEWS_PROVIDER` secret
- Must be either `newsdata` or `apitube` (case-insensitive)

### Error: "NEWSDATA_API_KEY not configured"
- Set the API key: `wrangler secret put NEWSDATA_API_KEY`

### Error: "APITUBE_API_KEY not configured"
- Set the API key: `wrangler secret put APITUBE_API_KEY`

### Provider not switching
- Secrets are cached, redeploy the worker to force refresh
- Check logs to confirm which provider is active

## Testing Provider Integration

You can test the provider integration locally (requires valid API keys):

```bash
cd worker
npm run test:unit
```

The test suite includes:
- Provider factory tests
- NewsData provider tests
- APITube provider tests
- Article normalization tests
- Sentiment normalization tests

## APITube API Endpoint Notes

**Important**: The APITube provider implementation is based on common API patterns. You may need to adjust the following in `news-providers.js`:

1. **API Endpoint**: Update the base URL if different
   ```javascript
   const newsUrl = new URL('https://api.apitube.io/v1/news/crypto');
   ```

2. **Authentication**: Adjust header format if needed
   ```javascript
   headers: {
     'Authorization': `Bearer ${this.apiKey}`,
   }
   ```

3. **Response Structure**: Update field mapping in `normalizeArticle()` based on actual API response

4. **Pagination**: Adjust pagination handling in `fetchPage()` based on APITube's pagination style

Refer to APITube's official documentation for the exact API structure and update the code accordingly.

## Best Practices

1. **Test First**: Test with a small batch before processing thousands of articles
2. **Monitor Costs**: Track API usage for both providers
3. **Backup Configuration**: Keep a record of which provider and keys are in use
4. **Gradual Migration**: If switching providers, monitor the first few runs carefully
5. **Keep Both Keys**: Maintain both API keys to enable quick switching if needed
