/**
 * Test suite for Timeout Detection and Stuck Article Recovery
 * 
 * Tests the system's ability to detect and handle articles that get stuck
 * during processing (e.g., due to worker timeout, crash, or network issues).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { checkAndHandleStuckArticle } from './index.js';
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
    it('should detect article in checkpoint at worker startup', async () => {
      // Insert an article
      await insertArticlesBatch(mockDB, [{
        id: 'stuck-article-1',
        title: 'Stuck Article Test',
        link: 'https://example.com/stuck',
        pubDate: new Date().toISOString(),
        needsSentiment: true,
        needsSummary: true
      }]);

      // Simulate article in checkpoint from previous run (worker did not complete)
      await updateCheckpoint(mockDB, 'stuck-article-1');

      // Call checkAndHandleStuckArticle to detect and handle
      const result = await checkAndHandleStuckArticle(mockDB, config);
      
      // Should detect the stuck article
      expect(result).not.toBeNull();
      expect(result.id).toBe('stuck-article-1');
      
      // Checkpoint should be cleared after handling
      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
    });

    it('should not increment contentTimeout again (Phase 1 already did)', async () => {
      // Insert an article with contentTimeout already incremented by Phase 1
      await insertArticlesBatch(mockDB, [{
        id: 'timeout-article',
        title: 'Timeout Test',
        link: 'https://example.com/timeout',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 1  // Phase 1 already incremented this before fetch
      }]);

      const articleBefore = await getArticleById(mockDB, 'timeout-article');
      expect(articleBefore.contentTimeout).toBe(1);

      // Simulate article in checkpoint from previous incomplete run
      await updateCheckpoint(mockDB, 'timeout-article');

      // Call checkAndHandleStuckArticle - should NOT increment contentTimeout again
      await checkAndHandleStuckArticle(mockDB, config);

      const articleAfter = await getArticleById(mockDB, 'timeout-article');
      // contentTimeout should remain 1 (not incremented to 2)
      expect(articleAfter.contentTimeout).toBe(1);
      expect(articleAfter.summaryError).toContain('timeout_detected');
    });

    it('should mark article as failed when already at max retries', async () => {
      // Insert an article already at max retries (Phase 1 incremented it)
      await insertArticlesBatch(mockDB, [{
        id: 'max-retry-article',
        title: 'Max Retry Test',
        link: 'https://example.com/max-retry',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: config.MAX_CONTENT_FETCH_ATTEMPTS  // Already at max
      }]);

      const articleBefore = await getArticleById(mockDB, 'max-retry-article');
      expect(articleBefore.contentTimeout).toBe(config.MAX_CONTENT_FETCH_ATTEMPTS);
      expect(articleBefore.needsSummary).toBe(1);

      // Simulate article in checkpoint
      await updateCheckpoint(mockDB, 'max-retry-article');

      // Call checkAndHandleStuckArticle - should mark as failed
      const result = await checkAndHandleStuckArticle(mockDB, config);

      // Should return null (article marked as failed, won't retry)
      expect(result).toBeNull();

      const articleAfter = await getArticleById(mockDB, 'max-retry-article');
      expect(articleAfter.needsSummary).toBe(0);
      expect(articleAfter.needsSentiment).toBe(0);  // Both flags cleared
      expect(articleAfter.summaryError).toContain('timeout_max_retries_exceeded');
      expect(articleAfter.processedAt).not.toBeNull();
    });

    it('should not falsely detect when checkpoint is empty', async () => {
      // Call checkAndHandleStuckArticle with empty checkpoint
      const result = await checkAndHandleStuckArticle(mockDB, config);
      
      // Should return null (no stuck article)
      expect(result).toBeNull();
    });
  });

  describe('Stuck Article Recovery Integration', () => {
    it('should handle incomplete processing during Phase 0 sentiment analysis', async () => {
      // Insert an article that didn't complete in Phase 0
      await insertArticlesBatch(mockDB, [{
        id: 'stuck-phase0',
        title: 'Stuck in Phase 0',
        link: 'https://example.com/stuck-phase0',
        pubDate: new Date().toISOString(),
        needsSentiment: true,  // Still needs sentiment
        needsSummary: true,
        sentiment: null,
        contentTimeout: 0  // Phase 0 doesn't increment contentTimeout
      }]);

      // Simulate article in checkpoint from previous incomplete run (timeout during sentiment)
      await updateCheckpoint(mockDB, 'stuck-phase0');

      // Call checkAndHandleStuckArticle
      const result = await checkAndHandleStuckArticle(mockDB, config);

      // Should detect and handle stuck article
      expect(result).not.toBeNull();
      expect(result.id).toBe('stuck-phase0');
      
      // contentTimeout should still be 0 (Phase 0 doesn't use it)
      const article = await getArticleById(mockDB, 'stuck-phase0');
      expect(article.contentTimeout).toBe(0);
      expect(article.needsSentiment).toBe(1);
    });

    it('should handle incomplete processing during Phase 1 content fetching', async () => {
      // Insert an article that didn't complete in Phase 1
      // Phase 1 would have incremented contentTimeout to 1 before fetch
      await insertArticlesBatch(mockDB, [{
        id: 'stuck-phase1',
        title: 'Stuck in Phase 1',
        link: 'https://example.com/stuck-phase1',
        pubDate: new Date().toISOString(),
        needsSentiment: false,  // Sentiment already done
        needsSummary: true,
        contentTimeout: 1,  // Phase 1 incremented this before fetch
        extractedContent: null  // Incomplete - content extraction didn't finish
      }]);

      // Simulate article in checkpoint from previous incomplete run
      await updateCheckpoint(mockDB, 'stuck-phase1');

      // Call checkAndHandleStuckArticle
      const result = await checkAndHandleStuckArticle(mockDB, config);

      // Should detect and handle
      expect(result).not.toBeNull();
      
      // contentTimeout should remain 1 (not incremented again)
      const article = await getArticleById(mockDB, 'stuck-phase1');
      expect(article.contentTimeout).toBe(1);
      expect(article.extractedContent).toBeNull();  // Should be cleared for retry
    });

    it('should preserve extractedContent when stuck in Phase 2', async () => {
      // Insert an article that didn't complete in Phase 2
      await insertArticlesBatch(mockDB, [{
        id: 'stuck-phase2',
        title: 'Stuck in Phase 2',
        link: 'https://example.com/stuck-phase2',
        pubDate: new Date().toISOString(),
        needsSentiment: false,  // Sentiment already done
        needsSummary: true,
        contentTimeout: 1,
        extractedContent: 'Some extracted content here',  // Content was extracted successfully
        aiSummary: null  // Incomplete - AI summary not generated
      }]);

      // Simulate article in checkpoint from previous incomplete run (timeout during AI)
      await updateCheckpoint(mockDB, 'stuck-phase2');

      // Call checkAndHandleStuckArticle
      const result = await checkAndHandleStuckArticle(mockDB, config);

      // Should detect and handle
      expect(result).not.toBeNull();
      
      // extractedContent should be preserved (not cleared) for Phase 2 retry
      const article = await getArticleById(mockDB, 'stuck-phase2');
      expect(article.extractedContent).toBe('Some extracted content here');
      expect(article.contentTimeout).toBe(1);  // Not incremented again
    });

    it('should handle multiple incomplete processing recoveries', async () => {
      // Test that system can recover from incomplete processing multiple times
      await insertArticlesBatch(mockDB, [{
        id: 'multi-stuck',
        title: 'Multiple Stuck Recoveries',
        link: 'https://example.com/multi-stuck',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 0
      }]);

      // First incomplete occurrence - Phase 1 increments to 1
      await updateArticle(mockDB, 'multi-stuck', { contentTimeout: 1 });
      await updateCheckpoint(mockDB, 'multi-stuck');
      await checkAndHandleStuckArticle(mockDB, config);

      let article = await getArticleById(mockDB, 'multi-stuck');
      expect(article.contentTimeout).toBe(1);  // Not incremented by recovery

      // Second incomplete occurrence - Phase 1 increments to 2
      await updateArticle(mockDB, 'multi-stuck', { contentTimeout: 2 });
      await updateCheckpoint(mockDB, 'multi-stuck');
      await checkAndHandleStuckArticle(mockDB, config);

      article = await getArticleById(mockDB, 'multi-stuck');
      expect(article.contentTimeout).toBe(2);  // Not incremented by recovery
    });

    it('should clear checkpoint after article reaches max retries', async () => {
      // Insert article at max retries (Phase 1 already incremented)
      await insertArticlesBatch(mockDB, [{
        id: 'clear-checkpoint-test',
        title: 'Clear Checkpoint Test',
        link: 'https://example.com/clear',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: config.MAX_CONTENT_FETCH_ATTEMPTS  // Already at max
      }]);

      // Article in checkpoint from previous incomplete run
      await updateCheckpoint(mockDB, 'clear-checkpoint-test');

      // Call checkAndHandleStuckArticle - should mark as failed and clear checkpoint
      await checkAndHandleStuckArticle(mockDB, config);

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
      
      const article = await getArticleById(mockDB, 'clear-checkpoint-test');
      expect(article.needsSummary).toBe(0);
      expect(article.needsSentiment).toBe(0);
    });
  });

  describe('Phase-Specific Timeout Behavior', () => {
    it('should not increment contentTimeout in recovery (Phase 1 already did)', async () => {
      // Phase 1 increments contentTimeout BEFORE the fetch operation
      // Recovery should NOT increment it again
      await insertArticlesBatch(mockDB, [{
        id: 'phase1-timeout',
        title: 'Phase 1 Timeout',
        link: 'https://example.com/phase1-timeout',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 1  // Phase 1 already incremented before fetch
      }]);

      // Simulate timeout in Phase 1 (during content fetch)
      await updateCheckpoint(mockDB, 'phase1-timeout');
      
      // Call recovery - should NOT increment contentTimeout again
      await checkAndHandleStuckArticle(mockDB, config);
      
      const article = await getArticleById(mockDB, 'phase1-timeout');
      expect(article.contentTimeout).toBe(1);  // Still 1, not 2
    });

    it('should preserve extractedContent when stuck in Phase 2', async () => {
      // Phase 2 should preserve extractedContent for retry
      await insertArticlesBatch(mockDB, [{
        id: 'phase2-timeout',
        title: 'Phase 2 Timeout',
        link: 'https://example.com/phase2-timeout',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 1,  // Already incremented in Phase 1
        extractedContent: 'Content from Phase 1'
      }]);

      // Simulate timeout in Phase 2 (during AI generation)
      await updateCheckpoint(mockDB, 'phase2-timeout');
      
      // Call recovery - should preserve extractedContent
      await checkAndHandleStuckArticle(mockDB, config);
      
      const article = await getArticleById(mockDB, 'phase2-timeout');
      expect(article.contentTimeout).toBe(1);  // Not incremented again
      expect(article.extractedContent).toBe('Content from Phase 1');  // Preserved
    });

    it('should clear extractedContent when stuck in Phase 1', async () => {
      // Phase 1 should clear extractedContent for retry
      await insertArticlesBatch(mockDB, [{
        id: 'phase1-no-content',
        title: 'Phase 1 No Content',
        link: 'https://example.com/phase1-no-content',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 1,
        extractedContent: null  // No content yet
      }]);

      // Simulate timeout in Phase 1
      await updateCheckpoint(mockDB, 'phase1-no-content');
      
      // Call recovery - should ensure extractedContent is null
      await checkAndHandleStuckArticle(mockDB, config);
      
      const article = await getArticleById(mockDB, 'phase1-no-content');
      expect(article.extractedContent).toBeNull();  // Cleared
    });

    it('should mark article as failed when at max retries', async () => {
      // Test that max retries works regardless of phase
      await insertArticlesBatch(mockDB, [{
        id: 'max-retry-any-phase',
        title: 'Max Retry Any Phase',
        link: 'https://example.com/max-retry',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: config.MAX_CONTENT_FETCH_ATTEMPTS,  // At max
        extractedContent: 'Some content'
      }]);

      // Simulate timeout at max retry count
      await updateCheckpoint(mockDB, 'max-retry-any-phase');
      
      // Call recovery - should mark as failed
      await checkAndHandleStuckArticle(mockDB, config);
      
      const updatedArticle = await getArticleById(mockDB, 'max-retry-any-phase');
      expect(updatedArticle.contentTimeout).toBe(config.MAX_CONTENT_FETCH_ATTEMPTS);
      expect(updatedArticle.needsSummary).toBe(0);
      expect(updatedArticle.needsSentiment).toBe(0);
      expect(updatedArticle.processedAt).not.toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle null checkpoint gracefully', async () => {
      // Call checkAndHandleStuckArticle with empty checkpoint
      const result = await checkAndHandleStuckArticle(mockDB, config);
      expect(result).toBeNull();
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

      // Call checkAndHandleStuckArticle - should detect completion and clear checkpoint
      const result = await checkAndHandleStuckArticle(mockDB, config);
      expect(result).toBeNull();

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
    });

    it('should handle checkpoint with article that was deleted', async () => {
      // Checkpoint references non-existent article
      await updateCheckpoint(mockDB, 'deleted-article');

      // Call checkAndHandleStuckArticle - should detect deletion and clear checkpoint
      const result = await checkAndHandleStuckArticle(mockDB, config);
      expect(result).toBeNull();

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
    });
  });
});
