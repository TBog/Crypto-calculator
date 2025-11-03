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

## Deployment Steps

### Option 1: GitHub Integration (Recommended for Auto-Deployment)

With `wrangler.toml` in the repository root, you can use Cloudflare's GitHub integration for automatic deployments:

1. **Install the Cloudflare Pages GitHub App**:
   - Go to your [Cloudflare Dashboard](https://dash.cloudflare.com/)
   - Navigate to Workers & Pages
   - Click "Create Application" → "Pages" → "Connect to Git"
   - Select your repository and authorize the GitHub app

2. **Configure Build Settings**:
   - Framework preset: None
   - Build command: (leave empty)
   - Build output directory: (leave empty)
   - The `wrangler.toml` at the root will be automatically detected

3. **Set Environment Variables**:
   - In the Cloudflare dashboard, go to your Worker settings
   - Add `COINGECKO_KEY` as an environment variable (encrypted)
   - This will be available to your worker via `env.COINGECKO_KEY`

4. **Automatic Deployments**:
   - **Production**: Pushes to your default branch (e.g., `main`) automatically deploy to production
   - **Preview**: Pull requests automatically create preview deployments with unique URLs
   - Each PR gets a preview URL like: `https://<commit-hash>.crypto-cache.pages.dev`

5. **Using PR Preview URLs in Frontend**:
   
   Since the frontend (`script.js`) has a hardcoded `WORKER_BASE_URL`, you have two options for testing with PR preview URLs:
   
   **Option A: Environment-based Configuration (Recommended)**
   
   Modify `script.js` to auto-detect the environment:
   ```javascript
   // Auto-detect worker URL based on environment
   const WORKER_BASE_URL = (() => {
       // Check if we're in a Cloudflare Pages preview deployment
       if (window.location.hostname.includes('.pages.dev')) {
           // Use same domain for worker in preview
           return `https://${window.location.hostname}`;
       }
       // Production worker URL
       return 'https://crypto-cache.tbog.workers.dev';
   })();
   ```
   
   **Option B: Manual Testing**
   
   For each PR that modifies the worker:
   1. Note the preview URL from the Cloudflare Pages deployment comment on the PR
   2. Temporarily modify `WORKER_BASE_URL` in `script.js` to use the preview URL
   3. Test the changes
   4. Revert the temporary change before merging
   
   **Note**: Option A is recommended as it automatically uses the correct URL based on the deployment environment, making PR testing seamless.

**Benefits:**
- No manual deployment needed
- PR previews for testing changes before merging
- Automatic rollback capabilities
- Built-in CI/CD pipeline

### Option 2: Manual Deployment with Wrangler CLI

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

3. **Deploy the worker** from the repository root:
   ```bash
   wrangler deploy
   ```
   
   Note: The `wrangler.toml` file is located in the repository root to support Cloudflare's GitHub integration for auto-deployment.

4. **Set the API Key** (optional, but recommended):
   ```bash
   wrangler secret put COINGECKO_KEY
   ```
   When prompted, enter your CoinGecko API key.

5. **Note your Worker URL**: After deployment, Wrangler will display your worker URL (e.g., `https://crypto-cache.YOUR_SUBDOMAIN.workers.dev`)

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

## Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [CoinGecko API Documentation](https://www.coingecko.com/en/api/documentation)
