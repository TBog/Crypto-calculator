# Shared Code

This directory contains code shared across multiple Cloudflare Workers.

## Files

### news-providers.js
News provider interface and implementations for fetching Bitcoin news from different sources:
- `NewsDataProvider` - NewsData.io integration
- `APITubeProvider` - APITube integration with built-in sentiment
- `createNewsProvider()` - Factory function for provider selection
- `getArticleId()` - Helper to extract article IDs consistently

Used by:
- `worker-news-updater` - To fetch articles from the selected provider
- `worker-news-processor` - To extract article IDs for processing

### news-providers.test.js
Unit tests for the news provider interface and implementations.

### verify-providers.js
Standalone verification script to test the provider system locally without deploying.

## Usage

To use shared code in a worker, import with a relative path:

```javascript
import { createNewsProvider, getArticleId } from '../shared/news-providers.js';
```

## Testing

Shared code is tested via:
- `npm run test:unit` - Runs unit tests for providers
- `node shared/verify-providers.js` - Runs verification script
