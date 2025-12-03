# Cloudflare Worker Deployment Guide

This directory contains a Cloudflare Worker that acts as a proxy for the CoinGecko API with edge caching.

## Features

- **Origin Validation**: Restricts access to authorized origins only (GitHub Pages and localhost) to prevent unauthorized API key usage
- **CORS Support**: Provides proper CORS headers for allowed origins
- **Edge Caching**: Caches API responses for 10 minutes (600 seconds) using Cloudflare's edge network
- **API Key Security**: Securely handles CoinGecko API key via environment variables
- **Error Handling**: Graceful error responses with appropriate HTTP status codes
- **Fallback Support**: Client-side fallback to public API if worker is unavailable
- **Data Source Attribution**: Adds headers to identify data sources (CoinGecko and ExchangeRate-API)
- **Conversion Warnings**: Includes warning headers when exchange rate conversion is performed
- **Currency Conversion Layer**: Automatic currency conversion for currencies not natively supported by CoinGecko (e.g., RON, and other fiat currencies)
  - Fetches data in USD from CoinGecko
  - Retrieves real-time exchange rates from ExchangeRate-API
  - Converts prices, market caps, and volumes transparently
  - Returns data as if CoinGecko natively supported the currency
  - Notifies frontend via response headers about the conversion
- **AI-Powered Price Summaries**: Uses Cloudflare Workers AI to generate natural language summaries of Bitcoin price trends
  - Analyzes 24-hour price history
  - Identifies key movements and patterns
  - Provides concise market analysis
  - Cached for 5 minutes for optimal performance
- **Bitcoin News Feed**: Real-time Bitcoin news with sentiment analysis powered by NewsData.io
  - Single API call optimization (1 credit per refresh instead of 3)
  - Read-through caching with 10-minute TTL
  - Automatic sentiment categorization (positive, negative, neutral)
  - Comprehensive article metadata and sentiment distribution
  - Fresh data indicators with lastUpdatedExternal timestamp

## Testing

This worker includes a comprehensive test suite. See [TEST_README.md](./TEST_README.md) for details.

**Quick Start:**
```bash
cd worker
npm install
npm test
```

**Run tests in watch mode:**
```bash
npm run test:watch
```

The test suite covers:
- AI summary generation with all period options (24h, 7d, 30d, 90d)
- Token limit validation (verifies the fix for summary truncation)
- Price data sampling logic
- Origin validation and CORS
- Cache configuration
- Response headers

## Deployment Steps

### Prerequisites

1. A [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed

### Deploy the Worker

1. **Install Wrangler** (if not already installed):
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare**:
   ```bash
   wrangler login
   ```

3. **Create a wrangler.toml file** in the worker directory:
   ```toml
   name = "crypto-cache"
   main = "index.js"
   compatibility_date = "2024-10-01"
   
   [ai]
   binding = "AI"
   
   [env.production]
   # Add your environment variables here after deployment
   ```

4. **Deploy the worker**:
   ```bash
   cd worker
   wrangler deploy
   ```

5. **Set the API Keys** (recommended):
   
   **CoinGecko API Key** (optional, for higher rate limits):
   ```bash
   wrangler secret put COINGECKO_KEY
   ```
   When prompted, enter your CoinGecko API key.
   
   **NewsData.io API Key** (required for Bitcoin news feed):
   ```bash
   wrangler secret put NEWSDATA_API_KEY
   ```
   When prompted, enter your NewsData.io API key. Get a free key at [newsdata.io](https://newsdata.io/).

6. **Note your Worker URL**: After deployment, Wrangler will display your worker URL (e.g., `https://crypto-cache.YOUR_SUBDOMAIN.workers.dev`)

### Update the Frontend

After deploying the worker, update the `index.html` file:

1. Find the `fetchBTCPrice` function
2. Replace `YOUR_WORKER_URL.workers.dev` with your actual worker URL from deployment

Example:
```javascript
const workerUrl = `https://crypto-cache.YOUR_SUBDOMAIN.workers.dev/api/v3/simple/price?ids=bitcoin&vs_currencies=${currencyLower}`;
```

## Testing

You can test the worker from your GitHub Pages site or localhost. Direct browser access may be blocked due to origin validation.

To test from localhost, serve the `index.html` file using a local web server:
```bash
# Using Python 3
python3 -m http.server 8000

# Using Node.js http-server
npx http-server -p 8000
```

Then visit `http://localhost:8000` and test the price fetching functionality.

## Currency Conversion for Unsupported Currencies

The worker automatically handles currency conversion for currencies not natively supported by CoinGecko. When you request data with an unsupported currency (like RON, Romanian Leu), the worker:

1. Detects that the currency is not in CoinGecko's supported list
2. Fetches the data in USD from CoinGecko
3. Retrieves the current USD to target currency exchange rate from [ExchangeRate-API](https://www.exchangerate-api.com/)
4. Converts all price, market cap, and volume data to the target currency
5. Returns the converted data seamlessly

**Supported CoinGecko Currencies:**
```
btc, eth, ltc, bch, bnb, eos, xrp, xlm, link, dot, yfi, sol,
usd, aed, ars, aud, bdt, bhd, bmd, brl, cad, chf, clp, cny,
czk, dkk, eur, gbp, gel, hkd, huf, idr, ils, inr, jpy, krw,
kwd, lkr, mmk, mxn, myr, ngn, nok, nzd, php, pkr, pln, rub,
sar, sek, sgd, thb, try, twd, uah, vef, vnd, zar, xdr, xag,
xau, bits, sats
```

**Example Usage:**
```
# Request with Romanian Leu (RON) - automatically converted
https://crypto-cache.tbog.workers.dev/api/v3/coins/bitcoin/market_chart?vs_currency=ron&days=1

# Request with another unsupported currency - automatically converted
https://crypto-cache.tbog.workers.dev/api/v3/simple/price?ids=bitcoin&vs_currencies=ron
```

The conversion is transparent to the client - the response format is identical to CoinGecko's native response.

## API Endpoints

### Standard CoinGecko Endpoints

All CoinGecko API v3 endpoints are proxied through the worker:
- `/api/v3/simple/price` - Get current prices
- `/api/v3/coins/bitcoin/market_chart` - Get historical price data
- `/api/v3/simple/supported_vs_currencies` - Get CoinGecko supported currencies

### Additional Endpoints

**Get Bitcoin Price Trend Summary (AI-Powered):**
```
GET /ai/summary?period=24h
```

Returns an AI-generated natural language summary of Bitcoin price trends. The summary is generated using Cloudflare Workers AI analyzing USD price data.

**Query Parameters:**
- `period` (optional): Time period for analysis. Valid values: `24h`, `7d`, `30d`, `90d`. Default: `24h`

Response format:
```json
{
  "summary": "Bitcoin has shown moderate volatility over the past 24 hours...",
  "timestamp": 1699459200000,
  "period": "24h",
  "priceData": {
    "startPrice": 43250.50,
    "endPrice": 43890.75,
    "dataPoints": 25
  }
}
```

**Features:**
- Analyzes price history in USD (1 day to 3 months)
- Identifies trends, movements, and patterns
- Cached for 5 minutes to optimize performance
- Reuses cached price history data when available
- Uses Llama 3.1 8B Instruct model with max_tokens=1024 to prevent truncation

**Technical Limits:**
- Input context: ~8192 tokens (sufficient for all periods)
- Output tokens: 1024 (supports comprehensive summaries up to ~800 words)
- Input data is sampled (8-12 price points) to keep context manageable

**Headers:**
- `X-Data-Source: CoinGecko API + Cloudflare Workers AI`
- `X-Summary-Currency: USD`
- `X-Summary-Period: 24h|7d|30d|90d`
- `Cache-Control: public, max-age=300`

**Get Bitcoin News Feed with Sentiment Analysis:**
```
GET /api/bitcoin-news
```

Returns Bitcoin-related news articles grouped by sentiment (positive, negative, neutral) from NewsData.io API.

**Features:**
- **Single API Call Optimization**: Fetches all articles in one request (1 API credit instead of 3)
- **Read-Through Caching**: 10-minute cache TTL for optimal performance and API credit efficiency
- **Sentiment Grouping**: Automatically categorizes articles by sentiment (positive, negative, neutral)
- **Comprehensive Response**: Includes article count, sentiment distribution, and timestamp
- **Robust Handling**: Articles without sentiment data are automatically categorized as neutral

**Note on Sentiment Data**: The sentiment field availability depends on your NewsData.io API plan. Articles without sentiment data are automatically categorized as "neutral" for consistent response structure.

Response format:
```json
{
  "articles": {
    "positive": [
      {
        "title": "Bitcoin Surges to New Heights",
        "description": "Bitcoin reaches all-time high...",
        "link": "https://example.com/article",
        "pubDate": "2024-12-03 10:00:00",
        "source_id": "cryptonews",
        "sentiment": "positive"
      }
    ],
    "negative": [...],
    "neutral": [...]
  },
  "totalArticles": 50,
  "lastUpdatedExternal": 1701601234567,
  "sentimentCounts": {
    "positive": 15,
    "negative": 10,
    "neutral": 25
  }
}
```

**Headers:**
- `X-Cache-Status: HIT` or `MISS` - Indicates cache status
- `X-Data-Source: NewsData.io API` - Attribution for news data source
- `X-Last-Updated: 1701601234567` - Timestamp when data was fetched from NewsData.io
- `X-Cache-TTL: 600` - Cache duration in seconds (10 minutes)
- `Cache-Control: public, max-age=600`

**Performance:**
- Cache Duration: 10 minutes (600 seconds)
- API Credits: 1 credit per cache refresh (optimized from 3 credits)
- Fresh Data: Timestamp indicates exact time data was fetched from external API

**Get All Supported Currencies from ExchangeRate-API:**
```
GET /api/exchange-rates/supported-currencies
```

Returns a list of all 160+ supported currencies from ExchangeRate-API, including:
```json
{
  "base_code": "USD",
  "currencies": ["AED", "AFN", "ALL", ...],
  "provider": "https://www.exchangerate-api.com",
  "documentation": "https://www.exchangerate-api.com/docs/free"
}
```

## Response Headers

The worker adds informative headers to help the frontend display appropriate attributions and warnings:

### Standard Headers (All Responses)
- `Cache-Control: public, max-age=600` - Instructs browsers and CDNs to cache for 10 minutes
- `X-Cache-Status: HIT` or `MISS` - Indicates whether the response was served from cache
- `X-Data-Source-Price: CoinGecko API` - Attribution for price data source
- CORS headers for cross-origin access

### Currency Conversion Headers (When Conversion Applied)
When the worker performs currency conversion (for currencies not natively supported by CoinGecko):
- `X-Currency-Converted: USD -> RON` - Indicates the conversion performed
- `X-Exchange-Rate: 4.396202` - The exchange rate used for conversion
- `X-Data-Source-Exchange: ExchangeRate-API` - Attribution for exchange rate data
- `X-Conversion-Warning: Exchange rates are approximate and may vary from actual values` - Warning about approximation

The frontend reads these headers and displays appropriate attribution and warnings to users.

## Security

### Origin Validation

The worker uses strict origin validation to prevent unauthorized API key usage by checking the `Origin` header against the `ALLOWED_ORIGINS` list:

**Validation Logic:**
- **Production Domains** (e.g., GitHub Pages): Exact match required for protocol, hostname, and port
- **Localhost/127.0.0.1**: Protocol and hostname must match, any port allowed for development flexibility

**Allowed Origins:**
- `https://tbog.github.io` (GitHub Pages - exact match)
- `http://localhost:*` (any port on localhost with http)
- `http://127.0.0.1:*` (any port on 127.0.0.1 with http)

**Security Features:**
- **URL parsing** to validate protocol, hostname, and port separately
- **Exact matching** for production domains (prevents subdomain attacks like `https://tbog.github.io.evil.com`)
- **Flexible localhost** validation (protocol + hostname only, any port allowed)
- **403 Forbidden** response for unauthorized origins
- **Dynamic CORS headers** that reflect the validated origin

### Modifying Allowed Origins

To add or modify allowed origins, edit the `ALLOWED_ORIGINS` array in `worker/index.js`:

```javascript
const ALLOWED_ORIGINS = [
  'https://tbog.github.io',
  'https://your-custom-domain.com',  // Add your custom domain
  'http://localhost:3000',            // Localhost examples (any port works)
  'http://127.0.0.1:8080'
];
```

**Important:**
- For production domains: All origins must include protocol, hostname, and port (if non-standard)
- For localhost/127.0.0.1: Only protocol and hostname are checked; port can be anything
- Invalid URLs in the list are safely ignored

## Cache Headers

**Note:** The "Cache Headers" section has been merged into "Response Headers" above for better organization.

## Environment Variables

- `COINGECKO_KEY` (optional): Your CoinGecko API key for higher rate limits
- `NEWSDATA_API_KEY` (required for news feed): Your NewsData.io API key for Bitcoin news feed feature. Get a free key at [newsdata.io](https://newsdata.io/)

## Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [CoinGecko API Documentation](https://www.coingecko.com/en/api/documentation)
