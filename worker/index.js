/**
 * Cloudflare Worker for CoinGecko API Proxy with Caching
 * 
 * This worker proxies requests to the CoinGecko API with:
 * - Secure API key handling via environment variables
 * - Edge caching (1 hour TTL)
 * - CORS support for GitHub Pages
 */

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
  // CORS headers for all responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
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

  // Only allow GET and HEAD requests
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: corsHeaders
    });
  }

  try {
    // Check cache first
    const cache = caches.default;
    let response = await cache.match(request);

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
    
    // Parse the request URL to get the query parameters
    const url = new URL(request.url);
    const pathAndQuery = url.pathname + url.search;
    
    // Construct upstream CoinGecko API URL
    const upstreamUrl = `https://api.coingecko.com${pathAndQuery}`;
    
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

    // Create response with caching headers
    response = new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers
    });

    // Add cache control header (1 hour = 3600 seconds)
    response.headers.set('Cache-Control', 'public, max-age=3600');
    
    // Add CORS headers
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    
    // Add cache status header
    response.headers.set('X-Cache-Status', 'MISS');

    // Cache the response (clone it first as the body can only be read once)
    if (upstreamResponse.ok) {
      ctx.waitUntil(cache.put(request, response.clone()));
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
