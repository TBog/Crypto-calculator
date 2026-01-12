/**
 * D1 Database Utilities
 * 
 * Shared functions for interacting with D1 database across all workers.
 * Provides a consistent interface for article storage and retrieval.
 */

import { getArticleId } from './news-providers.js';

/**
 * Insert a new article into D1 database
 * @param {D1Database} db - D1 database instance
 * @param {Object} article - Article object
 * @returns {Promise<void>}
 */
export async function insertArticle(db, article) {
  const id = getArticleId(article);
  const now = Date.now();
  
  await db.prepare(`
    INSERT INTO articles (
      id, title, description, link, pubDate, source, imageUrl,
      needsSentiment, needsSummary,
      sentiment, aiSummary,
      contentTimeout, summaryError, extractedContent, queuedAt,
      createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    article.title || '',
    article.description || null,
    article.link || null,
    article.pubDate || new Date().toISOString(),
    article.source || null,
    article.imageUrl || null,
    article.needsSentiment ? 1 : 0,
    article.needsSummary ? 1 : 0,
    article.sentiment || null,
    article.aiSummary || null,
    article.contentTimeout || 0,
    article.summaryError || null,
    article.extractedContent || null,
    article.queuedAt || now,
    now,
    now
  ).run();
}

/**
 * Insert multiple articles in a batch (using transaction for efficiency)
 * @param {D1Database} db - D1 database instance
 * @param {Array} articles - Array of article objects
 * @returns {Promise<Object>} Result with inserted and skipped counts
 */
export async function insertArticlesBatch(db, articles) {
  const now = Date.now();
  let inserted = 0;
  let skipped = 0;
  
  // Start a transaction for batch insert
  const statements = articles.map(article => {
    const id = getArticleId(article);
    
    return db.prepare(`
      INSERT OR IGNORE INTO articles (
        id, title, description, link, pubDate, source, imageUrl,
        needsSentiment, needsSummary,
        sentiment, aiSummary,
        contentTimeout, summaryError, extractedContent, queuedAt,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      article.title || '',
      article.description || null,
      article.link || null,
      article.pubDate || new Date().toISOString(),
      article.source || null,
      article.imageUrl || null,
      article.needsSentiment ? 1 : 0,
      article.needsSummary ? 1 : 0,
      article.sentiment || null,
      article.aiSummary || null,
      article.contentTimeout || 0,
      article.summaryError || null,
      article.extractedContent || null,
      article.queuedAt || now,
      now,
      now
    );
  });
  
  // Execute all statements in a batch
  const results = await db.batch(statements);
  
  // Count successful inserts (changes > 0 means row was inserted)
  results.forEach(result => {
    if (result.meta && result.meta.changes > 0) {
      inserted++;
    } else {
      skipped++;
    }
  });
  
  return { inserted, skipped };
}

/**
 * Update an article in D1 database
 * @param {D1Database} db - D1 database instance
 * @param {string} articleId - Article ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<void>}
 */
export async function updateArticle(db, articleId, updates) {
  const now = Date.now();
  
  // Build SET clause dynamically based on provided updates
  const setClauses = [];
  const values = [];
  
  // Map of field names to their values
  const fieldMap = {
    sentiment: updates.sentiment,
    aiSummary: updates.aiSummary,
    needsSentiment: updates.needsSentiment !== undefined ? (updates.needsSentiment ? 1 : 0) : undefined,
    needsSummary: updates.needsSummary !== undefined ? (updates.needsSummary ? 1 : 0) : undefined,
    contentTimeout: updates.contentTimeout,
    summaryError: updates.summaryError,
    extractedContent: updates.extractedContent,
    processedAt: updates.processedAt
  };
  
  // Build SET clauses for non-undefined fields
  Object.entries(fieldMap).forEach(([field, value]) => {
    if (value !== undefined) {
      setClauses.push(`${field} = ?`);
      values.push(value);
    }
  });
  
  // Always update updatedAt
  setClauses.push('updatedAt = ?');
  values.push(now);
  
  // Add articleId for WHERE clause
  values.push(articleId);
  
  const sql = `UPDATE articles SET ${setClauses.join(', ')} WHERE id = ?`;
  
  await db.prepare(sql).bind(...values).run();
}

/**
 * Get articles that need processing (sentiment or summary)
 * Orders articles by priority:
 * 1. Fresh articles (contentTimeout=0): Never attempted, highest priority
 * 2. Articles with extracted content (ready for Phase 2 AI processing): High priority
 * 3. Failed articles (contentTimeout>0 AND no extractedContent): Retry later, lowest priority
 * 
 * This ensures that articles with successfully extracted content are processed
 * immediately in Phase 2, while failed articles are retried only after processing
 * fresh and ready articles.
 * 
 * @param {D1Database} db - D1 database instance
 * @param {number} limit - Maximum number of articles to return
 * @returns {Promise<Array>} Array of articles needing processing
 */
export async function getArticlesNeedingProcessing(db, limit = 5) {
  const result = await db.prepare(`
    SELECT * FROM articles
    WHERE needsSentiment = 1 OR needsSummary = 1
    ORDER BY 
      CASE 
        WHEN contentTimeout = 0 THEN 0
        WHEN extractedContent IS NOT NULL THEN 1
        ELSE 2
      END ASC,
      pubDate DESC
    LIMIT ?
  `).bind(limit).all();
  
  return result.results || [];
}

/**
 * Get all processed articles (for cache generation)
 * @param {D1Database} db - D1 database instance
 * @param {number} limit - Maximum number of articles to return
 * @returns {Promise<Array>} Array of processed articles
 */
export async function getProcessedArticles(db, limit = 500) {
  const result = await db.prepare(`
    SELECT * FROM articles
    WHERE processedAt IS NOT NULL
    ORDER BY pubDate DESC
    LIMIT ?
  `).bind(limit).all();
  
  return result.results || [];
}

/**
 * Get all articles (including those still being processed)
 * @param {D1Database} db - D1 database instance
 * @param {number} limit - Maximum number of articles to return
 * @returns {Promise<Array>} Array of all articles
 */
export async function getAllArticles(db, limit = 500) {
  const result = await db.prepare(`
    SELECT * FROM articles
    ORDER BY pubDate DESC
    LIMIT ?
  `).bind(limit).all();
  
  return result.results || [];
}

/**
 * Get article by ID
 * @param {D1Database} db - D1 database instance
 * @param {string} articleId - Article ID
 * @returns {Promise<Object|null>} Article object or null if not found
 */
export async function getArticleById(db, articleId) {
  const result = await db.prepare(`
    SELECT * FROM articles WHERE id = ?
  `).bind(articleId).first();
  
  return result || null;
}

/**
 * Check if an article exists in the database
 * @param {D1Database} db - D1 database instance
 * @param {string} articleId - Article ID
 * @returns {Promise<boolean>} True if article exists
 */
export async function articleExists(db, articleId) {
  const result = await db.prepare(`
    SELECT 1 FROM articles WHERE id = ? LIMIT 1
  `).bind(articleId).first();
  
  return result !== null;
}

/**
 * Get article IDs for deduplication check
 * @param {D1Database} db - D1 database instance
 * @param {number} limit - Maximum number of IDs to return
 * @returns {Promise<Set<string>>} Set of article IDs
 */
export async function getArticleIds(db, limit = 1000) {
  const result = await db.prepare(`
    SELECT id FROM articles
    ORDER BY pubDate DESC
    LIMIT ?
  `).bind(limit).all();
  
  const ids = new Set();
  if (result.results) {
    result.results.forEach(row => ids.add(row.id));
  }
  
  return ids;
}

/**
 * Delete old articles beyond the limit
 * @param {D1Database} db - D1 database instance
 * @param {number} keepCount - Number of articles to keep
 * @returns {Promise<number>} Number of articles deleted
 */
export async function deleteOldArticles(db, keepCount = 500) {
  // First, get the pubDate threshold (the Nth newest article's pubDate)
  const thresholdResult = await db.prepare(`
    SELECT pubDate FROM articles
    ORDER BY pubDate DESC
    LIMIT 1 OFFSET ?
  `).bind(keepCount - 1).first();
  
  if (!thresholdResult) {
    // Not enough articles to delete any
    return 0;
  }
  
  const thresholdDate = thresholdResult.pubDate;
  
  // Delete articles older than the threshold
  const deleteResult = await db.prepare(`
    DELETE FROM articles WHERE pubDate < ?
  `).bind(thresholdDate).run();
  
  return deleteResult.meta?.changes || 0;
}

/**
 * Get count of articles by status
 * @param {D1Database} db - D1 database instance
 * @returns {Promise<Object>} Counts object
 */
export async function getArticleCounts(db) {
  const total = await db.prepare(`SELECT COUNT(*) as count FROM articles`).first();
  const needsProcessing = await db.prepare(`
    SELECT COUNT(*) as count FROM articles 
    WHERE needsSentiment = 1 OR needsSummary = 1
  `).first();
  const processed = await db.prepare(`
    SELECT COUNT(*) as count FROM articles 
    WHERE processedAt IS NOT NULL
  `).first();
  
  return {
    total: total?.count || 0,
    needsProcessing: needsProcessing?.count || 0,
    processed: processed?.count || 0
  };
}

/**
 * Convert D1 row to article object format
 * Converts boolean fields from integers (0/1) to actual booleans
 * @param {Object} row - D1 row object
 * @returns {Object} Article object
 */
export function rowToArticle(row) {
  if (!row) return null;
  
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    link: row.link,
    pubDate: row.pubDate,
    source: row.source,
    imageUrl: row.imageUrl,
    needsSentiment: row.needsSentiment === 1,
    needsSummary: row.needsSummary === 1,
    sentiment: row.sentiment,
    aiSummary: row.aiSummary,
    contentTimeout: row.contentTimeout,
    summaryError: row.summaryError,
    extractedContent: row.extractedContent,
    queuedAt: row.queuedAt,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * Convert array of D1 rows to article objects
 * @param {Array} rows - Array of D1 row objects
 * @returns {Array} Array of article objects
 */
export function rowsToArticles(rows) {
  if (!rows || !Array.isArray(rows)) return [];
  return rows.map(rowToArticle).filter(article => article !== null);
}

/**
 * Update processing checkpoint
 * @param {D1Database} db - D1 database instance
 * @param {string|null} currentArticleId - Current article being processed (or null)
 * @returns {Promise<void>}
 */
export async function updateCheckpoint(db, currentArticleId) {
  const now = Date.now();
  
  if (currentArticleId) {
    // Starting to process an article
    await db.prepare(`
      UPDATE processing_checkpoint 
      SET currentArticleId = ?, lastProcessedAt = ?
      WHERE id = 1
    `).bind(currentArticleId, now).run();
  } else {
    // Finished processing, increment counter
    await db.prepare(`
      UPDATE processing_checkpoint 
      SET currentArticleId = NULL, 
          lastProcessedAt = ?,
          articlesProcessedCount = articlesProcessedCount + 1
      WHERE id = 1
    `).bind(now).run();
  }
}

/**
 * Get processing checkpoint
 * @param {D1Database} db - D1 database instance
 * @returns {Promise<Object|null>} Checkpoint object or null
 */
export async function getCheckpoint(db) {
  const result = await db.prepare(`
    SELECT * FROM processing_checkpoint WHERE id = 1
  `).first();
  
  return result || null;
}
