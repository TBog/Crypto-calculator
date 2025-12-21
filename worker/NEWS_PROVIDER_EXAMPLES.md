# News Provider Examples

This document provides examples of how articles are processed by different news providers.

## Example: NewsData.io Provider

**Important Note**: The NewsData.io API does not provide a `source_name` field directly. The provider derives it from `source_id` by formatting the identifier into a human-readable name (e.g., "coindesk" becomes "Coindesk", "crypto-news" becomes "Crypto News").

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
  "source_name": "Cryptonews",  // ← Derived from source_id by the provider
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
  "source_name": "Cryptonews",  // ← Derived from source_id
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
  "data": [
    {
      "id": 67890,
      "href": "https://example.com/bitcoin-adoption",
      "title": "Bitcoin Adoption Grows in Latin America",
      "description": "Latin American countries are seeing increased Bitcoin adoption...",
      "published_at": "2025-01-15T12:00:00Z",
      "language": "en",
      "image": "https://example.com/adoption-image.jpg",
      "sentiment": {
        "overall": {
          "score": 0.78,
          "polarity": "positive"
        },
        "title": {
          "score": 0.82,
          "polarity": "positive"
        },
        "body": {
          "score": 0.75,
          "polarity": "positive"
        }
      },
      "source": {
        "id": 1,
        "name": "Bitcoin Journal",
        "uri": "https://btcjournal.com",
        "favicon": "https://btcjournal.com/favicon.ico"
      },
      "categories": [
        {
          "id": 1,
          "name": "cryptocurrency",
          "score": 0.95
        }
      ]
    }
  ],
  "meta": {
    "total": 200,
    "page": 1,
    "per_page": 10
  },
  "links": {
    "next_page": "https://api.apitube.io/v1/news/everything?page=2"
  }
}
```

### After Normalization
```json
{
  "article_id": 67890,
  "title": "Bitcoin Adoption Grows in Latin America",
  "description": "Latin American countries are seeing increased Bitcoin adoption...",
  "link": "https://example.com/bitcoin-adoption",
  "pubDate": "2025-01-15T12:00:00Z",
  "source_id": 1,
  "source_name": "Bitcoin Journal",
  "source_url": "https://btcjournal.com",
  "source_icon": "https://btcjournal.com/favicon.ico",
  "image_url": "https://example.com/adoption-image.jpg",
  "language": "en",
  "country": undefined,
  "category": "cryptocurrency",
  
  // Added by provider
  "sentiment": "positive",      // ← Extracted from sentiment.overall.polarity!
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

APITube provides sentiment as an object with three components: overall, title, and body. Each contains a score (-1 to 1) and polarity (positive/negative/neutral). The provider uses the overall polarity:

### APITube Sentiment Object Format
```javascript
// Input
{
  "sentiment": {
    "overall": {
      "score": 0.78,
      "polarity": "positive"
    },
    "title": {
      "score": 0.82,
      "polarity": "positive"
    },
    "body": {
      "score": 0.75,
      "polarity": "positive"
    }
  }
}
// Normalized → "positive" (from overall.polarity)

// Negative example
{
  "sentiment": {
    "overall": {
      "score": -0.65,
      "polarity": "negative"
    },
    "title": {
      "score": -0.70,
      "polarity": "negative"
    },
    "body": {
      "score": -0.60,
      "polarity": "negative"
    }
  }
}
// Normalized → "negative" (from overall.polarity)

// Neutral example
{
  "sentiment": {
    "overall": {
      "score": 0.05,
      "polarity": "neutral"
    }
  }
}
// Normalized → "neutral" (from overall.polarity)
```

### Fallback to Score (if polarity missing)
```javascript
// Input with score only
{
  "sentiment": {
    "overall": { "score": 0.85 }
  }
}
// Normalized → "positive" (score > 0.1)

{
  "sentiment": {
    "overall": { "score": -0.60 }
  }
}
// Normalized → "negative" (score < -0.1)

{
  "sentiment": {
    "overall": { "score": 0.05 }
  }
}
// Normalized → "neutral" (between -0.1 and 0.1)
```

### Legacy Format Support
The provider also supports legacy string and numeric formats for backward compatibility:

```javascript
// Legacy string format
{ "sentiment": "positive" }
// Normalized → "positive"

// Legacy numeric format
{ "sentiment_score": 0.85 }
// Normalized → "positive" (score > 0.1)
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
