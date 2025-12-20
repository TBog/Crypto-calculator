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
wrangler deploy --config worker-news-updater/wrangler.toml
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
wrangler tail --config worker-news-updater/wrangler.toml
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
wrangler deploy --config worker-news-updater/wrangler.toml
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

## APITube API Configuration Requirements

**CRITICAL**: The APITube provider implementation is a template based on common REST API patterns. 

⚠️ **You MUST configure the following based on actual APITube documentation before using in production:**

### Required Configuration Steps

1. **Obtain APITube Documentation**
   - Get official API documentation from APITube
   - Verify API endpoint URLs
   - Check authentication requirements
   - Review request/response formats

2. **Update API Endpoint** (in `shared/news-providers.js`, line ~120)
   ```javascript
   // Current placeholder:
   const newsUrl = new URL('https://api.apitube.io/v1/news/crypto');
   
   // Update with actual endpoint from APITube docs
   ```

3. **Configure Authentication** (in `shared/news-providers.js`, line ~138)
   ```javascript
   // Current implementation uses Bearer token:
   headers: {
     'Authorization': `Bearer ${this.apiKey}`,
     'Content-Type': 'application/json'
   }
   
   // Update if APITube uses different auth:
   // - API key in header: 'X-API-Key': this.apiKey
   // - API key in URL: newsUrl.searchParams.set('apikey', this.apiKey)
   ```

4. **Verify Query Parameters** (in `shared/news-providers.js`, lines ~124-125)
   ```javascript
   // Current parameters:
   newsUrl.searchParams.set('coin', 'bitcoin');
   newsUrl.searchParams.set('language', 'en');
   
   // Adjust parameter names to match APITube's API
   ```

5. **Configure Pagination** (in `shared/news-providers.js`, line ~130)
   ```javascript
   // Current: page-based pagination
   if (nextPage) {
     newsUrl.searchParams.set('page', nextPage);
   }
   
   // Update if APITube uses cursor-based:
   // newsUrl.searchParams.set('cursor', nextPage);
   ```

6. **Update Response Parsing** (in `shared/news-providers.js`, lines ~148-151)
   ```javascript
   // Current expected response format:
   {
     articles: [...],  // or 'results' or 'data'
     next: '...',      // or 'nextPage' or 'cursor'
     total: 100        // or 'totalResults'
   }
   
   // Update field names based on actual response
   ```

7. **Verify Sentiment Format** (in `shared/news-providers.js`, line ~171)
   ```javascript
   // Current: expects 'sentiment' or 'sentiment_score'
   // Update based on actual field name in APITube response
   ```

### Testing APITube Integration

After configuring:

1. **Test with sample data**:
   ```bash
   cd worker
   node verify-providers.js
   ```

2. **Test with actual API** (requires valid API key):
   ```bash
   # Set environment variable for testing
   export APITUBE_API_KEY="your-actual-key"
   
   # Deploy to development
   wrangler deploy --config worker-news-updater/wrangler.toml
   
   # Monitor logs for errors
   wrangler tail --config worker-news-updater/wrangler.toml
   ```

3. **Verify first batch of articles**:
   - Check if articles are fetched correctly
   - Verify sentiment values are normalized properly
   - Ensure pagination works as expected

### Common APITube Configuration Issues

**Authentication Failed (401/403)**:
- Verify API key is correct
- Check if authentication method matches APITube's requirements
- Ensure headers are formatted correctly

**No Articles Returned**:
- Verify endpoint URL is correct
- Check query parameters match API documentation
- Review response structure and update parsing logic

**Pagination Not Working**:
- Verify pagination style (page vs cursor)
- Check parameter names
- Ensure nextPage value is extracted correctly

**Incorrect Sentiment Values**:
- Check sentiment field name in response
- Verify sentiment format (string vs numeric)
- Update normalizeSentiment() logic if needed

## NewsData.io Configuration (Pre-configured)

The NewsData.io provider is fully configured and ready to use.
No additional configuration needed - just set the API key as described in Step 1.

## Best Practices

1. **Test First**: Test with a small batch before processing thousands of articles
2. **Monitor Costs**: Track API usage for both providers
3. **Backup Configuration**: Keep a record of which provider and keys are in use
4. **Gradual Migration**: If switching providers, monitor the first few runs carefully
5. **Keep Both Keys**: Maintain both API keys to enable quick switching if needed
