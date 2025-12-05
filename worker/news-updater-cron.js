/**
 * Scheduled Cloudflare Worker for Bitcoin News Aggregation & Analysis
 * 
 * This worker runs on a cron schedule (hourly) to:
 * 1. Fetch 100+ Bitcoin articles from NewsData.io using pagination
 * 2. Analyze sentiment of each article using Cloudflare Workers AI
 * 3. Store enriched data in Cloudflare KV for fast retrieval
 * 
 * This approach optimizes API credit usage by running on a schedule
 * rather than on-demand per user request.
 */

// Fixed KV key for storing analyzed Bitcoin news
const KV_KEY = 'BTC_ANALYZED_NEWS';

// Target number of articles to fetch (100+)
const TARGET_ARTICLES = 100;

// Maximum number of pages to fetch (safety limit)
const MAX_PAGES = 15;

// Maximum articles to keep in KV storage (prevent size issues)
const MAX_STORED_ARTICLES = 200;

/**
 * Fetch articles from NewsData.io with pagination support
 * @param {string} apiKey - NewsData.io API key
 * @param {string|null} nextPage - Pagination token from previous response
 * @returns {Promise<{articles: Array, nextPage: string|null, totalResults: number}>}
 */
async function fetchNewsPage(apiKey, nextPage = null) {
  const newsUrl = new URL('https://newsdata.io/api/1/crypto');
  newsUrl.searchParams.set('apikey', apiKey);
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
 * Analyze sentiment of an article using Cloudflare Workers AI
 * @param {Object} env - Environment variables (includes AI binding)
 * @param {Object} article - Article object to analyze
 * @returns {Promise<string>} Sentiment classification (positive, negative, neutral)
 */
async function analyzeSentiment(env, article) {
  try {
    // Construct prompt from article title and description
    const text = `${article.title || ''}. ${article.description || ''}`;
    
    // Use LLM to classify sentiment
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a sentiment analysis assistant. Classify the sentiment of the provided Bitcoin-related news article as exactly one word: "positive", "negative", or "neutral". Only respond with that single word.'
        },
        {
          role: 'user',
          content: text
        }
      ],
      max_tokens: 10
    });
    
    // Extract sentiment from response
    const sentiment = (response.response || response || '').trim().toLowerCase();
    
    // Validate and normalize sentiment
    if (sentiment.includes('positive')) {
      return 'positive';
    } else if (sentiment.includes('negative')) {
      return 'negative';
    } else {
      return 'neutral';
    }
  } catch (error) {
    console.error('Failed to analyze sentiment:', error);
    // Default to neutral on error
    return 'neutral';
  }
}

/**
 * Fetch and aggregate 100+ articles with pagination
 * @param {Object} env - Environment variables
 * @returns {Promise<Array>} Array of articles
 */
async function aggregateArticles(env) {
  const apiKey = env.NEWSDATA_API_KEY;
  if (!apiKey) {
    throw new Error('NEWSDATA_API_KEY not configured');
  }
  
  let allArticles = [];
  let nextPage = null;
  let pageCount = 0;
  let creditsUsed = 0;
  
  console.log('Starting article aggregation...');
  
  // Track article IDs we've already seen to detect duplicates
  const seenArticleIds = new Set();
  
  // Fetch article IDs from existing KV to avoid re-processing
  // Note: This loads IDs into memory. With MAX_STORED_ARTICLES=200,
  // this uses minimal memory (~10KB for 200 IDs). For larger datasets,
  // consider a time-based deduplication strategy instead.
  try {
    const existingData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY, { type: 'json' });
    if (existingData && existingData.articles) {
      existingData.articles.forEach(article => {
        if (article.article_id) {
          seenArticleIds.add(article.article_id);
        }
      });
      console.log(`Found ${seenArticleIds.size} existing articles in KV`);
    }
  } catch (error) {
    console.log('No existing data in KV or error reading:', error.message);
  }
  
  // Pagination loop
  do {
    try {
      console.log(`Fetching page ${pageCount + 1}...`);
      const pageData = await fetchNewsPage(apiKey, nextPage);
      creditsUsed++;
      
      // Filter out articles we've already stored
      const newArticles = pageData.articles.filter(article => {
        // Use article_id as primary identifier, fallback to link
        // NewsData.io API provides article_id as unique identifier
        // If article_id is missing (rare), use link as fallback
        const articleId = article.article_id || article.link;
        if (!articleId || seenArticleIds.has(articleId)) {
          return false;
        }
        seenArticleIds.add(articleId);
        return true;
      });
      
      console.log(`Page ${pageCount + 1}: ${pageData.articles.length} total, ${newArticles.length} new articles`);
      
      // If we got no new articles, stop pagination
      if (newArticles.length === 0) {
        console.log('No new articles found, stopping pagination');
        break;
      }
      
      allArticles = allArticles.concat(newArticles);
      nextPage = pageData.nextPage;
      pageCount++;
      
      // Stop if we've reached target or max pages
      if (allArticles.length >= TARGET_ARTICLES || pageCount >= MAX_PAGES) {
        console.log(`Stopping: ${allArticles.length} articles collected, ${pageCount} pages fetched`);
        break;
      }
      
      // If there's no nextPage, we've reached the end
      if (!nextPage) {
        console.log('No more pages available');
        break;
      }
      
    } catch (error) {
      console.error(`Error fetching page ${pageCount + 1}:`, error);
      break;
    }
  } while (nextPage && pageCount < MAX_PAGES);
  
  console.log(`Aggregation complete: ${allArticles.length} new articles, ${creditsUsed} credits used`);
  
  return allArticles;
}

/**
 * Analyze sentiment for all articles
 * @param {Object} env - Environment variables
 * @param {Array} articles - Array of articles to analyze
 * @returns {Promise<Array>} Articles with sentiment tags
 */
async function analyzeArticles(env, articles) {
  console.log(`Starting sentiment analysis for ${articles.length} articles...`);
  
  const analyzedArticles = [];
  
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    
    try {
      const sentiment = await analyzeSentiment(env, article);
      analyzedArticles.push({
        ...article,
        sentiment: sentiment
      });
      
      if ((i + 1) % 10 === 0) {
        console.log(`Analyzed ${i + 1}/${articles.length} articles`);
      }
    } catch (error) {
      console.error(`Error analyzing article ${i + 1}:`, error);
      // Include article with neutral sentiment on error
      analyzedArticles.push({
        ...article,
        sentiment: 'neutral'
      });
    }
  }
  
  console.log(`Sentiment analysis complete: ${analyzedArticles.length} articles processed`);
  
  return analyzedArticles;
}

/**
 * Store analyzed articles in Cloudflare KV
 * @param {Object} env - Environment variables
 * @param {Array} newArticles - New analyzed articles
 * @returns {Promise<void>}
 */
async function storeInKV(env, newArticles) {
  const timestamp = Date.now();
  
  // Merge with existing articles to maintain history
  let allArticles = [...newArticles];
  
  try {
    const existingData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY, { type: 'json' });
    if (existingData && existingData.articles) {
      // Keep existing articles (up to a reasonable limit to avoid KV size issues)
      const existingArticles = existingData.articles.slice(0, MAX_STORED_ARTICLES - newArticles.length);
      allArticles = [...newArticles, ...existingArticles];
      console.log(`Merged ${newArticles.length} new articles with ${existingArticles.length} existing articles`);
    }
  } catch (error) {
    console.log('No existing data to merge:', error.message);
  }
  
  // Calculate sentiment distribution
  const sentimentCounts = {
    positive: 0,
    negative: 0,
    neutral: 0
  };
  
  allArticles.forEach(article => {
    const sentiment = article.sentiment || 'neutral';
    sentimentCounts[sentiment] = (sentimentCounts[sentiment] || 0) + 1;
  });
  
  const finalData = {
    articles: allArticles,
    totalArticles: allArticles.length,
    lastUpdatedExternal: timestamp,
    sentimentCounts: sentimentCounts
  };
  
  await env.CRYPTO_NEWS_CACHE.put(KV_KEY, JSON.stringify(finalData));
  console.log(`Stored ${allArticles.length} articles in KV under key: ${KV_KEY}`);
}

/**
 * Main scheduled event handler
 * @param {Event} event - Scheduled event
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 */
async function handleScheduled(event, env, ctx) {
  console.log('=== Bitcoin News Updater Cron Job Started ===');
  console.log(`Execution time: ${new Date().toISOString()}`);
  
  try {
    // Stage 1: Aggregate articles
    const articles = await aggregateArticles(env);
    
    if (articles.length === 0) {
      console.log('No new articles to process');
      return;
    }
    
    // Stage 2: Analyze sentiment
    const analyzedArticles = await analyzeArticles(env, articles);
    
    // Stage 3: Store in KV
    await storeInKV(env, analyzedArticles);
    
    console.log('=== Bitcoin News Updater Cron Job Completed Successfully ===');
  } catch (error) {
    console.error('=== Bitcoin News Updater Cron Job Failed ===');
    console.error('Error:', error);
    throw error;
  }
}

export default {
  async scheduled(event, env, ctx) {
    // Use waitUntil to ensure the job completes even if it takes time
    ctx.waitUntil(handleScheduled(event, env, ctx));
  }
};
