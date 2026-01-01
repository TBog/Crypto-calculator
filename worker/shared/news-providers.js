/**
 * News Provider Interface for Bitcoin News Aggregation
 * 
 * Supports multiple news providers with a unified interface:
 * - NewsData.io (existing provider)
 * - APITube (new provider with built-in sentiment)
 * 
 * Provider selection is controlled via NEWS_PROVIDER Cloudflare secret:
 * - Set to 'newsdata' for NewsData.io (default)
 * - Set to 'apitube' for APITube
 * 
 * ============================================================================
 * APITube Configuration (verified against official documentation)
 * ============================================================================
 * 
 * The APITube provider has been configured based on the official API docs at:
 * https://docs.apitube.io/platform/news-api/response-structure
 * 
 * Key fields used:
 * - id (integer): Unique article identifier
 * - href (string): Article URL
 * - title (string): Article headline
 * - description (string): Brief description (may be absent)
 * - published_at (string): Publication date in ISO 8601 format
 * - language (string): Language in ISO 639-1 format (e.g., "en")
 * - image (string): Main image URL (may be absent)
 * - source (object): { id, name, uri, favicon }
 * - sentiment (object): { overall: { score, polarity }, title: {...}, body: {...} }
 * - categories (array): Array of category objects with name field
 * 
 * BEFORE PRODUCTION:
 * 1. Verify API endpoint URL (currently: https://api.apitube.io/v1/news/everything)
 * 2. Confirm authentication method (currently: Bearer token)
 * 3. Test with actual APITube API key and Bitcoin/crypto news queries
 * 
 * ============================================================================
 */

/**
 * Get article ID from article object (works across providers)
 * @param {Object} article - Article object
 * @returns {string|null} Article ID or null if not available
 */
function getArticleId(article) {
  return article.article_id || article.id || article.link || null;
}

/**
 * NewsData.io Provider
 * Fetches Bitcoin news from NewsData.io API
 * 
 * IMPORTANT: NewsData.io API returns articles sorted by published date
 * in descending order (newest first). This ordering is critical for
 * the early-exit optimization in the article aggregation logic.
 */
class NewsDataProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'NewsData.io';
  }

  /**
   * Fetch a page of articles from NewsData.io
   * @param {string|null} nextPage - Pagination token
   * @returns {Promise<{articles: Array, nextPage: string|null, totalResults: number}>}
   */
  async fetchPage(nextPage = null) {
    const newsUrl = new URL('https://newsdata.io/api/1/crypto');
    newsUrl.searchParams.set('apikey', this.apiKey);
    newsUrl.searchParams.set('coin', 'btc');
    newsUrl.searchParams.set('language', 'en');
    newsUrl.searchParams.set('removeduplicate', '1');
    
    if (nextPage) {
      newsUrl.searchParams.set('page', nextPage);
    }
    
    const response = await fetch(newsUrl.toString());
    
    if (!response.ok) {
      throw new Error(`NewsData.io API request failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    return {
      articles: data.results || [],
      nextPage: data.nextPage || null,
      totalResults: data.totalResults || 0
    };
  }

  /**
   * Normalize article to standard format
   * NewsData.io articles don't include sentiment, so we mark them for processing
   * @param {Object} article - Raw article from provider
   * @returns {Object} Normalized article
   */
  normalizeArticle(article) {
    return {
      article_id: article.article_id,
      title: article.title,
      description: article.description,
      link: article.link,
      pubDate: article.pubDate,
      source_id: article.source_id,
      source_name: article.source_name,
      source_url: article.source_url,
      source_icon: article.source_icon,
      image_url: article.image_url,
      language: article.language,
      country: article.country,
      category: article.category,
      // Mark for AI processing (NewsData doesn't provide sentiment)
      needsSentiment: true,
      needsSummary: true,
      queuedAt: Date.now()
    };
  }
}

/**
 * APITube Provider
 * Fetches Bitcoin news from APITube API
 * APITube provides sentiment analysis out of the box
 * 
 * IMPORTANT: APITube API returns articles sorted by published date
 * in descending order (newest first). This ordering is critical for
 * the early-exit optimization in the article aggregation logic.
 */
class APITubeProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'APITube';
  }

  /**
   * Fetch a page of articles from APITube
   * 
   * Based on APITube official documentation:
   * https://docs.apitube.io/platform/news-api/endpoints
   * 
   * Configuration notes:
   * 1. Endpoint: /v1/news/everything (general news endpoint)
   * 2. Authentication: Bearer token in Authorization header
   * 3. Pagination: Uses 'page' parameter with 'next_page' URL in response
   * 4. Query Parameters: Customize based on needs (language, categories, etc.)
   * 
   * @param {string|null} nextPage - Page number or URL for next page
   * @returns {Promise<{articles: Array, nextPage: string|null, totalResults: number}>}
   */
  async fetchPage(nextPage = null) {
    // APITube endpoint for general news
    // For crypto-specific news, you may want to filter by category or keywords
    const newsUrl = new URL('https://api.apitube.io/v1/news/everything');
    
    // Query parameters - customize based on your needs
    // Example: Filter by language, categories, keywords, etc.
    newsUrl.searchParams.set('language', 'en');
    // Add crypto-specific filters if needed:
    // newsUrl.searchParams.set('q', 'bitcoin OR cryptocurrency');
    // or use categories/topics if APITube provides crypto category
    
    // Handle pagination
    if (nextPage) {
      // If nextPage is a full URL (from next_page in response), use it directly
      // Otherwise, treat it as a page number
      if (nextPage.startsWith('http')) {
        return this.fetchFromUrl(nextPage);
      } else {
        newsUrl.searchParams.set('page', nextPage);
      }
    }
    
    return this.fetchFromUrl(newsUrl.toString());
  }
  
  /**
   * Helper method to fetch from a URL
   * @param {string} url - Full URL to fetch from
   * @returns {Promise<{articles: Array, nextPage: string|null, totalResults: number}>}
   */
  async fetchFromUrl(url) {
    // Authentication via Bearer token
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`APITube API request failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Parse APITube response structure
    // Response includes: { data: [...], meta: { ... }, links: { next_page, ... } }
    return {
      articles: data.data || data.articles || [],
      nextPage: data.links?.next_page || data.next_page || null,
      totalResults: data.meta?.total || data.total || 0
    };
  }

  /**
   * Normalize article to standard format
   * APITube includes sentiment, so we don't need to mark for AI sentiment analysis
   * 
   * APITube Response Structure:
   * - id: integer (unique identifier)
   * - href: string (article URL)
   * - title: string
   * - description: string (may be absent)
   * - body: string (full text without HTML)
   * - published_at: string (ISO 8601)
   * - language: string (ISO 639-1, e.g., "en")
   * - image: string (URL, may be absent)
   * - source: { id, name, uri, favicon }
   * - sentiment: { overall: { score, polarity }, title: {...}, body: {...} }
   * - categories: array of category objects
   * 
   * @param {Object} article - Raw article from APITube
   * @returns {Object} Normalized article in standard format
   */
  normalizeArticle(article) {
    // Map APITube sentiment to our standard format (positive/negative/neutral)
    // APITube provides: { sentiment: { overall: { score, polarity }, title: {...}, body: {...} } }
    const sentiment = this.normalizeSentiment(article.sentiment);
    
    // Extract first category name if categories array exists
    const category = article.categories && article.categories.length > 0 
      ? article.categories[0].name 
      : 'crypto';
    
    return {
      article_id: article.id || article.article_id,
      title: article.title,
      description: article.description || '',
      link: article.href || article.url || article.link,
      pubDate: article.published_at || article.pubDate || article.date,
      source_id: article.source?.id || article.source_id,
      source_name: article.source?.name || article.source_name,
      source_url: article.source?.uri || article.source?.url || article.source_url,
      source_icon: article.source?.favicon || article.source?.icon || article.source_icon,
      image_url: article.image || article.image_url,
      language: article.language || 'en',
      country: article.country,  // May not exist in APITube
      category: category,
      // APITube provides sentiment - use it directly
      sentiment: sentiment,
      needsSentiment: false,  // Already has sentiment
      needsSummary: true,     // Still need AI summary
      queuedAt: Date.now()
    };
  }

  /**
   * Normalize sentiment values from APITube to our standard format
   * APITube provides sentiment as an object with overall, title, and body sub-objects.
   * Each sub-object has 'score' (numeric) and 'polarity' (string: positive/negative/neutral).
   * We use the 'overall' polarity as it represents the complete article sentiment.
   * 
   * @param {Object|string|number} sentiment - Sentiment from APITube
   * @returns {string} Normalized sentiment (positive/negative/neutral)
   */
  normalizeSentiment(sentiment) {
    if (!sentiment) return 'neutral';
    
    // APITube structure: sentiment = { overall: { score, polarity }, title: {...}, body: {...} }
    if (typeof sentiment === 'object' && sentiment.overall) {
      // Use overall polarity (textual representation)
      const polarity = sentiment.overall.polarity;
      if (polarity) {
        const lower = polarity.toLowerCase();
        if (lower === 'positive') return 'positive';
        if (lower === 'negative') return 'negative';
        return 'neutral';
      }
      
      // Fallback to overall score if polarity not available
      const score = sentiment.overall.score;
      if (typeof score === 'number') {
        // Assuming -1 to 1 scale
        if (score > 0.1) return 'positive';
        if (score < -0.1) return 'negative';
        return 'neutral';
      }
    }
    
    // Fallback: If sentiment is already a string like "positive", "negative", "neutral"
    if (typeof sentiment === 'string') {
      const lower = sentiment.toLowerCase();
      if (lower.includes('pos')) return 'positive';
      if (lower.includes('neg')) return 'negative';
      return 'neutral';
    }
    
    // Fallback: If sentiment is a numeric score (legacy support)
    if (typeof sentiment === 'number') {
      // Assuming -1 to 1 scale
      if (sentiment > 0.1) return 'positive';
      if (sentiment < -0.1) return 'negative';
      return 'neutral';
    }
    
    return 'neutral';
  }
}

/**
 * Factory function to create the appropriate news provider
 * @param {Object} env - Environment variables (contains API keys and NEWS_PROVIDER)
 * @returns {NewsDataProvider|APITubeProvider} Provider instance
 * @throws {Error} If provider is not configured or unknown
 */
function createNewsProvider(env) {
  // Get provider selection from environment variable
  // Default to 'newsdata' if not specified
  const providerType = (env.NEWS_PROVIDER || 'newsdata').toLowerCase();
  
  switch (providerType) {
    case 'newsdata':
      if (!env.NEWSDATA_API_KEY) {
        throw new Error('NEWSDATA_API_KEY not configured for NewsData provider');
      }
      console.log('Using NewsData.io provider');
      return new NewsDataProvider(env.NEWSDATA_API_KEY);
      
    case 'apitube':
      if (!env.APITUBE_API_KEY) {
        throw new Error('APITUBE_API_KEY not configured for APITube provider');
      }
      console.log('Using APITube provider');
      return new APITubeProvider(env.APITUBE_API_KEY);
      
    default:
      throw new Error(`Unknown news provider: ${providerType}. Valid options: newsdata, apitube`);
  }
}

// Export for use in other modules
export {
  NewsDataProvider,
  APITubeProvider,
  createNewsProvider,
  getArticleId
};
