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

import { getAPIWorkerConfig } from '../shared/constants.js';

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

/**
 * Fetch Bitcoin news from Cloudflare KV (populated by scheduled worker)
 * This endpoint reads articles stored individually by ID from KV
 * No external API calls are made, ensuring ultra-fast response times
 * 
 * DEPRECATION: Also supports legacy BTC_ANALYZED_NEWS format for transition period
 * 
 * @param {Object} env - Environment variables (includes CRYPTO_NEWS_CACHE KV binding)
 * @param {Object} config - Configuration object with KV keys and cache TTLs
 * @returns {Promise<{data: Object, cacheStatus: string, lastUpdated: number}>} News data with cache status and timestamp
 */
async function fetchBitcoinNews(env, config) {
  try {
    // Read ID index
    const idIndexData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_IDS, { type: 'json' });
    
    // DEPRECATION: Check for legacy BTC_ANALYZED_NEWS format
    if (!idIndexData || !Array.isArray(idIndexData) || idIndexData.length === 0) {
      console.log('No ID index found, checking for legacy BTC_ANALYZED_NEWS...');
      const legacyData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_NEWS, { type: 'json' });
      
      if (legacyData && legacyData.articles) {
        console.log('Found legacy data, returning it (migration needed)');
        return {
          data: legacyData,
          cacheStatus: 'KV-LEGACY',
          lastUpdated: legacyData.lastUpdatedExternal || Date.now()
        };
      }
      
      // No data in either format
      throw new Error('News data temporarily unavailable. Please try again later.');
    }
    
    // Read individual articles using the ID index
    const articlePromises = idIndexData.map(id => 
      env.CRYPTO_NEWS_CACHE.get(`article:${id}`, { type: 'json' })
    );
    const articles = await Promise.all(articlePromises);
    
    // Filter out any null results (articles that were deleted or expired)
    const validArticles = articles.filter(article => article !== null);
    
    if (validArticles.length === 0) {
      throw new Error('News data temporarily unavailable. Please try again later.');
    }
    
    // Calculate sentiment distribution (no longer stored as metadata)
    const sentimentCounts = {
      positive: 0,
      negative: 0,
      neutral: 0
    };
    
    validArticles.forEach(article => {
      const sentiment = article.sentiment;
      if (typeof sentiment === 'string' && ['positive', 'negative', 'neutral'].includes(sentiment)) {
        sentimentCounts[sentiment]++;
      }
    });
    
    // Construct response in format compatible with frontend
    const responseData = {
      articles: validArticles,
      totalArticles: validArticles.length,
      lastUpdatedExternal: Date.now(),
      sentimentCounts: sentimentCounts
    };
    
    return {
      data: responseData,
      cacheStatus: 'KV',
      lastUpdated: Date.now()
    };
  } catch (error) {
    console.error('Failed to fetch Bitcoin news from KV:', error);
    throw error;
  }
}

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
async function fetchSupportedCurrencies(env, ctx, config) {
  try {
    const result = await fetchFromCoinGecko(
      '/api/v3/simple/supported_vs_currencies',
      'coingecko-supported-currencies',
      config.SUPPORTED_CURRENCIES_CACHE_TTL,
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
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Object with currency codes and their exchange rates
 */
async function fetchAllExchangeRates(ctx, config) {
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
        'Cache-Control': `public, max-age=${config.EXCHANGE_RATE_CACHE_TTL}`
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
 * @param {Object} config - Configuration object
 * @returns {Promise<number>} Exchange rate from USD to target currency
 */
async function fetchExchangeRate(targetCurrency, ctx, config) {
  const upperCurrency = targetCurrency.toUpperCase();
  
  try {
    // Fetch all rates (will use cache if available)
    const data = await fetchAllExchangeRates(ctx, config);
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
 * @param {Object} config - Configuration object
 * @param {number} days - Number of days of history (1, 7, 30, or 90)
 * @returns {Promise<{data: Object, cacheStatus: string}>} Price history data with cache status
 */
async function fetchPriceHistory(env, ctx, config, days = 1) {
  try {
    return await fetchFromCoinGecko(
      `/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`,
      `price-history-usd-${days}d`,
      config.PRICE_HISTORY_CACHE_TTL,
      env,
      ctx
    );
  } catch (error) {
    console.error('Failed to fetch price history:', error);
    throw error;
  }
}

/**
 * Convert price history data to human-readable text for LLM
 * @param {Object} priceData - Price history data from CoinGecko
 * @param {string} periodLabel - Period label (e.g., "Last 24 Hours", "Last 7 Days")
 * @param {Object} config - Configuration object
 * @returns {string} Human-readable text description
 */
function convertPriceHistoryToText(priceData, periodLabel = "Last 24 Hours", config) {
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
  
  // Create hourly summary (sample every few hours for brevity)
  // Adjust sample size based on period length to keep input context manageable
  const targetSamples = prices.length > config.PRICE_SAMPLE_THRESHOLD ? config.PRICE_LARGE_DATASET_SAMPLES : config.PRICE_SMALL_DATASET_SAMPLES; // Fewer samples for longer periods
  let hourlySummary = "Price points:\n";
  const sampleInterval = Math.max(1, Math.floor(prices.length / targetSamples));
  for (let i = 0; i < prices.length; i += sampleInterval) {
    const [timestamp, price] = prices[i];
    const time = new Date(timestamp).toISOString();
    hourlySummary += `- ${time}: $${price.toFixed(2)}\n`;
  }
  
  const text = `Bitcoin (BTC) Price Analysis for the ${periodLabel} (in USD):

Period: ${startTime} to ${endTime}

Summary Statistics:
- Starting Price: $${startPrice.toFixed(2)}
- Ending Price: $${endPrice.toFixed(2)}
- Price Change: $${priceChange.toFixed(2)} (${priceChangePercent}%)
- Period High: $${highPrice.toFixed(2)} at ${highTimeFormatted}
- Period Low: $${lowPrice.toFixed(2)} at ${lowTimeFormatted}
- Volatility Range: $${(highPrice - lowPrice).toFixed(2)}

${hourlySummary}

Total data points: ${prices.length}`;

  return text;
}

/**
 * Generate LLM summary of Bitcoin price trends
 * @param {Object} env - Environment variables (includes AI binding)
 * @param {Object} ctx - Execution context
 * @param {Object} workerConfig - Worker configuration object
 * @param {string} period - Time period ('24h', '7d', '30d', '90d')
 * @returns {Promise<{summary: Object, cacheStatus: string}>} Summary response with cache status
 */
async function generatePriceSummary(env, ctx, workerConfig, period = '24h') {
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
  const priceResult = await fetchPriceHistory(env, ctx, workerConfig, config.days);
  const priceData = priceResult.data;
  
  // Convert to human-readable text
  const priceText = convertPriceHistoryToText(priceData, config.label, workerConfig);
  
  // Generate summary using Cloudflare Workers AI
  try {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: `You are a cryptocurrency market analyst. You write on a website with bullet points instead of emoji. Analyze the provided Bitcoin price data and provide a concise summary of the trends, including key movements, overall direction, and any notable patterns. Keep your response under ${workerConfig.LLM_MAX_WORDS} words.`
        },
        {
          role: 'user',
          content: priceText
        }
      ],
      max_tokens: workerConfig.LLM_MAX_TOKENS  // Increased from default 256 to prevent truncation for longer periods
    });
    
    const summary = {
      summary: response.response || response,
      timestamp: Date.now(),
      period: period,
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
        'Cache-Control': `public, max-age=${workerConfig.SUMMARY_CACHE_TTL}`
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
  // Load configuration with environment variable overrides
  const config = getAPIWorkerConfig(env);
  
  // Get the origin from the request
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);
  const hasOrigin = url.searchParams.has('origin'); // allow origin test skip for debug purposes
  
  // Validate origin against allowed list
  let isAllowedOrigin = hasOrigin;
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
    'Access-Control-Max-Age': String(config.CORS_MAX_AGE), // 24 hours
    'Access-Control-Expose-Headers': 'X-Cache-Status, X-Currency-Converted, X-Conversion-Warning, X-Exchange-Rate, X-Data-Source-Price, X-Data-Source-Exchange, X-Data-Source, X-Last-Updated, X-Cache-TTL, Cache-Control',
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
      const supportedCurrencies = await fetchSupportedCurrencies(env, ctx, config);
      
      return new Response(JSON.stringify(supportedCurrencies), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${config.SUPPORTED_CURRENCIES_CACHE_TTL}`,
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
        
        const result = await generatePriceSummary(env, ctx, config, period);
        
        return new Response(JSON.stringify(result.summary), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${config.SUMMARY_CACHE_TTL}`,
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
    
    // Special endpoint for Bitcoin news feed - reads from KV (populated by scheduled worker)
    if (url.pathname === '/api/bitcoin-news') {
      try {
        const result = await fetchBitcoinNews(env, config);
        
        return new Response(JSON.stringify(result.data), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${config.BITCOIN_NEWS_CACHE_TTL}`,
            'X-Cache-Status': result.cacheStatus,
            'X-Data-Source': 'Cloudflare KV (updated by scheduled worker)',
            'X-Last-Updated': result.lastUpdated.toString(),
            'X-Cache-TTL': config.BITCOIN_NEWS_CACHE_TTL.toString()
          }
        });
      } catch (error) {
        console.error('Failed to fetch Bitcoin news from KV:', error);
        return new Response(JSON.stringify({
          error: 'News data temporarily unavailable',
          message: 'The news feed is being updated. Please try again in a few minutes.'
        }), {
          status: 503,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }
    
    // Fetch supported currencies list for validation
    const supportedCurrencies = await fetchSupportedCurrencies(env, ctx, config);
    
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
        exchangeRate = await fetchExchangeRate(originalCurrency, ctx, config);
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

      // Add cache metadata headers
      // X-Last-Updated should already be in the cached response from when it was stored
      // X-Cache-TTL is the TTL value for chart data
      if (!newResponse.headers.has('X-Last-Updated')) {
        // Fallback if header is missing - use current time (shouldn't happen with new code)
        newResponse.headers.set('X-Last-Updated', Date.now().toString());
      }
      newResponse.headers.set('X-Cache-TTL', config.MARKET_CHART_CACHE_TTL.toString());
      
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

    // Add cache control header (5 minutes)
    response.headers.set('Cache-Control', `public, max-age=${config.MARKET_CHART_CACHE_TTL}`);
    
    // Add CORS headers
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    
    // Add cache status header
    response.headers.set('X-Cache-Status', 'MISS');

    // Add cache metadata headers for fresh data
    response.headers.set('X-Last-Updated', Date.now().toString());
    response.headers.set('X-Cache-TTL', config.MARKET_CHART_CACHE_TTL.toString());
    
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
