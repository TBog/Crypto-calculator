# Cloudflare Worker Deployment Guide

This directory contains a Cloudflare Worker that acts as a proxy for the CoinGecko API with edge caching.

## Features

- **Origin Validation**: Restricts access to authorized origins only (GitHub Pages and localhost) to prevent unauthorized API key usage
- **CORS Support**: Provides proper CORS headers for allowed origins
- **Edge Caching**: Caches API responses for 1 hour (3600 seconds) using Cloudflare's edge network
- **API Key Security**: Securely handles CoinGecko API key via environment variables
- **Error Handling**: Graceful error responses with appropriate HTTP status codes
- **Fallback Support**: Client-side fallback to public API if worker is unavailable

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
   
   [env.production]
   # Add your environment variables here after deployment
   ```

4. **Deploy the worker**:
   ```bash
   cd worker
   wrangler deploy
   ```

5. **Set the API Key** (optional, but recommended):
   ```bash
   wrangler secret put COINGECKO_KEY
   ```
   When prompted, enter your CoinGecko API key.

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

## Security

### Origin Validation

The worker uses strict origin validation to prevent unauthorized API key usage:

**Allowed Origins:**
- **GitHub Pages**: Exact match for `https://tbog.github.io` only
- **Local Development**: Any `http://localhost:*` or `http://127.0.0.1:*` (any port)

**Security Features:**
- **Exact matching** for production domain (prevents subdomain attacks like `https://tbog.github.io.evil.com`)
- **URL parsing** for localhost to validate hostname and protocol separately
- **403 Forbidden** response for unauthorized origins
- **Dynamic CORS headers** that reflect the validated origin

### Modifying Allowed Origins

To add or modify the production origin, edit the validation logic in the `handleRequest` function in `worker/index.js`:

```javascript
// Check for exact match with GitHub Pages or your custom domain
if (origin === 'https://tbog.github.io' || origin === 'https://your-custom-domain.com') {
  isAllowedOrigin = true;
}
```

For localhost development, the worker automatically allows any port on `localhost` or `127.0.0.1` with `http://` or `https://` protocol.

## Cache Headers

The worker adds the following headers to responses:
- `Cache-Control: public, max-age=3600` - Instructs browsers and CDNs to cache for 1 hour
- `X-Cache-Status: HIT` or `MISS` - Indicates whether the response was served from cache
- CORS headers for cross-origin access

## Environment Variables

- `COINGECKO_KEY` (optional): Your CoinGecko API key for higher rate limits

## Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [CoinGecko API Documentation](https://www.coingecko.com/en/api/documentation)
