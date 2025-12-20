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

  /**
   * Check if provider supports built-in sentiment
   * @returns {boolean}
   */
  hasSentiment() {
    return false;
  }
}

/**
 * APITube Provider
 * Fetches Bitcoin news from APITube API
 * APITube provides sentiment analysis out of the box
 */
class APITubeProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'APITube';
  }

  /**
   * Fetch a page of articles from APITube
   * Note: APITube API structure is based on common patterns
   * Adjust endpoint and parameters based on actual APITube documentation
   * @param {string|null} nextPage - Pagination token or page number
   * @returns {Promise<{articles: Array, nextPage: string|null, totalResults: number}>}
   */
  async fetchPage(nextPage = null) {
    // APITube endpoint - adjust based on actual API documentation
    const newsUrl = new URL('https://api.apitube.io/v1/news/crypto');
    newsUrl.searchParams.set('apikey', this.apiKey);
    newsUrl.searchParams.set('coin', 'bitcoin');
    newsUrl.searchParams.set('language', 'en');
    
    // Handle pagination - adjust based on APITube's pagination style
    if (nextPage) {
      // If APITube uses numeric pages
      newsUrl.searchParams.set('page', nextPage);
      // Or if APITube uses cursor-based pagination:
      // newsUrl.searchParams.set('cursor', nextPage);
    }
    
    const response = await fetch(newsUrl.toString(), {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`APITube API request failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Adjust based on actual APITube response structure
    return {
      articles: data.articles || data.results || data.data || [],
      nextPage: data.nextPage || data.next || data.cursor || null,
      totalResults: data.total || data.totalResults || 0
    };
  }

  /**
   * Normalize article to standard format
   * APITube includes sentiment, so we don't need to mark for AI sentiment analysis
   * @param {Object} article - Raw article from provider
   * @returns {Object} Normalized article
   */
  normalizeArticle(article) {
    // Map APITube sentiment to our standard format (positive/negative/neutral)
    // Adjust field names based on actual APITube response
    const sentiment = this.normalizeSentiment(article.sentiment || article.sentiment_score);
    
    return {
      article_id: article.id || article.article_id,
      title: article.title,
      description: article.description || article.summary,
      link: article.url || article.link,
      pubDate: article.published_at || article.pubDate || article.date,
      source_id: article.source?.id || article.source_id,
      source_name: article.source?.name || article.source_name,
      source_url: article.source?.url || article.source_url,
      source_icon: article.source?.icon || article.source_icon,
      image_url: article.image || article.image_url,
      language: article.language || 'en',
      country: article.country,
      category: article.category || 'crypto',
      // APITube provides sentiment - use it directly
      sentiment: sentiment,
      needsSentiment: false,  // Already has sentiment
      needsSummary: true,     // Still need AI summary
      queuedAt: Date.now()
    };
  }

  /**
   * Normalize sentiment values from APITube to our standard format
   * @param {string|number} sentiment - Sentiment from APITube
   * @returns {string} Normalized sentiment (positive/negative/neutral)
   */
  normalizeSentiment(sentiment) {
    if (!sentiment) return 'neutral';
    
    // If sentiment is a string like "positive", "negative", "neutral"
    if (typeof sentiment === 'string') {
      const lower = sentiment.toLowerCase();
      if (lower.includes('pos')) return 'positive';
      if (lower.includes('neg')) return 'negative';
      return 'neutral';
    }
    
    // If sentiment is a score (e.g., -1 to 1, or 0 to 100)
    if (typeof sentiment === 'number') {
      // Assuming -1 to 1 scale (adjust based on actual APITube format)
      if (sentiment > 0.1) return 'positive';
      if (sentiment < -0.1) return 'negative';
      return 'neutral';
    }
    
    return 'neutral';
  }

  /**
   * Check if provider supports built-in sentiment
   * @returns {boolean}
   */
  hasSentiment() {
    return true;
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
