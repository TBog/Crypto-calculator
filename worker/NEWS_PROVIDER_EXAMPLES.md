# News Provider Examples

This document provides examples of how articles are processed by different news providers.

## Example: NewsData.io Provider

### Raw API Response
```json
{
  "results": [
    {
      "article_id": "newsdata_12345",
      "title": "Bitcoin Surges Past $50,000 Mark",
      "description": "Bitcoin has reached a new milestone, crossing the $50,000 threshold...",
      "link": "https://example.com/bitcoin-surges",
      "pubDate": "2025-01-15 10:30:00",
      "source_id": "cryptonews",
      "source_name": "Crypto News Daily",
      "source_url": "https://cryptonews.com",
      "source_icon": "https://cryptonews.com/icon.png",
      "image_url": "https://example.com/bitcoin-image.jpg",
      "language": "en",
      "country": ["us"],
      "category": ["business"]
    }
  ],
  "nextPage": "page_token_xyz",
  "totalResults": 150
}
```

### After Normalization
```json
{
  "article_id": "newsdata_12345",
  "title": "Bitcoin Surges Past $50,000 Mark",
  "description": "Bitcoin has reached a new milestone, crossing the $50,000 threshold...",
  "link": "https://example.com/bitcoin-surges",
  "pubDate": "2025-01-15 10:30:00",
  "source_id": "cryptonews",
  "source_name": "Crypto News Daily",
  "source_url": "https://cryptonews.com",
  "source_icon": "https://cryptonews.com/icon.png",
  "image_url": "https://example.com/bitcoin-image.jpg",
  "language": "en",
  "country": ["us"],
  "category": ["business"],
  
  // Added by provider
  "needsSentiment": true,   // ← Requires AI sentiment analysis
  "needsSummary": true,     // ← Requires AI summary
  "queuedAt": 1705314600000
}
```

### After AI Processing (by news-processor-cron.js)
```json
{
  "article_id": "newsdata_12345",
  "title": "Bitcoin Surges Past $50,000 Mark",
  "description": "Bitcoin has reached a new milestone, crossing the $50,000 threshold...",
  "link": "https://example.com/bitcoin-surges",
  "pubDate": "2025-01-15 10:30:00",
  "source_id": "cryptonews",
  "source_name": "Crypto News Daily",
  "source_url": "https://cryptonews.com",
  "source_icon": "https://cryptonews.com/icon.png",
  "image_url": "https://example.com/bitcoin-image.jpg",
  "language": "en",
  "country": ["us"],
  "category": ["business"],
  
  // Added by AI processing
  "sentiment": "positive",       // ← AI-generated sentiment
  "aiSummary": "Bitcoin breaks through $50K resistance level...",
  "needsSentiment": false,       // ← Cleared after processing
  "needsSummary": false,         // ← Cleared after processing
  "processedAt": 1705315200000,
  "queuedAt": 1705314600000
}
```

## Example: APITube Provider

### Raw API Response
```json
{
  "articles": [
    {
      "id": "apitube_67890",
      "title": "Bitcoin Adoption Grows in Latin America",
      "description": "Latin American countries are seeing increased Bitcoin adoption...",
      "url": "https://example.com/bitcoin-adoption",
      "published_at": "2025-01-15T12:00:00Z",
      "sentiment": "positive",        // ← Already included!
      "sentiment_score": 0.78,
      "source": {
        "id": "btc_journal",
        "name": "Bitcoin Journal",
        "url": "https://btcjournal.com",
        "icon": "https://btcjournal.com/icon.png"
      },
      "image": "https://example.com/adoption-image.jpg"
    }
  ],
  "next": "cursor_abc123",
  "total": 200
}
```

### After Normalization
```json
{
  "article_id": "apitube_67890",
  "title": "Bitcoin Adoption Grows in Latin America",
  "description": "Latin American countries are seeing increased Bitcoin adoption...",
  "link": "https://example.com/bitcoin-adoption",
  "pubDate": "2025-01-15T12:00:00Z",
  "source_id": "btc_journal",
  "source_name": "Bitcoin Journal",
  "source_url": "https://btcjournal.com",
  "source_icon": "https://btcjournal.com/icon.png",
  "image_url": "https://example.com/adoption-image.jpg",
  "language": "en",
  "country": undefined,
  "category": "crypto",
  
  // Added by provider
  "sentiment": "positive",      // ← Already from APITube!
  "needsSentiment": false,      // ← No AI sentiment needed
  "needsSummary": true,         // ← Still needs AI summary
  "queuedAt": 1705318800000
}
```

### After AI Processing (by news-processor-cron.js)
```json
{
  "article_id": "apitube_67890",
  "title": "Bitcoin Adoption Grows in Latin America",
  "description": "Latin American countries are seeing increased Bitcoin adoption...",
  "link": "https://example.com/bitcoin-adoption",
  "pubDate": "2025-01-15T12:00:00Z",
  "source_id": "btc_journal",
  "source_name": "Bitcoin Journal",
  "source_url": "https://btcjournal.com",
  "source_icon": "https://btcjournal.com/icon.png",
  "image_url": "https://example.com/adoption-image.jpg",
  "language": "en",
  "country": undefined,
  "category": "crypto",
  
  "sentiment": "positive",           // ← From APITube (unchanged)
  "aiSummary": "Growing adoption of Bitcoin in Latin America...",
  "needsSentiment": false,           // ← Was already false
  "needsSummary": false,             // ← Cleared after processing
  "processedAt": 1705319400000,
  "queuedAt": 1705318800000
}
```

## Comparison: Processing Time

### NewsData.io Article
```
1. Fetch article (news-updater-cron.js)
2. Wait for next processor run (~5 min average)
3. Sentiment analysis (~1s)
4. Fetch article content (~2s)
5. Generate AI summary (~3s)
Total: ~6 minutes + 6 seconds
```

### APITube Article
```
1. Fetch article with sentiment (news-updater-cron.js)
2. Wait for next processor run (~5 min average)
3. Sentiment analysis (SKIPPED - already has sentiment)
4. Fetch article content (~2s)
5. Generate AI summary (~3s)
Total: ~5 minutes + 5 seconds (1 second faster!)
```

## Sentiment Score Examples (APITube)

APITube may provide sentiment as either a string or a numeric score. The provider normalizes both formats:

### String Format
```javascript
// Input
{ "sentiment": "positive" }
// Normalized → "positive"

{ "sentiment": "NEGATIVE" }
// Normalized → "negative"

{ "sentiment": "neutral" }
// Normalized → "neutral"
```

### Numeric Score Format (0-1 scale)
```javascript
// Input
{ "sentiment_score": 0.85 }
// Normalized → "positive" (score > 0.1)

{ "sentiment_score": -0.60 }
// Normalized → "negative" (score < -0.1)

{ "sentiment_score": 0.05 }
// Normalized → "neutral" (between -0.1 and 0.1)
```

## Handling Missing Data

Both providers handle missing fields gracefully:

```javascript
// Missing sentiment (NewsData.io)
{
  "sentiment": undefined,
  "needsSentiment": true  // Will be analyzed by AI
}

// Missing sentiment (APITube) - should not happen
{
  "sentiment": "neutral",     // Defaults to neutral
  "needsSentiment": false     // Marked as having sentiment
}

// Missing image
{
  "image_url": undefined      // Allowed, not required
}

// Missing source icon
{
  "source_icon": undefined    // Allowed, not required
}
```

## Testing Provider Responses

To test how your provider normalizes articles, use the unit tests:

```bash
cd worker
npm run test:unit
```

Or test specific provider logic:

```javascript
import { APITubeProvider } from './news-providers.js';

const provider = new APITubeProvider('test-key');

// Test normalization
const rawArticle = {
  id: 'test-123',
  title: 'Test Article',
  sentiment_score: 0.5
};

const normalized = provider.normalizeArticle(rawArticle);
console.log(normalized.sentiment); // Output: "positive"
```
