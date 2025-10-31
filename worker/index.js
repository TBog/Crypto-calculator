/**
 * Cloudflare Worker for CoinGecko API Proxy with Caching
 * 
 * This worker proxies requests to the CoinGecko API with:
 * - Secure API key handling via environment variables
 * - Edge caching (1 hour TTL)
 * - CORS support for GitHub Pages
 * - Strict origin validation to prevent unauthorized API key usage
 * - Currency conversion layer for unsupported currencies
 */

// Allowed origins for accessing this worker
// For localhost/127.0.0.1: protocol and hostname must match (any port allowed)
// For production domains: protocol, hostname, and port must match exactly
const ALLOWED_ORIGINS = [
  'https://tbog.github.io',
  'http://localhost:3000',
  'http://localhost:8000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8000',
  'http://localhost:5500', // Live Server default port
  'http://127.0.0.1:5500'
];

// Cache duration for supported currencies list (1 day in seconds)
const SUPPORTED_CURRENCIES_CACHE_TTL = 86400;

// Cache duration for exchange rates (1 hour in seconds)
const EXCHANGE_RATE_CACHE_TTL = 3600;

/**
 * Fetch supported vs_currencies from CoinGecko API
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 * @returns {Promise<Array<string>>} Array of supported currency codes
 */
async function fetchSupportedCurrencies(env, ctx) {
  const cacheKey = 'coingecko-supported-currencies';
  const cache = caches.default;
  
  // Try to get from cache first
  const cacheUrl = new URL(`https://cache-internal/${cacheKey}`);
  const cachedResponse = await cache.match(cacheUrl);
  
  if (cachedResponse) {
    const data = await cachedResponse.json();
    return data.currencies;
  }
  
  // Fetch from CoinGecko API
  const apiKey = env.COINGECKO_KEY;
  const headers = new Headers();
  if (apiKey) {
    headers.set('x-cg-demo-api-key', apiKey);
  }
  
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/supported_vs_currencies', {
      headers: headers
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch supported currencies: ${response.status}`);
    }
    
    const currencies = await response.json();
    
    // Cache the result for 1 day
    const cacheResponse = new Response(JSON.stringify({ currencies }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${SUPPORTED_CURRENCIES_CACHE_TTL}`
      }
    });
    
    // Cache asynchronously using waitUntil - allows response to be sent while cache operation completes
    // This is the recommended pattern for Cloudflare Workers to avoid blocking the response
    ctx.waitUntil(cache.put(cacheUrl, cacheResponse));
    
    return currencies;
  } catch (error) {
    console.error('Failed to fetch supported currencies, using fallback:', error);
    // Fallback to minimal list if API fails - only BTC and USD as that's what we rely on
    return ['btc', 'usd'];
  }
}

/**
 * Fetch exchange rate from USD to target currency using ExchangeRate-API
 * Implements caching to reduce API calls
 * @param {string} targetCurrency - Target currency code (e.g., 'ron')
 * @param {Object} ctx - Execution context
 * @returns {Promise<number>} Exchange rate from USD to target currency
 */
async function fetchExchangeRate(targetCurrency, ctx) {
  const upperCurrency = targetCurrency.toUpperCase();
  const cacheKey = `exchange-rate-usd-${upperCurrency.toLowerCase()}`;
  const cache = caches.default;
  
  // Try to get from cache first
  const cacheUrl = new URL(`https://cache-internal/${cacheKey}`);
  const cachedResponse = await cache.match(cacheUrl);
  
  if (cachedResponse) {
    const data = await cachedResponse.json();
    return data.rate;
  }
  
  // Free tier API - no API key required for basic usage
  const exchangeUrl = `https://open.er-api.com/v6/latest/USD`;
  
  try {
    const response = await fetch(exchangeUrl);
    if (!response.ok) {
      throw new Error(`Exchange rate API responded with status ${response.status}`);
    }
    
    const data = await response.json();
    const rate = data.rates[upperCurrency];
    
    if (!rate) {
      throw new Error(`Exchange rate not found for currency: ${upperCurrency}`);
    }
    
    // Cache the result for 1 hour
    const cacheResponse = new Response(JSON.stringify({ rate }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${EXCHANGE_RATE_CACHE_TTL}`
      }
    });
    
    // Cache asynchronously using waitUntil
    ctx.waitUntil(cache.put(cacheUrl, cacheResponse));
    
    return rate;
  } catch (error) {
    console.error('Failed to fetch exchange rate:', error);
    throw error;
  }
}

/**
 * Convert market_chart data from USD to target currency
 * @param {Object} data - CoinGecko market_chart response data
 * @param {number} exchangeRate - Exchange rate from USD to target currency
 * @returns {Object} Converted data
 */
function convertMarketChartData(data, exchangeRate) {
  const converted = {};
  
  // Convert prices array [[timestamp, price], ...]
  if (data.prices) {
    converted.prices = data.prices.map(([timestamp, price]) => [
      timestamp,
      price * exchangeRate
    ]);
  }
  
  // Convert market_caps array [[timestamp, market_cap], ...]
  if (data.market_caps) {
    converted.market_caps = data.market_caps.map(([timestamp, marketCap]) => [
      timestamp,
      marketCap * exchangeRate
    ]);
  }
  
  // Convert total_volumes array [[timestamp, volume], ...]
  if (data.total_volumes) {
    converted.total_volumes = data.total_volumes.map(([timestamp, volume]) => [
      timestamp,
      volume * exchangeRate
    ]);
  }
  
  return converted;
}

/**
 * Convert simple price data from USD to target currency
 * @param {Object} data - CoinGecko simple/price response data
 * @param {number} exchangeRate - Exchange rate from USD to target currency
 * @param {string} targetCurrency - Target currency code
 * @returns {Object} Converted data
 */
function convertSimplePriceData(data, exchangeRate, targetCurrency) {
  const converted = {};
  
  // Simple price endpoint returns data like: { "bitcoin": { "usd": 43000 } }
  for (const [coin, prices] of Object.entries(data)) {
    if (prices.usd !== undefined) {
      // Copy all existing fields and add the converted currency
      converted[coin] = {
        ...prices,  // Preserve any other existing currency fields
        [targetCurrency.toLowerCase()]: prices.usd * exchangeRate
      };
    } else {
      // If no USD price, just copy as-is
      converted[coin] = prices;
    }
  }
  
  return converted;
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};

/**
 * Main request handler
 * @param {Request} request - Incoming request
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 * @returns {Promise<Response>} Response with CORS headers and caching
 */
async function handleRequest(request, env, ctx) {
  // Get the origin from the request
  const origin = request.headers.get('Origin');
  
  // Validate origin against allowed list
  let isAllowedOrigin = false;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      
      // Check against each allowed origin
      for (const allowedOrigin of ALLOWED_ORIGINS) {
        try {
          const allowedUrl = new URL(allowedOrigin);
            // For production domains, require exact match (protocol, hostname, and port)
            if (originUrl.protocol === allowedUrl.protocol &&
                originUrl.hostname === allowedUrl.hostname &&
                originUrl.port === allowedUrl.port) {
              isAllowedOrigin = true;
              break;
            }
        } catch (e) {
          // Skip invalid URL in allowed list
          continue;
        }
      }
    } catch (e) {
      // Invalid origin URL, not allowed
      isAllowedOrigin = false;
    }
  }
  
  // CORS headers for responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': isAllowedOrigin ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // 24 hours
  };

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // Reject requests from unauthorized origins
  if (!isAllowedOrigin) {
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      message: 'Origin not allowed'
    }), {
      status: 403,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }

  // Only allow GET and HEAD requests
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: corsHeaders
    });
  }

  try {
    // Parse the request URL to get the query parameters
    const url = new URL(request.url);
    
    // Special endpoint to get supported currencies
    if (url.pathname === '/api/v3/simple/supported_vs_currencies') {
      const supportedCurrencies = await fetchSupportedCurrencies(env, ctx);
      
      return new Response(JSON.stringify(supportedCurrencies), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${SUPPORTED_CURRENCIES_CACHE_TTL}`
        }
      });
    }
    
    // Fetch supported currencies list for validation
    const supportedCurrencies = await fetchSupportedCurrencies(env, ctx);
    
    const searchParams = new URLSearchParams(url.search);
    
    // Check if this is a request that uses vs_currency parameter
    const vsCurrency = searchParams.get('vs_currency') || searchParams.get('vs_currencies');
    const isUnsupportedCurrency = vsCurrency && !supportedCurrencies.includes(vsCurrency.toLowerCase());
    
    // If unsupported currency, we'll need to convert from USD
    let exchangeRate = null;
    let originalCurrency = null;
    
    if (isUnsupportedCurrency) {
      originalCurrency = vsCurrency.toLowerCase();
      
      // Fetch exchange rate from USD to target currency
      try {
        exchangeRate = await fetchExchangeRate(originalCurrency, ctx);
      } catch (exchangeError) {
        return new Response(JSON.stringify({
          error: 'invalid vs_currency',
          message: `Currency '${vsCurrency}' is not supported by CoinGecko and exchange rate could not be fetched: ${exchangeError.message}`
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      
      // Replace the currency parameter(s) with USD for the upstream request
      // Handle both 'vs_currency' and 'vs_currencies' explicitly
      if (searchParams.has('vs_currency')) {
        searchParams.set('vs_currency', 'usd');
      }
      if (searchParams.has('vs_currencies')) {
        searchParams.set('vs_currencies', 'usd');
      }
    }
    
    // Construct the modified search params
    const modifiedSearch = isUnsupportedCurrency ? `?${searchParams.toString()}` : url.search;
    
    // Create a new request URL for caching purposes
    const cacheUrl = new URL(request.url);
    const cacheRequest = new Request(cacheUrl.toString(), request);
    
    // Check cache first
    const cache = caches.default;
    let response = await cache.match(cacheRequest);

    if (response) {
      // Cache hit - clone response and add CORS headers
      const newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers)
      });
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newResponse.headers.set(key, value);
      });
      newResponse.headers.set('X-Cache-Status', 'HIT');
      return newResponse;
    }

    // Cache miss - fetch from upstream
    const apiKey = env.COINGECKO_KEY; // Environment variable from Cloudflare Workers
    
    // Construct upstream CoinGecko API URL with potentially modified search params
    const upstreamUrl = `https://api.coingecko.com${url.pathname}${modifiedSearch}`;
    
    // Add API key as header for CoinGecko API
    const upstreamHeaders = new Headers();
    if (apiKey) {
      upstreamHeaders.set('x-cg-demo-api-key', apiKey);
    }

    // Fetch from CoinGecko
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders
    });

    // Get the response body
    let responseData;
    let responseBody;
    const contentType = upstreamResponse.headers.get('content-type');
    
    if (upstreamResponse.ok && contentType && contentType.includes('application/json')) {
      responseData = await upstreamResponse.json();
      
      // If we need to convert currency, do it now
      if (isUnsupportedCurrency && exchangeRate) {
        if (url.pathname.includes('/market_chart')) {
          // Convert market_chart data
          responseData = convertMarketChartData(responseData, exchangeRate);
        } else if (url.pathname.includes('/simple/price')) {
          // Convert simple price data
          responseData = convertSimplePriceData(responseData, exchangeRate, originalCurrency);
        } else {
          // For other endpoints, return an error for unsupported currency
          return new Response(JSON.stringify({
            error: "Currency conversion is not supported for this endpoint.",
            message: `Currency conversion for '${originalCurrency}' is only supported for /market_chart and /simple/price endpoints.`
          }), {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
      }
      
      // Convert to JSON string for response body
      responseBody = JSON.stringify(responseData);
    } else {
      // For non-JSON responses, just pass through the body
      responseBody = upstreamResponse.body;
    }

    // Create response with caching headers
    response = new Response(
      responseBody,
      {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: new Headers(upstreamResponse.headers)
      }
    );

    // Add cache control header (10 minutes = 600 seconds)
    response.headers.set('Cache-Control', 'public, max-age=600');
    
    // Add CORS headers
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    
    // Add cache status header
    response.headers.set('X-Cache-Status', 'MISS');
    
    // Set proper content type only for JSON responses
    if (responseData) {
      response.headers.set('Content-Type', 'application/json');
      
      // Add headers to indicate currency conversion was performed
      if (isUnsupportedCurrency && exchangeRate) {
        response.headers.set('X-Currency-Converted', `USD -> ${originalCurrency.toUpperCase()}`);
        response.headers.set('X-Exchange-Rate', exchangeRate.toString());
      }
    }

    // Cache the response (clone it first as the body can only be read once)
    if (upstreamResponse.ok) {
      ctx.waitUntil(cache.put(cacheRequest, response.clone()));
    }

    return response;

  } catch (error) {
    // Return error response with CORS headers
    return new Response(JSON.stringify({
      error: 'Failed to fetch data from CoinGecko API',
      message: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
}
