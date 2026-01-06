/**
 * Shared Constants for Cloudflare Workers
 * 
 * These constants can be overridden via Cloudflare environment variables in wrangler.toml
 * or through the Cloudflare Dashboard for dynamic configuration without redeployment.
 * 
 * To override in wrangler.toml, add:
 * [vars]
 * MAX_STORED_ARTICLES = 1000
 * MAX_PAGES = 20
 * etc.
 */

// =============================================================================
// KV Storage Keys (shared across all workers)
// =============================================================================

export const KV_KEY_NEWS = 'BTC_ANALYZED_NEWS';  // Full articles payload (legacy)
export const KV_KEY_IDS = 'BTC_ID_INDEX';         // ID index for deduplication
export const KV_KEY_PENDING = 'BTC_PENDING_LIST'; // Pending articles to process (updater writes)
export const KV_KEY_CHECKPOINT = 'BTC_CHECKPOINT'; // Processor checkpoint state

// =============================================================================
// News Updater Worker Configuration
// =============================================================================

// Maximum articles to keep in KV storage (prevent size issues)
export const MAX_STORED_ARTICLES = 100;

// Maximum number of pages to fetch from news API (safety limit)
export const MAX_PAGES = 10;

// ID index TTL in seconds (30 days)
export const ID_INDEX_TTL = 60 * 60 * 24 * 30;  // 2592000 seconds

// =============================================================================
// News Processor Worker Configuration
// =============================================================================

// Maximum articles to process per run (stay within subrequest limits)
// 5 articles × 3 subrequests (fetch + 2 AI calls) = 15 subrequests (well under 50 limit)
export const MAX_ARTICLES_PER_RUN = 5;

// Maximum characters to extract from webpage (128KB limit for AI context)
export const MAX_CONTENT_CHARS = 10 * 1024;  // 10KB

// Maximum retry attempts for content fetching before giving up
export const MAX_CONTENT_FETCH_ATTEMPTS = 3;

// Delete old articles from KV when they are removed from the ID index
// When true, articles beyond MAX_STORED_ARTICLES limit are deleted from KV.
// When false, articles are kept until TTL expires (uses more KV space but saves delete operations).
//
// Cloudflare Free Tier note:
// - KV storage is limited to ~1 GB per account. With DELETE_OLD_ARTICLES = false, old
//   article payloads can accumulate until their TTL expires.
// - As a rough guideline, if each stored article averages ~10 KB (including metadata and
//   KV overhead), 1 GB could hold on the order of ~100,000 articles. Real capacity will
//   vary based on actual payload size and KV internals.
// - MAX_STORED_ARTICLES (currently 500) is intentionally conservative, but if you raise
//   this limit or store larger payloads, monitor KV namespace usage.
//
// Monitoring recommendations:
// - Use the Cloudflare Dashboard (KV analytics/metrics) or API to track total KV storage
//   usage for the relevant namespace.
// - Consider setting alerts or manual checks if you are close to the 1 GB limit, and
//   adjust MAX_STORED_ARTICLES or enable DELETE_OLD_ARTICLES if needed.
//
// Note: On Free Tier, deletes have their own separate 1,000/day limit (not combined with writes).
export const DELETE_OLD_ARTICLES = false;

// Maximum size of the pending list
// When the pending list exceeds this size, older pending articles will be dropped
// Default is same as MAX_STORED_ARTICLES to prevent unbounded growth
// Note: When first deploying with an empty KV, many articles will be added to pending list.
// The MAX_STORED_ARTICLES should be manually increased over time to prevent spikes in
// requests, neuron usage, and processing time during initial deployment.
export const MAX_PENDING_LIST_SIZE = 100;

// HTML entity decoding map and regex (shared utility for text processing)
export const HTML_ENTITY_MAP = {
  'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'", 'nbsp': ' '
  // Add more common ones here as needed (e.g., 'copy': '©')
};

export const HTML_ENTITY_REGEX = /&(?:#(\d+)|#x([a-fA-F\d]+)|([a-zA-Z\d]+));/g;

// =============================================================================
// API Worker Configuration
// =============================================================================

// Cache duration for supported currencies list (in seconds)
export const SUPPORTED_CURRENCIES_CACHE_TTL = 86400;  // 1 day

// Cache duration for exchange rates (in seconds)
export const EXCHANGE_RATE_CACHE_TTL = 3600;  // 1 hour

// Cache duration for LLM summaries (in seconds)
export const SUMMARY_CACHE_TTL = 600;  // 10 minutes

// Cache duration for price history used in summaries (in seconds)
export const PRICE_HISTORY_CACHE_TTL = 600;  // 10 minutes

// Cache duration for market chart data (in seconds)
export const MARKET_CHART_CACHE_TTL = 300;  // 5 minutes

// Cache duration for Bitcoin news (in seconds)
export const BITCOIN_NEWS_CACHE_TTL = 300;  // 5 minutes

// CORS configuration (in seconds)
export const CORS_MAX_AGE = 86400;  // 24 hours

// LLM configuration
export const LLM_MAX_TOKENS = 1024;      // Maximum tokens for LLM response
export const LLM_MAX_WORDS = 300;        // Maximum words for LLM summary

// Price history sampling configuration
export const PRICE_SAMPLE_THRESHOLD = 200;           // Data points threshold for adaptive sampling
export const PRICE_LARGE_DATASET_SAMPLES = 8;       // Samples for large datasets (>200 points)
export const PRICE_SMALL_DATASET_SAMPLES = 12;      // Samples for small datasets (<=200 points)

// =============================================================================
// Shared Utility Functions
// =============================================================================

/**
 * Minimal HTML entity decoder
 * Shared utility for decoding HTML entities in text content
 */
export function decodeHTMLEntities(str) {
  if (!str || typeof str !== 'string') return str || '';

  return str.replace(HTML_ENTITY_REGEX, (match, dec, hex, named) => {
    if (dec) {
      const codePoint = parseInt(dec, 10);
      // Validate code point is within valid Unicode range (0x10FFFF is the maximum valid Unicode code point)
      if (codePoint > 0x10FFFF) return match;
      return String.fromCodePoint(codePoint);
    }
    if (hex) {
      const codePoint = parseInt(hex, 16);
      // Validate code point is within valid Unicode range (0x10FFFF is the maximum valid Unicode code point)
      if (codePoint > 0x10FFFF) return match;
      return String.fromCodePoint(codePoint);
    }
    if (named) return HTML_ENTITY_MAP[named] || match;
    return match;
  });
}

// =============================================================================
// Helper Function: Get configuration value with default
// =============================================================================

/**
 * Get configuration value from environment variables with fallback to default
 * Handles both string and numeric environment variables
 * 
 * @param {Object} env - Cloudflare Workers environment
 * @param {string} key - Environment variable key
 * @param {any} defaultValue - Default value if not set in environment
 * @returns {any} Configuration value
 */
export function getConfig(env, key, defaultValue) {
  if (env[key] !== undefined) {
    const value = env[key];
    
    // If default is a number, try to parse the environment value as number
    if (typeof defaultValue === 'number') {
      const parsed = Number(value);
      return isNaN(parsed) ? defaultValue : parsed;
    }
    
    return value;
  }
  
  return defaultValue;
}

// =============================================================================
// Helper Function: Get all configuration values for a worker
// =============================================================================

/**
 * Get all configuration values for news updater worker
 * @param {Object} env - Cloudflare Workers environment
 * @returns {Object} Configuration object
 */
export function getNewsUpdaterConfig(env) {
  return {
    KV_KEY_NEWS,
    KV_KEY_IDS,
    KV_KEY_PENDING,
    KV_KEY_CHECKPOINT,
    MAX_STORED_ARTICLES: getConfig(env, 'MAX_STORED_ARTICLES', MAX_STORED_ARTICLES),
    MAX_PAGES: getConfig(env, 'MAX_PAGES', MAX_PAGES),
    ID_INDEX_TTL: getConfig(env, 'ID_INDEX_TTL', ID_INDEX_TTL),
    MAX_PENDING_LIST_SIZE: getConfig(env, 'MAX_PENDING_LIST_SIZE', MAX_PENDING_LIST_SIZE),
  };
}

/**
 * Get all configuration values for news processor worker
 * @param {Object} env - Cloudflare Workers environment
 * @returns {Object} Configuration object
 */
export function getNewsProcessorConfig(env) {
  return {
    KV_KEY_NEWS,
    KV_KEY_IDS,
    KV_KEY_PENDING,
    KV_KEY_CHECKPOINT,
    ID_INDEX_TTL: getConfig(env, 'ID_INDEX_TTL', ID_INDEX_TTL),
    MAX_ARTICLES_PER_RUN: getConfig(env, 'MAX_ARTICLES_PER_RUN', MAX_ARTICLES_PER_RUN),
    MAX_CONTENT_CHARS: getConfig(env, 'MAX_CONTENT_CHARS', MAX_CONTENT_CHARS),
    MAX_CONTENT_FETCH_ATTEMPTS: getConfig(env, 'MAX_CONTENT_FETCH_ATTEMPTS', MAX_CONTENT_FETCH_ATTEMPTS),
    MAX_STORED_ARTICLES: getConfig(env, 'MAX_STORED_ARTICLES', MAX_STORED_ARTICLES),
    DELETE_OLD_ARTICLES: getConfig(env, 'DELETE_OLD_ARTICLES', DELETE_OLD_ARTICLES),
    MAX_PENDING_LIST_SIZE: getConfig(env, 'MAX_PENDING_LIST_SIZE', MAX_PENDING_LIST_SIZE),
  };
}

/**
 * Get all configuration values for API worker
 * @param {Object} env - Cloudflare Workers environment
 * @returns {Object} Configuration object
 */
export function getAPIWorkerConfig(env) {
  return {
    KV_KEY_NEWS,
    KV_KEY_IDS,
    MAX_STORED_ARTICLES: getConfig(env, 'MAX_STORED_ARTICLES', MAX_STORED_ARTICLES),
    SUPPORTED_CURRENCIES_CACHE_TTL: getConfig(env, 'SUPPORTED_CURRENCIES_CACHE_TTL', SUPPORTED_CURRENCIES_CACHE_TTL),
    EXCHANGE_RATE_CACHE_TTL: getConfig(env, 'EXCHANGE_RATE_CACHE_TTL', EXCHANGE_RATE_CACHE_TTL),
    SUMMARY_CACHE_TTL: getConfig(env, 'SUMMARY_CACHE_TTL', SUMMARY_CACHE_TTL),
    PRICE_HISTORY_CACHE_TTL: getConfig(env, 'PRICE_HISTORY_CACHE_TTL', PRICE_HISTORY_CACHE_TTL),
    MARKET_CHART_CACHE_TTL: getConfig(env, 'MARKET_CHART_CACHE_TTL', MARKET_CHART_CACHE_TTL),
    BITCOIN_NEWS_CACHE_TTL: getConfig(env, 'BITCOIN_NEWS_CACHE_TTL', BITCOIN_NEWS_CACHE_TTL),
    CORS_MAX_AGE: getConfig(env, 'CORS_MAX_AGE', CORS_MAX_AGE),
    LLM_MAX_TOKENS: getConfig(env, 'LLM_MAX_TOKENS', LLM_MAX_TOKENS),
    LLM_MAX_WORDS: getConfig(env, 'LLM_MAX_WORDS', LLM_MAX_WORDS),
    PRICE_SAMPLE_THRESHOLD: getConfig(env, 'PRICE_SAMPLE_THRESHOLD', PRICE_SAMPLE_THRESHOLD),
    PRICE_LARGE_DATASET_SAMPLES: getConfig(env, 'PRICE_LARGE_DATASET_SAMPLES', PRICE_LARGE_DATASET_SAMPLES),
    PRICE_SMALL_DATASET_SAMPLES: getConfig(env, 'PRICE_SMALL_DATASET_SAMPLES', PRICE_SMALL_DATASET_SAMPLES),
  };
}
