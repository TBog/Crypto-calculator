# Bitcoin News Scraper - AWS Lambda

This AWS Lambda function replaces the Cloudflare Worker processor for scraping Bitcoin news articles. It uses a full headless browser (Puppeteer + Chromium) to bypass the 10ms CPU timeout limitations of Cloudflare Workers.

## Why Lambda?

The migration from Cloudflare Workers to AWS Lambda provides:

1. **Full Browser Environment**: No 10ms CPU timeout limitations
2. **Better JavaScript Rendering**: Can scrape dynamic content
3. **Batch Processing**: Process multiple sites in parallel within one invocation
4. **Free Tier Friendly**: Designed to stay 100% within AWS Free Tier limits

## Architecture

```
EventBridge (2-min schedule)
  ↓
AWS Lambda (Node.js, 1024 MB, 20s timeout)
  ↓ (fetch articles)
Cloudflare D1 (via HTTP API)
  ↓ (launch browser)
Chromium Layer (@sparticuz/chromium)
  ↓ (parallel scraping)
Multiple News Sites (2+ tabs)
  ↓ (extracted content)
Cloudflare D1 (update articles)
```

## Key Features

### Batch Processing with Parallel Tabs
- Processes 2+ sites simultaneously in one execution
- Uses single browser instance to minimize "startup tax"
- Graceful error handling: one site failure doesn't crash the batch

### DOM-Based Text Extraction
- Ported HTMLRewriter logic from Cloudflare Worker
- Recursive DOM traversal in browser context
- Skips navigation, ads, headers, footers, sidebars
- Respects max character limits (10KB per article)

### Cloudflare D1 Integration
- Fetches articles needing processing via D1 HTTP API
- Updates scraped content back to D1
- Maintains compatibility with existing worker infrastructure

### Free Tier Safety
- **Invocations**: ~21,600/month (well below 1M free limit)
- **Compute**: ~172,800 GB-seconds @ 8s avg (well below 400K free limit)
- **Data Transfer**: Minimal text egress (well below 100 GB free limit)

## File Structure

```
lambda-scraper/
├── index.js                 # Main Lambda handler
├── package.json             # Dependencies
├── DEPLOYMENT_GUIDE.md      # Step-by-step deployment
├── README.md               # This file
└── cloudformation.yaml      # IaC template (optional)
```

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Set these environment variables in Lambda:
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID
- `CLOUDFLARE_D1_DATABASE_ID` - Your D1 database ID
- `CLOUDFLARE_API_TOKEN` - API token with D1 edit permissions

### 3. Deploy
See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for detailed instructions.

## Configuration

### Constants (in index.js)
```javascript
const MAX_CONTENT_CHARS = 10 * 1024;      // 10KB max per article
const MAX_CONTENT_FETCH_ATTEMPTS = 3;      // Max retry attempts
const BATCH_SIZE = 2;                      // Parallel sites per invocation
const BROWSER_TIMEOUT = 10000;             // 10s page load timeout
const PAGE_IDLE_TIMEOUT = 2000;            // 2s wait for networkidle2
```

Adjust these based on your needs and Free Tier constraints.

## How It Works

### 1. Fetch Articles
Queries Cloudflare D1 for articles needing content extraction:
```sql
SELECT * FROM articles 
WHERE needsSummary = 1 OR (contentTimeout IS NOT NULL AND contentTimeout < 3)
ORDER BY pubDate DESC
LIMIT 2
```

### 2. Launch Browser
Initializes headless Chromium once for the entire batch:
```javascript
browser = await puppeteer.launch({
  args: chromium.args,
  executablePath: await chromium.executablePath(),
  headless: chromium.headless
});
```

### 3. Parallel Processing
Opens multiple tabs (one per article) and scrapes simultaneously:
```javascript
const processPromises = articles.map(article => 
  processArticle(browser, article, config)
);
await Promise.allSettled(processPromises);
```

### 4. Extract Text
In-browser DOM traversal extracts visible text while skipping:
- Navigation elements (nav, menu, header, footer)
- Ads and promotional content (class/id pattern matching)
- Scripts, styles, forms, iframes
- Social sharing widgets

### 5. Update D1
Saves extracted content back to D1 for AI processing:
```javascript
await updateArticleInD1(accountId, databaseId, apiToken, articleId, {
  extractedContent: content,
  contentTimeout: attemptCount,
  processedAt: Date.now()
});
```

## Error Handling

### Individual Site Failures
- Uses `Promise.allSettled()` to prevent batch failure
- Logs errors but continues processing remaining articles
- Updates D1 with error details for retry logic

### Retry Logic
- Tracks failed attempts in `contentTimeout` field
- Retries up to 3 times before giving up
- Updates `summaryError` with failure reason

### Timeout Protection
- 20-second Lambda timeout prevents Free Tier overages
- Page load timeout (10s) prevents hanging on slow sites
- Network idle wait (2s) ensures dynamic content loads

## Monitoring

### CloudWatch Logs
```bash
aws logs tail /aws/lambda/crypto-news-scraper --follow
```

### Metrics to Watch
- **Invocations**: Should be ~21,600/month for 2-minute schedule
- **Duration**: Average should be 6-10 seconds
- **Errors**: Individual site failures are logged but not critical
- **Memory Usage**: Should stay under 1024 MB allocation

### Free Tier Alerts
Set up CloudWatch billing alerts to notify when approaching:
- 1 million invocations
- 400,000 GB-seconds compute time

## Comparison: Worker vs Lambda

| Feature | Cloudflare Worker | AWS Lambda |
|---------|------------------|------------|
| CPU Time | 10ms limit (Free) | 900s max timeout |
| Memory | 128 MB | 128 MB - 10 GB |
| Browser | HTMLRewriter only | Full Puppeteer |
| JS Rendering | No | Yes |
| Batch Processing | Sequential only | Parallel tabs |
| Cost (Free Tier) | 100K req/day | 1M req/month |
| Cold Start | ~5ms | ~500ms |

## Development

### Local Testing
Lambda functions can be tested locally with AWS SAM:

```bash
sam local invoke CryptoNewsScraper --event test-event.json
```

### Debug Mode
Add verbose logging:
```javascript
console.log('DEBUG:', { articleId, url, contentLength });
```

View logs in CloudWatch or with `aws logs tail`.

## Troubleshooting

### "Browser Launch Failed"
- Ensure Chromium layer is attached to function
- Verify memory allocation is at least 512 MB (1024 MB recommended)
- Check `/tmp` directory isn't full (Lambda has 512 MB ephemeral storage)

### "D1 API Failed"
- Verify API token permissions include D1 edit
- Check account ID and database ID are correct
- Ensure token hasn't expired (create new one if needed)

### "Timeout Error"
- Reduce `BATCH_SIZE` to process fewer sites per invocation
- Increase Lambda timeout (consider Free Tier impact)
- Lower `BROWSER_TIMEOUT` to fail faster on slow sites

### "Memory Exceeded"
- Increase memory allocation (gives more CPU too)
- Reduce `BATCH_SIZE` for memory-intensive sites
- Check for memory leaks (ensure pages are closed)

## Future Enhancements

Possible improvements:
- [ ] Add screenshot capture for debugging
- [ ] Implement content caching to avoid re-scraping
- [ ] Add support for cookie consent dialogs
- [ ] Implement JavaScript execution delay for SPA sites
- [ ] Add proxy support for geo-restricted content
- [ ] Integrate with SQS for better scaling

## License

MIT License - See root repository LICENSE file.
