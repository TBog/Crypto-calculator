/**
 * Scheduled Cloudflare Worker for Bitcoin News Aggregation & Analysis
 * 
 * This worker runs on a cron schedule (hourly) to:
 * 1. Fetch Bitcoin articles from configured news provider (NewsData.io or APITube)
 * 2. Normalize articles to standard format
 * 3. Store enriched data in Cloudflare KV for fast retrieval
 * 
 * Provider selection via NEWS_PROVIDER environment variable:
 * - 'newsdata' = NewsData.io (default, requires sentiment analysis)
 * - 'apitube' = APITube (includes sentiment)
 * 
 * This approach optimizes API credit usage by:
 * - Running on a schedule (not per-request)
 * - Early-exit when hitting known articles (stops fetching old data)
 * - Using separate ID index for fast deduplication
 */

import { createNewsProvider, getArticleId } from '../shared/news-providers.js';
import { getNewsUpdaterConfig } from '../shared/constants.js';

/**
 * Fetch and aggregate articles with early-exit optimization
 * Stops pagination immediately when a known article is encountered
 * @param {Object} env - Environment variables
 * @param {Set} knownIds - Set of known article IDs for deduplication
 * @param {Object} config - Configuration values
 * @returns {Promise<Array>} Array of new articles
 */
async function aggregateArticles(env, knownIds, config) {
  // Create provider based on environment configuration
  const provider = createNewsProvider(env);
  
  let newArticles = [];
  let nextPage = null;
  let pageCount = 0;
  let creditsUsed = 0;
  let earlyExitTriggered = false;
  
  console.log(`Starting article aggregation with ${provider.name}...`);
  console.log(`Known article IDs: ${knownIds.size}`);
  
  // Pagination loop with early exit
  do {
    try {
      console.log(`Fetching page ${pageCount + 1}...`);
      const pageData = await provider.fetchPage(nextPage);
      creditsUsed++;
      
      // Check each article in this page
      for (const article of pageData.articles) {
        const articleId = getArticleId(article);
        
        if (!articleId) {
          console.warn('Article missing ID, skipping');
          continue;
        }
        
        // Early exit: If we hit a known article, stop immediately
        if (knownIds.has(articleId)) {
          if (!earlyExitTriggered)
          {
            console.log(`Early exit triggered: Found known article "${article.title?.substring(0, 50)}..."`);
            earlyExitTriggered = true;
          }
          continue;
        }
        
        // Normalize and add new article to collection
        const normalizedArticle = provider.normalizeArticle(article);
        newArticles.push(normalizedArticle);
        knownIds.add(articleId);
      }
      
      // Break out of pagination loop if early exit was triggered
      if (earlyExitTriggered) {
        console.log(`Stopping pagination due to early exit after ${pageCount} page(s)`);
        break;
      }
      
      console.log(`Page ${pageCount + 1}: ${pageData.articles.length} total, ${newArticles.length} new articles so far`);
      
      nextPage = pageData.nextPage;
      pageCount++;
      
      // Stop if we've reached max pages
      if (pageCount >= config.MAX_PAGES) {
        console.log(`Stopping: Max pages (${config.MAX_PAGES}) reached`);
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
  } while (nextPage && pageCount < config.MAX_PAGES);
  
  console.log(`Aggregation complete: ${newArticles.length} new articles, ${creditsUsed} credits used`);
  
  return newArticles;
}

/**
 * Mark articles as needing processing
 * Instead of processing all articles immediately (which hits subrequest limits),
 * we mark them with flags indicating what processing is needed.
 * A separate cron worker will process them incrementally.
 * 
 * Articles from providers with built-in sentiment (like APITube) will have
 * needsSentiment set to false, while others will need AI sentiment analysis.
 * 
 * @param {Array} articles - Array of articles to mark for processing
 * @returns {Promise<Array>} Articles marked with processing flags
 */
async function markArticlesForProcessing(articles) {
  console.log(`Marking ${articles.length} articles for processing...`);
  
  // Articles are already normalized by the provider with appropriate flags
  // (needsSentiment, needsSummary, sentiment if available)
  // No additional marking needed - just log for tracking
  
  const needsSentimentCount = articles.filter(a => a.needsSentiment).length;
  const hasSentimentCount = articles.filter(a => !a.needsSentiment && a.sentiment).length;
  
  console.log(`- ${needsSentimentCount} articles need sentiment analysis`);
  console.log(`- ${hasSentimentCount} articles already have sentiment`);
  console.log(`- ${articles.length} articles need AI summary`);
  
  return articles;
}

/**
 * Store analyzed articles in Cloudflare KV using two-key optimization
 * Write #1: Update full news payload (BTC_ANALYZED_NEWS)
 * Write #2: Update ID index (BTC_ID_INDEX)
 * @param {Object} env - Environment variables
 * @param {Array} newArticles - New analyzed articles
 * @param {Object} config - Configuration values
 * @returns {Promise<void>}
 */
async function storeInKV(env, newArticles, config) {
  const timestamp = Date.now();
  
  // Merge with existing articles to maintain history
  let allArticles = [...newArticles];
  
  try {
    const existingData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_NEWS, { type: 'json' });
    if (existingData && existingData.articles) {
      // Keep existing articles (up to a reasonable limit to avoid KV size issues)
      const existingArticles = existingData.articles.slice(0, config.MAX_STORED_ARTICLES - newArticles.length);
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
    const sentiment = article.sentiment;
    // Only count if sentiment is a string value (not true flag for pending processing)
    if (typeof sentiment === 'string' && ['positive', 'negative', 'neutral'].includes(sentiment)) {
      sentimentCounts[sentiment] = (sentimentCounts[sentiment] || 0) + 1;
    }
  });
  
  const finalData = {
    articles: allArticles,
    totalArticles: allArticles.length,
    lastUpdatedExternal: timestamp,
    sentimentCounts: sentimentCounts
  };
  
  // Write #1: Update full news payload
  await env.CRYPTO_NEWS_CACHE.put(config.KV_KEY_NEWS, JSON.stringify(finalData));
  console.log(`Write #1: Stored ${allArticles.length} articles in KV under key: ${config.KV_KEY_NEWS}`);
  
  // Write #2: Update ID index - MUST match the articles actually stored
  // Extract IDs from the articles we're storing using consistent helper function
  const storedArticleIds = allArticles
    .map(article => getArticleId(article))
    .filter(id => id); // Remove any null/undefined IDs
  
  await env.CRYPTO_NEWS_CACHE.put(
    config.KV_KEY_IDS, 
    JSON.stringify(storedArticleIds),
    {
      expirationTtl: config.ID_INDEX_TTL
    }
  );
  console.log(`Write #2: Stored ${storedArticleIds.length} article IDs in index under key: ${config.KV_KEY_IDS}`);
}

/**
 * Main scheduled event handler with optimized three-phase pipeline
 * Phase 1: Preparation - Read ID index from KV
 * Phase 2: Fetch & Early Exit - Aggregate new articles, stop when hitting known article
 * Phase 3: KV Update - Write both full payload and ID index (2 writes)
 * @param {Event} event - Scheduled event
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 */
async function handleScheduled(event, env, ctx) {
  console.log('=== Bitcoin News Updater Cron Job Started ===');
  console.log(`Execution time: ${new Date().toISOString()}`);
  
  // Load configuration with environment variable overrides
  const config = getNewsUpdaterConfig(env);
  
  try {
    // Phase 1: Preparation - Read ID index
    console.log('Phase 1: Reading ID index from KV...');
    let knownIds = new Set();
    
    try {
      const idIndexData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_IDS, { type: 'json' });
      if (idIndexData && Array.isArray(idIndexData)) {
        knownIds = new Set(idIndexData);
        console.log(`Loaded ${knownIds.size} known article IDs from index`);
      } else {
        console.log('No existing ID index found, starting fresh');
      }
    } catch (error) {
      console.log('Error reading ID index, starting fresh:', error.message);
    }
    
    // Phase 2: Optimized Fetch with Early Exit
    console.log('Phase 2: Fetching articles with early-exit optimization...');
    const newArticles = await aggregateArticles(env, knownIds, config);
    
    if (newArticles.length === 0) {
      console.log('No new articles to process, skipping analysis and KV update');
      console.log('=== Bitcoin News Updater Cron Job Completed (No Updates) ===');
      return;
    }
    
    // Phase 2: Mark articles for later processing
    // This avoids hitting subrequest limits in the producer
    console.log('Phase 2: Marking articles for AI processing...');
    const markedArticles = await markArticlesForProcessing(newArticles);
    
    // Phase 3: KV Update (exactly 2 writes)
    console.log('Phase 3: Updating KV (2 writes)...');
    await storeInKV(env, markedArticles, config);
    
    console.log('=== Bitcoin News Updater Cron Job Completed Successfully ===');
    console.log(`Queued ${newArticles.length} articles for AI processing by consumer worker`);
  } catch (error) {
    console.error('=== Bitcoin News Updater Cron Job Failed ===');
    console.error('Error:', error);
    throw error;
  }
}

/**
 * Handle HTTP fetch requests to provide cache statistics
 * When called via HTTP (not scheduled), returns JSON with cache info:
 * - Number of articles stored
 * - List of article IDs
 * - Latest 10 articles
 * @param {Request} request - HTTP request
 * @param {Object} env - Environment variables
 * @returns {Promise<Response>} JSON response with cache statistics
 */
async function handleFetch(request, env) {
  const config = getNewsUpdaterConfig(env);
  
  try {
    // Read both KV keys
    const [newsData, idIndexData] = await Promise.all([
      env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_NEWS, { type: 'json' }),
      env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_IDS, { type: 'json' })
    ]);
    
    if (!newsData || !newsData.articles) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No cached articles found',
        totalArticles: 0,
        articleIds: [],
        latestArticles: []
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // Prepare response data
    const articleIds = idIndexData && Array.isArray(idIndexData) ? idIndexData : [];
    const latestArticles = newsData.articles.slice(0, 10).map(article => ({
      ...article,
      id: getArticleId(article),
    }));
    
    const response = {
      success: true,
      totalArticles: newsData.totalArticles || newsData.articles.length,
      lastUpdated: newsData.lastUpdatedExternal,
      lastUpdatedDate: new Date(newsData.lastUpdatedExternal).toISOString(),
      sentimentCounts: newsData.sentimentCounts || { positive: 0, negative: 0, neutral: 0 },
      articleIds: articleIds,
      latestArticles: latestArticles
    };
    
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('Error fetching cache statistics:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      totalArticles: 0,
      articleIds: [],
      latestArticles: []
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

export default {
  async scheduled(event, env, ctx) {
    // Use waitUntil to ensure the job completes even if it takes time
    ctx.waitUntil(handleScheduled(event, env, ctx));
  },
  
  async fetch(request, env, ctx) {
    // Handle HTTP requests to provide cache statistics
    return handleFetch(request, env);
  }
};
