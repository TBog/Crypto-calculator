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

## APITube API Configuration

The APITube provider has been configured and verified against the official APITube documentation:
- Documentation: https://docs.apitube.io/guides/user-guide/what-is-apitube
- Endpoints: https://docs.apitube.io/platform/news-api/endpoints
- Authentication: https://docs.apitube.io/platform/news-api/authentication
- Response Structure: https://docs.apitube.io/platform/news-api/response-structure

### Configuration Details

1. **API Endpoint**: `https://api.apitube.io/v1/news/everything`
   - General news endpoint supporting flexible filtering
   - Filter by language, categories, keywords, topics, etc.

2. **Authentication**: X-API-Key header
   ```javascript
   headers: {
     'X-API-Key': apiKey,
     'Content-Type': 'application/json'
   }
   ```

3. **Query Parameters**:
   - `language`: Filter by language (e.g., 'en')
   - Optional: Add `q` parameter for keyword filtering (e.g., 'bitcoin OR cryptocurrency')
   - Optional: Add category/topic filters if supported

4. **Pagination**: Page-based with `next_page` URL in response
   ```javascript
   // Response includes links.next_page or next_page field
   // Can be used as full URL or page number
   ```

5. **Response Structure**:
   ```javascript
   {
     data: [...],           // Array of articles
     links: {
       next_page: "..."     // URL for next page
     },
     meta: {
       total: 100           // Total results
     }
   }
   ```

6. **Sentiment Format**:
   ```javascript
   sentiment: {
     overall: {
       score: 0.75,         // Numeric score
       polarity: "positive" // String: positive/negative/neutral
     },
     title: { ... },
     body: { ... }
   }
   ```

### Testing APITube Integration

After obtaining an APITube API key:

1. **Set up your API key**:
   ```bash
   wrangler secret put APITUBE_API_KEY
   # Enter your actual APITube API key
   ```

2. **Select APITube as provider**:
   ```bash
   wrangler secret put NEWS_PROVIDER
   # Enter: apitube
   ```

3. **Deploy to test**:
   ```bash
   cd worker
   wrangler deploy --config worker-news-updater/wrangler.toml
   ```

4. **Monitor the first run**:
   ```bash
   wrangler tail --config worker-news-updater/wrangler.toml
   ```

5. **Verify articles are fetched**:
   - Check if articles appear in your KV store
   - Verify sentiment values are populated
   - Ensure pagination works correctly

### Common APITube Issues and Solutions

**Authentication Failed (401/403)**:
- Verify your API key is correct
- Ensure the X-API-Key header is being sent
- Check if your API key has proper permissions

**No Articles Returned**:
- Verify the endpoint URL is correct
- Check query parameters (language, etc.)
- Review the response structure in logs

**Pagination Not Working**:
- Check if `next_page` is being extracted correctly
- Verify the URL format in response
- Test with smaller result sets first

**Incorrect Sentiment Values**:
- Check if sentiment.overall.polarity is available
- Verify the normalizeSentiment() logic handles your data
- Review sample responses for sentiment format

## NewsData.io Configuration (Pre-configured)

The NewsData.io provider is fully configured and ready to use.
No additional configuration needed - just set the API key as described in Step 1.

## Best Practices

1. **Test First**: Test with a small batch before processing thousands of articles
2. **Monitor Costs**: Track API usage for both providers
3. **Backup Configuration**: Keep a record of which provider and keys are in use
4. **Gradual Migration**: If switching providers, monitor the first few runs carefully
5. **Keep Both Keys**: Maintain both API keys to enable quick switching if needed
