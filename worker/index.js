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

// Cache duration for LLM summaries (5 minutes in seconds)
const SUMMARY_CACHE_TTL = 300;

// Cache duration for price history used in summaries (10 minutes in seconds)
const PRICE_HISTORY_CACHE_TTL = 600;

/**
 * Generic function to fetch data from CoinGecko API with caching
 * @param {string} endpoint - CoinGecko API endpoint (e.g., '/api/v3/simple/supported_vs_currencies')
 * @param {string} cacheKey - Cache key for storing the response
 * @param {number} cacheTTL - Cache time-to-live in seconds
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 * @returns {Promise<{data: Object, cacheStatus: string}>} API response data with cache status
 */
async function fetchFromCoinGecko(endpoint, cacheKey, cacheTTL, env, ctx) {
  const cache = caches.default;
  
  // Try to get from cache first
  const cacheUrl = new URL(`https://cache-internal/${cacheKey}`);
  const cachedResponse = await cache.match(cacheUrl);
  
  if (cachedResponse) {
    const data = await cachedResponse.json();
    return { data, cacheStatus: 'HIT' };
  }
  
  // Fetch from CoinGecko API
  const apiKey = env.COINGECKO_KEY;
  const headers = new Headers();
  if (apiKey) {
    headers.set('x-cg-demo-api-key', apiKey);
  }
  
  const url = `https://api.coingecko.com${endpoint}`;
  const response = await fetch(url, { headers });
  
  if (!response.ok) {
    throw new Error(`CoinGecko API request failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Cache the result
  const cacheResponse = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${cacheTTL}`
    }
  });
  
  // Cache asynchronously using waitUntil - allows response to be sent while cache operation completes
  // This is the recommended pattern for Cloudflare Workers to avoid blocking the response
  ctx.waitUntil(cache.put(cacheUrl, cacheResponse));
  
  return { data, cacheStatus: 'MISS' };
}

/**
 * Fetch supported vs_currencies from CoinGecko API
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 * @returns {Promise<Array<string>>} Array of supported currency codes
 */
async function fetchSupportedCurrencies(env, ctx) {
  try {
    const result = await fetchFromCoinGecko(
      '/api/v3/simple/supported_vs_currencies',
      'coingecko-supported-currencies',
      SUPPORTED_CURRENCIES_CACHE_TTL,
      env,
      ctx
    );
    return result.data;
  } catch (error) {
    console.error('Failed to fetch supported currencies, using fallback:', error);
    // Fallback to minimal list if API fails - only BTC and USD as that's what we rely on
    return ['btc', 'usd'];
  }
}

/**
 * Fetch all supported currencies from ExchangeRate-API
 * @param {Object} ctx - Execution context
 * @returns {Promise<Object>} Object with currency codes and their exchange rates
 */
async function fetchAllExchangeRates(ctx) {
  const cacheKey = 'exchange-rate-all-usd';
  const cache = caches.default;
  
  // Try to get from cache first
  const cacheUrl = new URL(`https://cache-internal/${cacheKey}`);
  const cachedResponse = await cache.match(cacheUrl);
  
  if (cachedResponse) {
    const data = await cachedResponse.json();
    return data;
  }
  
  // Free tier API - no API key required for basic usage
  const exchangeUrl = `https://open.er-api.com/v6/latest/USD`;
  
  try {
    const response = await fetch(exchangeUrl);
    if (!response.ok) {
      throw new Error(`Exchange rate API responded with status ${response.status}`);
    }
    
    const data = await response.json();
    
    // Cache the result for 1 hour
    const cacheResponse = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${EXCHANGE_RATE_CACHE_TTL}`
      }
    });
    
    // Cache asynchronously using waitUntil
    ctx.waitUntil(cache.put(cacheUrl, cacheResponse));
    
    return data;
  } catch (error) {
    console.error('Failed to fetch exchange rates:', error);
    throw error;
  }
}

/**
 * Fetch exchange rate from USD to target currency using ExchangeRate-API
 * Uses the consolidated fetchAllExchangeRates to avoid duplicate API calls
 * @param {string} targetCurrency - Target currency code (e.g., 'ron')
 * @param {Object} ctx - Execution context
 * @returns {Promise<number>} Exchange rate from USD to target currency
 */
async function fetchExchangeRate(targetCurrency, ctx) {
  const upperCurrency = targetCurrency.toUpperCase();
  
  try {
    // Fetch all rates (will use cache if available)
    const data = await fetchAllExchangeRates(ctx);
    const rate = data.rates[upperCurrency];
    
    if (!rate) {
      throw new Error(`Exchange rate not found for currency: ${upperCurrency}`);
    }
    
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

/**
 * Fetch Bitcoin price history from CoinGecko API in USD
 * Uses cache to avoid repeated API calls
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 * @param {number} days - Number of days of history (1, 7, 30, or 90)
 * @returns {Promise<{data: Object, cacheStatus: string}>} Price history data with cache status
 */
async function fetchPriceHistory(env, ctx, days = 1) {
  try {
    return await fetchFromCoinGecko(
      `/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`,
      `price-history-usd-${days}d`,
      PRICE_HISTORY_CACHE_TTL,
      env,
      ctx
    );
  } catch (error) {
    console.error('Failed to fetch price history:', error);
    throw error;
  }
}

function formatTimestamp(timestamp) {
  const d = new Date(timestamp);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0"); // Months are 0-indexed
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * Convert price history data to human-readable text for LLM
 * @param {Object} priceData - Price history data from CoinGecko
 * @param {string} periodLabel - Period label (e.g., "Last 24 Hours", "Last 7 Days")
 * @returns {string} Human-readable text description
 */
function convertPriceHistoryToText(priceData, periodLabel = "Last 24 Hours") {
  if (!priceData || !priceData.prices || priceData.prices.length === 0) {
    return "No price data available.";
  }
  
  const prices = priceData.prices;
  const startPrice = prices[0][1];
  const endPrice = prices[prices.length - 1][1];
  const priceChange = endPrice - startPrice;
  const priceChangePercent = ((priceChange / startPrice) * 100).toFixed(2);
  
  // Calculate high and low
  let highPrice = -Infinity;
  let lowPrice = Infinity;
  let highTime = null;
  let lowTime = null;
  
  for (const [timestamp, price] of prices) {
    if (price > highPrice) {
      highPrice = price;
      highTime = timestamp;
    }
    if (price < lowPrice) {
      lowPrice = price;
      lowTime = timestamp;
    }
  }
  
  // Format timestamps
  const startTime = new Date(prices[0][0]).toISOString();
  const endTime = new Date(prices[prices.length - 1][0]).toISOString();
  const highTimeFormatted = new Date(highTime).toISOString();
  const lowTimeFormatted = new Date(lowTime).toISOString();
  
  let dataSummary = "|date time|price(USD)|\n|---|---|\n";
  
  // Set maximum number of samples
  const targetSamples = 90 * 4;
  const sampleInterval = Math.max(1, Math.floor(prices.length / targetSamples));

  // Simple sample of data

  /**
   * Split the data into evenly sized chunks.
   * For each chunk:
   * Computes avg, max, and min.
   * Compares the current chunk's average to the previous chunk's average.
   * Chooses the max if the average is rising, min if falling.
   * Outputs one representative sample per chunk, tagged with its timestamp.
   */
  let prevValue = null;
  for (let i = 0; i < prices.length; i += sampleInterval) {
    const chunk = prices.slice(i, i + sampleInterval);
    if (chunk.length === 0) continue;
  
    let chosenEntry;
  
    if (chunk.length === 1) {
      // Fast path for single-point chunks
      const [timestamp, price] = chunk[0];
      chosenEntry = [timestamp, price];
    } else {
      // Normal multi-point logic
      let sum = 0;
      let maxEntry = chunk[0];
      let minEntry = chunk[0];
  
      for (const entry of chunk) {
        const [, price] = entry;
        sum += price;
        if (price > maxEntry[1]) maxEntry = entry;
        if (price < minEntry[1]) minEntry = entry;
      }
  
      const avg = sum / chunk.length;
  
      if (prevValue === null) {
        chosenEntry = [chunk[Math.floor(chunk.length / 2)][0], avg];
      } else if (avg > prevValue) {
        // Uptrend → pick max
        chosenEntry = maxEntry;
      } else {
        // Downtrend or flat → pick min
        chosenEntry = minEntry;
      }
    }
  
    const [timestamp, price] = chosenEntry;
    const time = formatTimestamp(timestamp);
  
    dataSummary += `|${time}|${price.toFixed(0)}|\n`;
  
    prevValue = price;
  }
  
  const text = `### DATA_BTC
Bitcoin (BTC) data for ${periodLabel} (in USD):

Period: ${startTime} to ${endTime}

Summary Statistics:
- Starting Price: $${startPrice.toFixed(2)}
- Ending Price: $${endPrice.toFixed(2)}
- Price Change: $${priceChange.toFixed(2)} (${priceChangePercent}%)
- Period High: $${highPrice.toFixed(2)} at ${highTimeFormatted}
- Period Low: $${lowPrice.toFixed(2)} at ${lowTimeFormatted}
- Volatility Range: $${(highPrice - lowPrice).toFixed(2)}

${dataSummary}

Total data points: ${prices.length}`;

  return text;
}

/**
 * Generate LLM summary of Bitcoin price trends
 * @param {Object} env - Environment variables (includes AI binding)
 * @param {Object} ctx - Execution context
 * @param {string} period - Time period ('24h', '7d', '30d', '90d')
 * @returns {Promise<{summary: Object, cacheStatus: string}>} Summary response with cache status
 */
async function generatePriceSummary(env, ctx, period = '24h') {
  // Map period to days and labels
  const periodConfig = {
    '24h': { days: 1, label: 'Last 24 Hours' },
    '7d': { days: 7, label: 'Last 7 Days' },
    '30d': { days: 30, label: 'Last 30 Days' },
    '90d': { days: 90, label: 'Last 3 Months' }
  };
  
  const config = periodConfig[period] || periodConfig['24h'];
  const cacheKey = `btc-price-summary-${period}`;
  const cache = caches.default;
  
  // Try to get from cache first
  const cacheUrl = new URL(`https://cache-internal/${cacheKey}`);
  const cachedResponse = await cache.match(cacheUrl);
  
  if (cachedResponse) {
    const data = await cachedResponse.json();
    return { summary: data, cacheStatus: 'HIT' };
  }
  
  // Fetch price history (will use cache if available)
  const priceResult = await fetchPriceHistory(env, ctx, config.days);
  const priceData = priceResult.data;
  
  // Convert to human-readable text
  const priceText = convertPriceHistoryToText(priceData, config.label);
  
  // Generate summary using Cloudflare Workers AI
  try {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a highly experienced **Cryptocurrency Financial Analyst**. You write using markdown instead of emoji. Analyze the provided Bitcoin price data and provide a concise summary of the trends, including key movements, overall direction, and any notable patterns followed by a final, three-sentence executive narrative. Your analysis must be purely based on the data provided in the DATA_BTC section. Response must be professional and quantitative.'
        },
        {
          role: 'user',
          content: priceText
        }
      ],
      max_tokens: 512  // Increased from default 256 to prevent truncation for longer periods
    });
    
    const summary = {
      summary: response.response || response,
      timestamp: Date.now(),
      period: period,
      dataInputAI: priceText,
      priceData: {
        startPrice: priceData.prices[0][1],
        endPrice: priceData.prices[priceData.prices.length - 1][1],
        dataPoints: priceData.prices.length
      }
    };
    
    // Cache the result for 5 minutes
    const cacheResponse = new Response(JSON.stringify(summary), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${SUMMARY_CACHE_TTL}`
      }
    });
    
    ctx.waitUntil(cache.put(cacheUrl, cacheResponse));
    
    return { summary, cacheStatus: 'MISS' };
  } catch (error) {
    console.error('Failed to generate LLM summary:', error);
    throw error;
  }
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
  let isAllowedOrigin = true;//false;
  if (origin && !isAllowedOrigin) {
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
    'Access-Control-Expose-Headers': 'X-Cache-Status, X-Currency-Converted, X-Conversion-Warning, X-Exchange-Rate, X-Data-Source-Price, X-Data-Source-Exchange, Cache-Control',
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
    
    // Special endpoint to get supported currencies from CoinGecko
    if (url.pathname === '/api/v3/simple/supported_vs_currencies') {
      const supportedCurrencies = await fetchSupportedCurrencies(env, ctx);
      
      return new Response(JSON.stringify(supportedCurrencies), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${SUPPORTED_CURRENCIES_CACHE_TTL}`,
          'X-Data-Source': 'CoinGecko API'
        }
      });
    }

    // Parse the URL search (a string of parameters, starts with the question mark) to get the parameters
    const searchParams = new URLSearchParams(url.search);
    
    // Special endpoint for LLM-powered Bitcoin price trend summary
    if (url.pathname === '/ai/summary') {
      try {
        // Get period parameter (default to 24h)
        const period = searchParams.get('period') || '24h';
        
        // Validate period
        const validPeriods = ['24h', '7d', '30d', '90d'];
        if (!validPeriods.includes(period)) {
          return new Response(JSON.stringify({
            error: 'Invalid period parameter',
            message: `Period must be one of: ${validPeriods.join(', ')}`
          }), {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        
        const result = await generatePriceSummary(env, ctx, period);
        
        return new Response(JSON.stringify(result.summary), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${SUMMARY_CACHE_TTL}`,
            'X-Cache-Status': result.cacheStatus,
            'X-Data-Source': 'CoinGecko API + Cloudflare Workers AI',
            'X-Summary-Currency': 'USD',
            'X-Summary-Period': period
          }
        });
      } catch (error) {
        console.error('Failed to generate summary:', error);
        return new Response(JSON.stringify({
          error: 'Failed to generate price summary',
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
    
    // Fetch supported currencies list for validation
    const supportedCurrencies = await fetchSupportedCurrencies(env, ctx);
    
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
      
      // Add attribution headers for data sources
      response.headers.set('X-Data-Source-Price', 'CoinGecko API');
      
      // Add headers to indicate currency conversion was performed
      if (isUnsupportedCurrency && exchangeRate) {
        response.headers.set('X-Currency-Converted', `USD -> ${originalCurrency.toUpperCase()}`);
        response.headers.set('X-Exchange-Rate', exchangeRate.toString());
        response.headers.set('X-Data-Source-Exchange', 'ExchangeRate-API');
        response.headers.set('X-Conversion-Warning', 'Exchange rates are approximate and may vary from actual values');
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
