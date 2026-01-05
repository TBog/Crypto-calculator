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
import { 
  insertArticlesBatch, 
  getArticleIds, 
  rowsToArticles 
} from '../shared/d1-utils.js';

/**
 * Fetch and aggregate articles with early-exit optimization
 * Stops pagination immediately when a known article is encountered
 * 
 * IMPORTANT: This function assumes that articles from the provider are sorted
 * by published date (newest first). This assumption allows us to use early-exit
 * optimization - once we encounter a known article, we can stop fetching because
 * all subsequent articles are older and likely already known.
 * 
 * Both NewsData.io and APITube APIs return articles sorted by published date
 * in descending order (newest first) by default.
 * 
 * @param {Object} env - Environment variables
 * @param {Set} knownIds - Set of known article IDs for deduplication (includes pending, checkpoint, and ID index)
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
        // This works because articles are sorted by published date (newest first)
        if (knownIds.has(articleId)) {
          if (!earlyExitTriggered) {
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
        console.log(`Stopping pagination due to early exit after ${pageCount + 1} page(s)`);
        break;
      }
      
      console.log(`Page ${pageCount + 1}: ${pageData.articles.length} total, ${newArticles.length} new articles so far`);
      
      // Stop pagination if the current page is empty
      if (pageData.articles.length === 0) {
        console.log('Stopping pagination: empty page returned');
        break;
      }
      
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
 * Add new articles to both KV and D1
 * 
 * HYBRID BEHAVIOR: The updater writes articles to both storages:
 * - KV: Individual articles by ID + article ID list (updater has exclusive write access)
 * - D1: Full articles for processing
 * 
 * This ensures API worker can read from KV only, while processor works with D1.
 * 
 * @param {D1Database} db - D1 database instance
 * @param {Object} kv - KV namespace
 * @param {Array} newArticles - New articles to be added
 * @param {Object} config - Configuration values
 * @returns {Promise<Object>} Result with inserted and skipped counts
 */
async function addArticlesToKVAndD1(db, kv, newArticles, config) {
  if (newArticles.length === 0) {
    console.log('No new articles to add');
    return { inserted: 0, skipped: 0 };
  }
  
  console.log(`Adding ${newArticles.length} articles to KV and D1...`);
  
  // Step 1: Insert into D1 (handles INSERT OR IGNORE for duplicates)
  const d1Result = await insertArticlesBatch(db, newArticles);
  console.log(`✓ D1 insert: ${d1Result.inserted} new, ${d1Result.skipped} duplicates`);
  
  // Step 2: Get current KV article ID list
  let existingIds = [];
  try {
    const idData = await kv.get(config.KV_KEY_IDS, { type: 'json' });
    if (idData && Array.isArray(idData)) {
      existingIds = idData;
      console.log(`Found ${existingIds.length} existing article IDs in KV`);
    }
  } catch (error) {
    console.log('No existing ID list in KV, starting fresh');
  }
  
  const existingIdSet = new Set(existingIds);
  
  // Step 3: Write new articles to KV individually (only truly new ones)
  const newArticleIds = [];
  const kvWritePromises = [];
  
  for (const article of newArticles) {
    const articleId = getArticleId(article);
    if (!articleId) continue;
    
    if (!existingIdSet.has(articleId)) {
      newArticleIds.push(articleId);
      const articleKey = `article:${articleId}`;
      kvWritePromises.push(
        kv.put(articleKey, JSON.stringify(article), {
          expirationTtl: config.ID_INDEX_TTL
        })
      );
    }
  }
  
  if (kvWritePromises.length > 0) {
    const kvResults = await Promise.allSettled(kvWritePromises);
    const failedWrites = kvResults.filter(r => r.status === 'rejected');
    
    if (failedWrites.length > 0) {
      console.error(`✗ Failed to write ${failedWrites.length} articles to KV`);
      throw new Error(`KV article writes failed for ${failedWrites.length} articles`);
    }
    
    console.log(`✓ Wrote ${kvWritePromises.length} new articles to KV`);
  }
  
  // Step 4: Update KV article ID list (prepend new IDs, newest first)
  const updatedIdList = [...newArticleIds, ...existingIds];
  const trimmedIdList = updatedIdList.slice(0, config.MAX_STORED_ARTICLES);
  
  await kv.put(
    config.KV_KEY_IDS,
    JSON.stringify(trimmedIdList),
    {
      expirationTtl: config.ID_INDEX_TTL
    }
  );
  console.log(`✓ Updated KV ID list with ${trimmedIdList.length} total articles`);
  
  return { inserted: d1Result.inserted, skipped: d1Result.skipped, kvWrites: kvWritePromises.length + 1 };
}

/**
 * Trim D1 articles that are not in the KV article ID list
 * The updater is responsible for maintaining consistency between KV and D1.
 * Articles not in KV ID list are removed from D1.
 * 
 * @param {D1Database} db - D1 database instance
 * @param {Object} kv - KV namespace
 * @param {Object} config - Configuration values
 * @returns {Promise<number>} Number of articles deleted from D1
 */
async function trimD1Articles(db, kv, config) {
  console.log('Checking if D1 trimming is needed...');
  
  // Get KV article ID list (source of truth for what should exist)
  let kvIds = [];
  try {
    const idData = await kv.get(config.KV_KEY_IDS, { type: 'json' });
    if (idData && Array.isArray(idData)) {
      kvIds = idData;
    }
  } catch (error) {
    console.log('No KV ID list found, skipping trim');
    return 0;
  }
  
  if (kvIds.length === 0) {
    console.log('KV ID list is empty, skipping trim');
    return 0;
  }
  
  // Get all D1 article IDs
  const d1Ids = await getArticleIds(db, 10000); // Get all IDs
  
  if (d1Ids.size === 0) {
    console.log('No articles in D1, skipping trim');
    return 0;
  }
  
  // Find articles in D1 that are not in KV ID list
  const kvIdSet = new Set(kvIds);
  const idsToDelete = Array.from(d1Ids).filter(id => !kvIdSet.has(id));
  
  if (idsToDelete.length === 0) {
    console.log('No articles to trim from D1');
    return 0;
  }
  
  console.log(`Trimming ${idsToDelete.length} articles from D1 that are not in KV ID list...`);
  
  // Delete articles in batches (SQLite has a limit on IN clause)
  const batchSize = 500;
  let totalDeleted = 0;
  
  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    
    const result = await db.prepare(
      `DELETE FROM articles WHERE id IN (${placeholders})`
    ).bind(...batch).run();
    
    totalDeleted += result.meta?.changes || 0;
  }
  
  console.log(`✓ Trimmed ${totalDeleted} articles from D1`);
  return totalDeleted;
}

/**
 * Main scheduled event handler with KV+D1 hybrid pipeline
 * Phase 1: Preparation - Read known article IDs from KV (source of truth)
 * Phase 2: Fetch & Early Exit - Aggregate new articles, stop when hitting known article
 * Phase 3: Write to KV and D1 - Updater has exclusive write access to KV article IDs
 * Phase 4: Trim D1 - Remove articles not in KV ID list
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
    // Phase 1: Preparation - Read known article IDs from KV (source of truth)
    console.log('Phase 1: Reading known article IDs from KV...');
    
    let knownIds = new Set();
    try {
      const idData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_IDS, { type: 'json' });
      if (idData && Array.isArray(idData)) {
        idData.forEach(id => knownIds.add(id));
        console.log(`Loaded ${idData.length} article IDs from KV`);
      }
    } catch (error) {
      console.log('No existing ID list in KV');
    }
    
    // Phase 2: Optimized Fetch with Early Exit
    console.log('Phase 2: Fetching articles with early-exit optimization...');
    const newArticles = await aggregateArticles(env, knownIds, config);
    
    if (newArticles.length === 0) {
      console.log('No new articles found, proceeding to trim check');
    } else {
      // Mark articles for later processing
      console.log('Phase 2: Marking articles for AI processing...');
      const markedArticles = await markArticlesForProcessing(newArticles);
      
      // Phase 3: Write to both KV and D1
      console.log('Phase 3: Adding articles to KV and D1...');
      const result = await addArticlesToKVAndD1(env.DB, env.CRYPTO_NEWS_CACHE, markedArticles, config);
      
      console.log(`Added ${result.inserted} new articles (${result.skipped} duplicates, ${result.kvWrites} KV writes)`);
    }
    
    // Phase 4: Trim D1 articles not in KV ID list
    console.log('Phase 4: Trimming D1 articles...');
    const trimmed = await trimD1Articles(env.DB, env.CRYPTO_NEWS_CACHE, config);
    
    console.log('=== Bitcoin News Updater Cron Job Completed Successfully ===');
    if (newArticles.length > 0) {
      console.log(`Added ${newArticles.length} new articles to KV and D1`);
    }
    if (trimmed > 0) {
      console.log(`Trimmed ${trimmed} old articles from D1`);
    }
  } catch (error) {
    console.error('=== Bitcoin News Updater Cron Job Failed ===');
    console.error('Error:', error);
    throw error;
  }
}

/**
 * Handle HTTP fetch requests to provide database statistics
 * When called via HTTP (not scheduled), returns JSON with D1 stats:
 * - Number of articles stored
 * - Number of articles needing processing
 * - Latest 10 articles
 * @param {Request} request - HTTP request
 * @param {Object} env - Environment variables
 * @returns {Promise<Response>} JSON response with database statistics
 */
async function handleFetch(request, env) {
  const config = getNewsUpdaterConfig(env);
  
  try {
    // Get article counts from D1
    const countsResult = await env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN needsSentiment = 1 OR needsSummary = 1 THEN 1 ELSE 0 END) as needsProcessing,
        SUM(CASE WHEN processedAt IS NOT NULL THEN 1 ELSE 0 END) as processed
      FROM articles
    `).first();
    
    // Get latest 10 articles
    const articlesResult = await env.DB.prepare(`
      SELECT * FROM articles
      ORDER BY pubDate DESC
      LIMIT 10
    `).all();
    
    const latestArticles = rowsToArticles(articlesResult.results || []);
    
    const response = {
      success: true,
      totalArticles: countsResult?.total || 0,
      needsProcessing: countsResult?.needsProcessing || 0,
      processed: countsResult?.processed || 0,
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
    console.error('Error fetching database statistics:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      totalArticles: 0,
      needsProcessing: 0,
      processed: 0,
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
    // Handle HTTP requests to provide database statistics
    return handleFetch(request, env);
  }
};
