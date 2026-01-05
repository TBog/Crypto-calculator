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
 * Add new articles to D1 database
 * 
 * D1-BASED BEHAVIOR: The updater writes articles directly to D1 database,
 * making them immediately queryable. No KV writes occur at this stage.
 * 
 * @param {D1Database} db - D1 database instance
 * @param {Array} newArticles - New articles to be added
 * @param {Object} config - Configuration values
 * @returns {Promise<Object>} Result with inserted and skipped counts
 */
async function addArticlesToD1(db, newArticles, config) {
  if (newArticles.length === 0) {
    console.log('No new articles to add to D1');
    return { inserted: 0, skipped: 0 };
  }
  
  console.log(`Inserting ${newArticles.length} articles into D1...`);
  
  // Use batch insert from d1-utils (handles INSERT OR IGNORE)
  const result = await insertArticlesBatch(db, newArticles);
  
  console.log(`✓ D1 insert complete: ${result.inserted} new, ${result.skipped} duplicates`);
  
  return result;
}

/**
 * Main scheduled event handler with D1-optimized pipeline
 * Phase 1: Preparation - Read known article IDs from D1
 * Phase 2: Fetch & Early Exit - Aggregate new articles, stop when hitting known article
 * Phase 3: D1 Insert - Write new articles to D1 (0 KV writes at this stage)
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
    // Phase 1: Preparation - Read known article IDs from D1
    console.log('Phase 1: Reading known article IDs from D1...');
    
    // Get article IDs from D1 for deduplication
    const knownIds = await getArticleIds(env.DB, config.MAX_STORED_ARTICLES);
    console.log(`Loaded ${knownIds.size} article IDs from D1`);
    
    // Phase 2: Optimized Fetch with Early Exit
    console.log('Phase 2: Fetching articles with early-exit optimization...');
    const newArticles = await aggregateArticles(env, knownIds, config);
    
    if (newArticles.length === 0) {
      console.log('No new articles to process, skipping D1 insert');
      console.log('=== Bitcoin News Updater Cron Job Completed (No Updates) ===');
      return;
    }
    
    // Mark articles for later processing
    console.log('Phase 2: Marking articles for AI processing...');
    const markedArticles = await markArticlesForProcessing(newArticles);
    
    // Phase 3: Insert into D1 (0 KV writes!)
    console.log('Phase 3: Adding articles to D1 database...');
    const result = await addArticlesToD1(env.DB, markedArticles, config);
    
    console.log('=== Bitcoin News Updater Cron Job Completed Successfully ===');
    console.log(`Inserted ${result.inserted} new articles into D1 (${result.skipped} duplicates skipped)`);
    console.log(`Articles are ready for processing by processor worker`);
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
