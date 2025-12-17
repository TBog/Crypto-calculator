/**
 * Scheduled Cloudflare Worker for Bitcoin News Aggregation & Analysis
 * 
 * This worker runs on a cron schedule (hourly) to:
 * 1. Fetch Bitcoin articles from NewsData.io using pagination with early-exit optimization
 * 2. Analyze sentiment of each article using Gemini API
 * 3. Store enriched data in Cloudflare KV for fast retrieval
 * 
 * This approach optimizes API credit usage by:
 * - Running on a schedule (not per-request)
 * - Early-exit when hitting known articles (stops fetching old data)
 * - Using separate ID index for fast deduplication
 */

// KV keys for optimized storage
const KV_KEY_NEWS = 'BTC_ANALYZED_NEWS';  // Full articles payload
const KV_KEY_IDS = 'BTC_ID_INDEX';         // ID index for deduplication

// Maximum articles to keep in KV storage (prevent size issues)
const MAX_STORED_ARTICLES = 500;

// Maximum number of pages to fetch (safety limit)
const MAX_PAGES = 15;

// ID index TTL in seconds (30 days)
const ID_INDEX_TTL = 60 * 60 * 24 * 30;

/**
 * Get article ID from article object
 * Uses article_id as primary identifier, falls back to link
 * @param {Object} article - Article object
 * @returns {string|null} Article ID or null if not available
 */
function getArticleId(article) {
  return article.article_id || article.link || null;
}

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
 * Fetch and aggregate articles with early-exit optimization
 * Stops pagination immediately when a known article is encountered
 * @param {Object} env - Environment variables
 * @param {Set} knownIds - Set of known article IDs for deduplication
 * @returns {Promise<Array>} Array of new articles
 */
async function aggregateArticles(env, knownIds) {
  const apiKey = env.NEWSDATA_API_KEY;
  if (!apiKey) {
    throw new Error('NEWSDATA_API_KEY not configured');
  }
  
  let newArticles = [];
  let nextPage = null;
  let pageCount = 0;
  let creditsUsed = 0;
  let earlyExitTriggered = false;
  
  console.log('Starting article aggregation with early-exit optimization...');
  console.log(`Known article IDs: ${knownIds.size}`);
  
  // Pagination loop with early exit
  do {
    try {
      console.log(`Fetching page ${pageCount + 1}...`);
      const pageData = await fetchNewsPage(apiKey, nextPage);
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
          console.log(`Early exit triggered: Found known article "${article.title?.substring(0, 50)}..."`);
          earlyExitTriggered = true;
          break;
        }
        
        // Add new article to collection
        newArticles.push(article);
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
      if (pageCount >= MAX_PAGES) {
        console.log(`Stopping: Max pages (${MAX_PAGES}) reached`);
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
  
  console.log(`Aggregation complete: ${newArticles.length} new articles, ${creditsUsed} credits used`);
  
  return newArticles;
}

/**
 * Queue articles for asynchronous processing
 * Instead of analyzing articles in this worker (which hits subrequest limits),
 * we push them to a Cloudflare Queue where each article is processed independently
 * with its own fresh subrequest budget.
 * 
 * @param {Object} env - Environment variables (includes ARTICLE_QUEUE binding)
 * @param {Array} articles - Array of articles to queue for processing
 * @returns {Promise<Array>} Articles as-is (without sentiment/summary - added by consumer)
 */
async function queueArticlesForProcessing(env, articles) {
  console.log(`Queueing ${articles.length} articles for asynchronous processing...`);
  
  // Send articles to queue in batches to avoid hitting queue limits
  // Batch size of 100 is chosen based on:
  // - Cloudflare Queues default batch limit (100 messages)
  // - Balance between throughput and memory usage
  // - Allows efficient queuing without overwhelming the queue service
  const BATCH_SIZE = 100;
  let queuedCount = 0;
  
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    
    try {
      // Send batch to queue
      await env.ARTICLE_QUEUE.sendBatch(
        batch.map(article => ({
          body: article
        }))
      );
      
      queuedCount += batch.length;
      console.log(`Queued batch: ${queuedCount}/${articles.length} articles`);
    } catch (error) {
      console.error(`Error queueing batch at index ${i}:`, error);
      // Continue with next batch even if one fails
    }
  }
  
  console.log(`Successfully queued ${queuedCount} articles for processing`);
  console.log('Note: Articles will be enriched with sentiment and AI summaries by the consumer worker');
  
  // Return articles as-is without sentiment/summary
  // The consumer worker will update them in KV as they're processed
  return articles.map(article => ({
    ...article,
    sentiment: 'pending',  // Placeholder until consumer processes it
    queuedAt: Date.now()
  }));
}

/**
 * Store analyzed articles in Cloudflare KV using two-key optimization
 * Write #1: Update full news payload (BTC_ANALYZED_NEWS)
 * Write #2: Update ID index (BTC_ID_INDEX)
 * @param {Object} env - Environment variables
 * @param {Array} newArticles - New analyzed articles
 * @returns {Promise<void>}
 */
async function storeInKV(env, newArticles) {
  const timestamp = Date.now();
  
  // Merge with existing articles to maintain history
  let allArticles = [...newArticles];
  
  try {
    const existingData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY_NEWS, { type: 'json' });
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
  
  // Write #1: Update full news payload
  await env.CRYPTO_NEWS_CACHE.put(KV_KEY_NEWS, JSON.stringify(finalData));
  console.log(`Write #1: Stored ${allArticles.length} articles in KV under key: ${KV_KEY_NEWS}`);
  
  // Write #2: Update ID index - MUST match the articles actually stored
  // Extract IDs from the articles we're storing using consistent helper function
  const storedArticleIds = allArticles
    .map(article => getArticleId(article))
    .filter(id => id); // Remove any null/undefined IDs
  
  await env.CRYPTO_NEWS_CACHE.put(
    KV_KEY_IDS, 
    JSON.stringify(storedArticleIds),
    {
      expirationTtl: ID_INDEX_TTL
    }
  );
  console.log(`Write #2: Stored ${storedArticleIds.length} article IDs in index under key: ${KV_KEY_IDS}`);
  console.log(`ID index now matches the ${allArticles.length} articles stored in payload`);
  console.log('Total KV writes this run: 2');
}

/**
 * Main scheduled event handler with queue-based architecture
 * Phase 1: Preparation - Read ID index from KV
 * Phase 2: Fetch & Early Exit - Aggregate new articles, stop when hitting known article
 * Phase 3: Queue articles for processing - Send to Cloudflare Queue
 * Phase 4: Store articles in KV - Articles initially stored with "pending" sentiment
 * 
 * Note: The consumer worker will update articles with sentiment and AI summaries asynchronously
 * 
 * @param {Event} event - Scheduled event
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 */
async function handleScheduled(event, env, ctx) {
  console.log('=== Bitcoin News Updater Cron Job Started ===');
  console.log(`Execution time: ${new Date().toISOString()}`);
  
  try {
    // Phase 1: Preparation - Read ID index
    console.log('Phase 1: Reading ID index from KV...');
    let knownIds = new Set();
    
    try {
      const idIndexData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY_IDS, { type: 'json' });
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
    const newArticles = await aggregateArticles(env, knownIds);
    
    if (newArticles.length === 0) {
      console.log('No new articles to process');
      console.log('=== Bitcoin News Updater Cron Job Completed (No Updates) ===');
      return;
    }
    
    // Phase 3: Queue articles for asynchronous processing
    console.log('Phase 3: Queueing articles for AI processing...');
    const queuedArticles = await queueArticlesForProcessing(env, newArticles);
    
    // Phase 4: Store articles in KV with "pending" sentiment
    // The consumer worker will update them with actual sentiment and AI summaries
    console.log('Phase 4: Storing articles in KV (pending AI enrichment)...');
    await storeInKV(env, queuedArticles);
    
    console.log('=== Bitcoin News Updater Cron Job Completed Successfully ===');
    console.log(`Queued ${newArticles.length} articles for AI processing`);
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
  try {
    // Read both KV keys
    const [newsData, idIndexData] = await Promise.all([
      env.CRYPTO_NEWS_CACHE.get(KV_KEY_NEWS, { type: 'json' }),
      env.CRYPTO_NEWS_CACHE.get(KV_KEY_IDS, { type: 'json' })
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
      id: getArticleId(article),
      title: article.title,
      source: article.source_name || article.source_id,
      sentiment: article.sentiment,
      pubDate: article.pubDate,
      link: article.link,
      description: article.description,
      ...(article.aiSummary && { aiSummary: article.aiSummary })
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
    
    return new Response(JSON.stringify(response, null, 2), {
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
