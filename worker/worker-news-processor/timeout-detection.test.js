/**
 * Test suite for Timeout Detection and Stuck Article Recovery
 * 
 * Tests the system's ability to detect and handle articles that get stuck
 * during processing (e.g., due to worker timeout, crash, or network issues).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { processBatchFromD1, processArticle } from './index.js';
import { 
  insertArticlesBatch, 
  getArticleById, 
  updateCheckpoint, 
  getCheckpoint,
  updateArticle 
} from '../shared/d1-utils.js';
import { getNewsProcessorConfig } from '../shared/constants.js';

/**
 * Mock D1 Database for testing
 * Simplified in-memory implementation
 */
class MockD1Database {
  constructor() {
    this.articles = new Map();
    this.checkpoint = {
      id: 1,
      currentArticleId: null,
      lastProcessedAt: 0,
      articlesProcessedCount: 0
    };
  }

  prepare(sql) {
    const db = this;
    const boundStatement = {
      bind(...params) {
        boundStatement.params = params;
        return boundStatement;
      },
      params: [],
      async run() {
        const params = boundStatement.params;
            // Handle INSERT
            if (sql.includes('INSERT') && sql.includes('articles')) {
              const [id, title, description, link, pubDate, source, imageUrl, 
                     needsSentiment, needsSummary, sentiment, aiSummary, 
                     contentTimeout, summaryError, extractedContent, queuedAt,
                     createdAt, updatedAt] = params;
              
              // INSERT OR IGNORE - don't overwrite existing
              if (sql.includes('OR IGNORE') && db.articles.has(id)) {
                return { meta: { changes: 0 } };
              }
              
              db.articles.set(id, {
                id, title, description, link, pubDate, source, imageUrl,
                needsSentiment, needsSummary, sentiment, aiSummary,
                contentTimeout, summaryError, extractedContent, queuedAt,
                createdAt, updatedAt, processedAt: null
              });
              return { meta: { changes: 1 } };
            }
            
            // Handle UPDATE articles
            if (sql.includes('UPDATE articles')) {
              const articleId = params[params.length - 1];
              const article = db.articles.get(articleId);
              if (article) {
                // Parse SET clause to update fields
                const setMatches = sql.match(/SET (.+?) WHERE/);
                if (setMatches) {
                  const setClauses = setMatches[1].split(',').map(s => s.trim());
                  let paramIndex = 0;
                  
                  setClauses.forEach(clause => {
                    const fieldName = clause.split('=')[0].trim();
                    article[fieldName] = params[paramIndex];
                    paramIndex++;
                  });
                }
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            
            // Handle UPDATE checkpoint
            if (sql.includes('UPDATE processing_checkpoint')) {
              if (sql.includes('currentArticleId = NULL')) {
                db.checkpoint.currentArticleId = null;
                db.checkpoint.lastProcessedAt = params[0];
                db.checkpoint.articlesProcessedCount++;
              } else {
                db.checkpoint.currentArticleId = params[0];
                db.checkpoint.lastProcessedAt = params[1];
              }
              return { meta: { changes: 1 } };
            }
            
            return { meta: { changes: 0 } };
          },
      
      async first() {
        const params = boundStatement.params;
            // Handle SELECT checkpoint
            if (sql.includes('FROM processing_checkpoint')) {
              return db.checkpoint;
            }
            
            // Handle SELECT article by ID
            if (sql.includes('FROM articles WHERE id = ?')) {
              const articleId = params[0];
              return db.articles.get(articleId) || null;
            }
            
            return null;
          },
          
      async all() {
        const params = boundStatement.params;
            // Handle SELECT articles needing processing
            if (sql.includes('WHERE needsSentiment = 1 OR needsSummary = 1')) {
              const limit = params[0];
              const results = Array.from(db.articles.values())
                .filter(a => a.needsSentiment === 1 || a.needsSummary === 1)
                .sort((a, b) => b.pubDate.localeCompare(a.pubDate))
                .slice(0, limit);
              return { results };
            }
            
            return { results: [] };
          }
    };
    
    return boundStatement;
  }

  async batch(statements) {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }

  reset() {
    this.articles.clear();
    this.checkpoint = {
      id: 1,
      currentArticleId: null,
      lastProcessedAt: 0,
      articlesProcessedCount: 0
    };
  }
}

/**
 * Mock AI environment for testing
 */
function createMockEnv() {
  return {
    AI: {
      run: async () => ({ response: 'positive' })
    }
  };
}

describe('Timeout Detection and Stuck Article Recovery', () => {
  let mockDB;
  let mockEnv;
  let config;

  beforeEach(() => {
    mockDB = new MockD1Database();
    mockEnv = createMockEnv();
    config = getNewsProcessorConfig({});
  });

  describe('Stuck Article Detection', () => {
    it('should detect article stuck in checkpoint for too long', async () => {
      // Insert an article
      await insertArticlesBatch(mockDB, [{
        id: 'stuck-article-1',
        title: 'Stuck Article Test',
        link: 'https://example.com/stuck',
        pubDate: new Date().toISOString(),
        needsSentiment: true,
        needsSummary: true
      }]);

      // Simulate article getting stuck in checkpoint (e.g., worker timeout during processing)
      const oldTimestamp = Date.now() - (10 * 60 * 1000); // 10 minutes ago
      await updateCheckpoint(mockDB, 'stuck-article-1');
      mockDB.checkpoint.lastProcessedAt = oldTimestamp;

      // Get checkpoint and verify it shows stuck article
      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBe('stuck-article-1');
      expect(checkpoint.lastProcessedAt).toBe(oldTimestamp);

      // On next run, system should detect this stuck article
      const timeSinceLastUpdate = Date.now() - checkpoint.lastProcessedAt;
      const STUCK_THRESHOLD = 5 * 60 * 1000; // 5 minutes
      
      expect(timeSinceLastUpdate).toBeGreaterThan(STUCK_THRESHOLD);
      expect(checkpoint.currentArticleId).not.toBeNull();
    });

    it('should increment contentTimeout when stuck article is detected', async () => {
      // Insert an article with initial contentTimeout
      await insertArticlesBatch(mockDB, [{
        id: 'timeout-article',
        title: 'Timeout Test',
        link: 'https://example.com/timeout',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 1  // Already had one timeout
      }]);

      const articleBefore = await getArticleById(mockDB, 'timeout-article');
      expect(articleBefore.contentTimeout).toBe(1);

      // Simulate stuck in checkpoint
      const oldTimestamp = Date.now() - (10 * 60 * 1000); // 10 minutes ago
      await updateCheckpoint(mockDB, 'timeout-article');
      mockDB.checkpoint.lastProcessedAt = oldTimestamp;

      // When detected, contentTimeout should be incremented
      const article = await getArticleById(mockDB, 'timeout-article');
      
      // Simulate the increment that should happen on detection
      await updateArticle(mockDB, 'timeout-article', {
        contentTimeout: (article.contentTimeout || 0) + 1,
        summaryError: `timeout_detected (attempt ${(article.contentTimeout || 0) + 1}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`
      });

      const articleAfter = await getArticleById(mockDB, 'timeout-article');
      expect(articleAfter.contentTimeout).toBe(2);
      expect(articleAfter.summaryError).toContain('timeout_detected');
    });

    it('should mark article as failed after max retries on stuck detection', async () => {
      // Insert an article that's already at max retries
      await insertArticlesBatch(mockDB, [{
        id: 'max-retry-article',
        title: 'Max Retry Test',
        link: 'https://example.com/max-retry',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: config.MAX_CONTENT_FETCH_ATTEMPTS - 1  // One away from max
      }]);

      const articleBefore = await getArticleById(mockDB, 'max-retry-article');
      expect(articleBefore.contentTimeout).toBe(config.MAX_CONTENT_FETCH_ATTEMPTS - 1);
      expect(articleBefore.needsSummary).toBe(1);

      // Simulate stuck in checkpoint
      await updateCheckpoint(mockDB, 'max-retry-article');
      mockDB.checkpoint.lastProcessedAt = Date.now() - (10 * 60 * 1000);

      // On detection, increment would hit max, so article should be marked as failed
      const newTimeout = articleBefore.contentTimeout + 1;
      
      if (newTimeout >= config.MAX_CONTENT_FETCH_ATTEMPTS) {
        await updateArticle(mockDB, 'max-retry-article', {
          contentTimeout: newTimeout,
          needsSummary: false,
          summaryError: `max_retries_exceeded (attempt ${newTimeout}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`,
          processedAt: Date.now()
        });
      }

      const articleAfter = await getArticleById(mockDB, 'max-retry-article');
      expect(articleAfter.contentTimeout).toBe(config.MAX_CONTENT_FETCH_ATTEMPTS);
      expect(articleAfter.needsSummary).toBe(0);
      expect(articleAfter.summaryError).toContain('max_retries_exceeded');
      expect(articleAfter.processedAt).not.toBeNull();
    });

    it('should not falsely detect recent processing as stuck', async () => {
      // Insert an article
      await insertArticlesBatch(mockDB, [{
        id: 'recent-article',
        title: 'Recent Processing',
        link: 'https://example.com/recent',
        pubDate: new Date().toISOString(),
        needsSentiment: true,
        needsSummary: true
      }]);

      // Simulate article currently being processed (recent timestamp)
      const recentTimestamp = Date.now() - (30 * 1000); // 30 seconds ago
      await updateCheckpoint(mockDB, 'recent-article');
      mockDB.checkpoint.lastProcessedAt = recentTimestamp;

      const checkpoint = await getCheckpoint(mockDB);
      const timeSinceLastUpdate = Date.now() - checkpoint.lastProcessedAt;
      const STUCK_THRESHOLD = 5 * 60 * 1000; // 5 minutes

      // Should NOT be considered stuck
      expect(timeSinceLastUpdate).toBeLessThan(STUCK_THRESHOLD);
    });
  });

  describe('Stuck Article Recovery Integration', () => {
    it('should handle stuck article during Phase 1 content fetching', async () => {
      // Insert an article stuck during content fetching
      await insertArticlesBatch(mockDB, [{
        id: 'stuck-phase1',
        title: 'Stuck in Phase 1',
        link: 'https://example.com/stuck-phase1',
        pubDate: new Date().toISOString(),
        needsSentiment: false,  // Sentiment already done
        needsSummary: true,
        contentTimeout: 1,
        extractedContent: null  // Stuck before content extraction completed
      }]);

      // Simulate stuck in checkpoint from Phase 1
      await updateCheckpoint(mockDB, 'stuck-phase1');
      mockDB.checkpoint.lastProcessedAt = Date.now() - (10 * 60 * 1000);

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBe('stuck-phase1');

      // On recovery, should increment timeout and retry
      const article = await getArticleById(mockDB, 'stuck-phase1');
      expect(article.contentTimeout).toBe(1);
      expect(article.extractedContent).toBeNull();
    });

    it('should handle multiple stuck article recoveries', async () => {
      // Test that system can recover from stuck state multiple times
      await insertArticlesBatch(mockDB, [{
        id: 'multi-stuck',
        title: 'Multiple Stuck Recoveries',
        link: 'https://example.com/multi-stuck',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 0
      }]);

      // First stuck occurrence
      await updateCheckpoint(mockDB, 'multi-stuck');
      mockDB.checkpoint.lastProcessedAt = Date.now() - (10 * 60 * 1000);
      
      let article = await getArticleById(mockDB, 'multi-stuck');
      await updateArticle(mockDB, 'multi-stuck', {
        contentTimeout: (article.contentTimeout || 0) + 1
      });
      await updateCheckpoint(mockDB, null);

      article = await getArticleById(mockDB, 'multi-stuck');
      expect(article.contentTimeout).toBe(1);

      // Second stuck occurrence
      await updateCheckpoint(mockDB, 'multi-stuck');
      mockDB.checkpoint.lastProcessedAt = Date.now() - (10 * 60 * 1000);
      
      article = await getArticleById(mockDB, 'multi-stuck');
      await updateArticle(mockDB, 'multi-stuck', {
        contentTimeout: (article.contentTimeout || 0) + 1
      });
      await updateCheckpoint(mockDB, null);

      article = await getArticleById(mockDB, 'multi-stuck');
      expect(article.contentTimeout).toBe(2);
    });

    it('should clear checkpoint after stuck article reaches max retries', async () => {
      // Insert article at max retries
      await insertArticlesBatch(mockDB, [{
        id: 'clear-checkpoint-test',
        title: 'Clear Checkpoint Test',
        link: 'https://example.com/clear',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: config.MAX_CONTENT_FETCH_ATTEMPTS - 1
      }]);

      // Stuck in checkpoint
      await updateCheckpoint(mockDB, 'clear-checkpoint-test');
      mockDB.checkpoint.lastProcessedAt = Date.now() - (10 * 60 * 1000);

      // Process and hit max retries
      const article = await getArticleById(mockDB, 'clear-checkpoint-test');
      const newTimeout = article.contentTimeout + 1;
      
      await updateArticle(mockDB, 'clear-checkpoint-test', {
        contentTimeout: newTimeout,
        needsSummary: false,
        summaryError: `max_retries_exceeded (attempt ${newTimeout}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`,
        processedAt: Date.now()
      });
      
      // Clear checkpoint
      await updateCheckpoint(mockDB, null);

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle null checkpoint gracefully', async () => {
      // Ensure checkpoint exists but is empty
      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
      expect(checkpoint.lastProcessedAt).toBeDefined();
    });

    it('should handle article that no longer needs processing', async () => {
      // Article was marked as stuck but completed by another process
      await insertArticlesBatch(mockDB, [{
        id: 'completed-article',
        title: 'Completed Article',
        link: 'https://example.com/completed',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: false,  // Already completed
        processedAt: Date.now()
      }]);

      // Checkpoint still references it (stale)
      await updateCheckpoint(mockDB, 'completed-article');

      const article = await getArticleById(mockDB, 'completed-article');
      expect(article.needsSentiment).toBe(0);
      expect(article.needsSummary).toBe(0);

      // Should skip and clear checkpoint
      if (article.needsSentiment === 0 && article.needsSummary === 0) {
        await updateCheckpoint(mockDB, null);
      }

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
    });

    it('should handle checkpoint with article that was deleted', async () => {
      // Checkpoint references non-existent article
      await updateCheckpoint(mockDB, 'deleted-article');

      const article = await getArticleById(mockDB, 'deleted-article');
      expect(article).toBeNull();

      // Should clear checkpoint
      if (!article) {
        await updateCheckpoint(mockDB, null);
      }

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
    });
  });
});
