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
 * Migrate legacy BTC_ANALYZED_NEWS data to individual article storage
 * This function is called during the transition period to migrate old data
 * @param {Object} env - Environment variables
 * @param {Object} config - Configuration values
 * @returns {Promise<Array>} Array of migrated article IDs
 */
async function migrateLegacyData(env, config) {
  console.log('Checking for legacy BTC_ANALYZED_NEWS data to migrate...');
  
  try {
    const legacyData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_NEWS, { type: 'json' });
    
    if (!legacyData || !legacyData.articles || legacyData.articles.length === 0) {
      console.log('No legacy data found to migrate');
      return [];
    }
    
    console.log(`Found ${legacyData.articles.length} articles in legacy format, migrating...`);
    
    // Store each legacy article individually
    const writePromises = legacyData.articles.map(article => {
      const articleId = getArticleId(article);
      if (!articleId) return Promise.resolve();
      
      const articleKey = `article:${articleId}`;
      return env.CRYPTO_NEWS_CACHE.put(articleKey, JSON.stringify(article), {
        expirationTtl: config.ID_INDEX_TTL
      });
    });
    
    // Use allSettled so we can detect partial failures explicitly
    const writeResults = await Promise.allSettled(writePromises.filter(p => p));
    const failedWrites = writeResults.filter(result => result.status === 'rejected');
    
    if (failedWrites.length > 0) {
      console.error(`✗ Failed to migrate ${failedWrites.length} legacy articles`);
      // Keep legacy key intact by treating this as a migration failure
      throw new Error('Legacy data migration failed for some articles');
    }
    
    // Extract IDs for the index (in original order - latest first)
    const migratedIds = legacyData.articles
      .map(article => getArticleId(article))
      .filter(id => id);
    
    console.log(`✓ Migrated ${migratedIds.length} articles to individual storage`);
    
    // Delete the legacy key after successful migration
    await env.CRYPTO_NEWS_CACHE.delete(config.KV_KEY_NEWS);
    console.log('✓ Deleted legacy BTC_ANALYZED_NEWS key');
    
    return migratedIds;
  } catch (error) {
    console.error('Error migrating legacy data:', error.message);
    return [];
  }
}

/**
 * Add new articles to the pending list for processing
 * The updater only writes to the pending list, not directly to article storage
 * The processor will handle writing articles to KV after processing
 * @param {Object} kv - KV storage interface (allows mocking for tests)
 * @param {Array} newArticles - New articles to be processed
 * @param {Object} config - Configuration values
 * @returns {Promise<number>} Number of articles in pending list after update
 */
async function addToPendingList(kv, newArticles, config) {
  // Extract IDs from new articles
  const newArticleIds = newArticles
    .map(article => getArticleId(article))
    .filter(id => id);
  
  if (newArticleIds.length === 0) {
    console.log('No new articles to add to pending list');
    return 0;
  }
  
  // Read existing pending list
  let pendingList = [];
  try {
    const pendingData = await kv.get(config.KV_KEY_PENDING, { type: 'json' });
    if (pendingData && Array.isArray(pendingData)) {
      pendingList = pendingData;
      console.log(`Found ${pendingList.length} articles in pending list`);
    }
  } catch (error) {
    console.log('No existing pending list found, starting fresh');
  }
  
  // Read checkpoint to see what's been processed
  let processedIds = new Set();
  try {
    const checkpoint = await kv.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
    if (checkpoint && checkpoint.processedIds && Array.isArray(checkpoint.processedIds)) {
      processedIds = new Set(checkpoint.processedIds);
      console.log(`Checkpoint shows ${processedIds.size} articles processed`);
    }
  } catch (error) {
    console.log('No checkpoint found');
  }
  
  // Create a map of article ID to article data for new articles
  const articleMap = new Map();
  newArticles.forEach(article => {
    const id = getArticleId(article);
    if (id) {
      articleMap.set(id, article);
    }
  });
  
  // Merge: Add new articles that aren't already in pending list or processed
  const pendingIdSet = new Set(pendingList.map(item => item.id));
  const articlesToAdd = [];
  
  for (const id of newArticleIds) {
    if (!pendingIdSet.has(id) && !processedIds.has(id)) {
      articlesToAdd.push({
        id,
        article: articleMap.get(id),
        addedAt: Date.now()
      });
    }
  }
  
  // Add new articles to the beginning of the pending list (latest first)
  const mergedPendingList = [...articlesToAdd, ...pendingList];
  
  // Trim pending list based on checkpoint (remove processed articles)
  let trimmedPendingList = mergedPendingList.filter(item => !processedIds.has(item.id));
  
  // Limit pending list size to prevent unbounded growth
  const maxPendingSize = config.MAX_PENDING_LIST_SIZE || 500;
  if (trimmedPendingList.length > maxPendingSize) {
    console.log(`Pending list exceeds max size (${maxPendingSize}), trimming older articles`);
    trimmedPendingList = trimmedPendingList.slice(0, maxPendingSize);
  }
  
  console.log(`Adding ${articlesToAdd.length} new articles to pending list`);
  console.log(`Trimmed ${mergedPendingList.length - trimmedPendingList.length} processed articles`);
  
  // Write updated pending list to KV
  await kv.put(
    config.KV_KEY_PENDING,
    JSON.stringify(trimmedPendingList),
    {
      expirationTtl: config.ID_INDEX_TTL
    }
  );
  
  console.log(`✓ Updated pending list with ${trimmedPendingList.length} total articles (${articlesToAdd.length} new)`);
  return trimmedPendingList.length;
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
    
    // Phase 3: Add to Pending List (1 write)
    console.log('Phase 3: Adding articles to pending list...');
    await addToPendingList(env.CRYPTO_NEWS_CACHE, markedArticles, config);
    
    console.log('=== Bitcoin News Updater Cron Job Completed Successfully ===');
    console.log(`Added ${newArticles.length} articles to pending list for processing by consumer worker`);
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
 * - Latest 10 articles (fetched individually from KV)
 * @param {Request} request - HTTP request
 * @param {Object} env - Environment variables
 * @returns {Promise<Response>} JSON response with cache statistics
 */
async function handleFetch(request, env) {
  const config = getNewsUpdaterConfig(env);
  
  try {
    // Read ID index
    const idIndexData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_IDS, { type: 'json' });
    
    if (!idIndexData || !Array.isArray(idIndexData) || idIndexData.length === 0) {
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
    
    // Fetch latest 10 articles individually
    const latestIds = idIndexData.slice(0, 10);
    const articlePromises = latestIds.map(id => 
      env.CRYPTO_NEWS_CACHE.get(`article:${id}`, { type: 'json' })
    );
    const latestArticlesData = await Promise.all(articlePromises);
    
    // Filter out any null results and add ID field
    const latestArticles = latestArticlesData
      .filter(article => article !== null)
      .map(article => ({
        ...article,
        id: getArticleId(article),
      }));
    
    const response = {
      success: true,
      totalArticles: idIndexData.length,
      articleIds: idIndexData,
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

// Export for testing
export { addToPendingList };

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
