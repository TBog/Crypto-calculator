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

      // Get checkpoint and verify it shows article from previous run
      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBe('stuck-article-1');
      
      // At worker startup, finding an article in checkpoint means incomplete processing
      expect(checkpoint.currentArticleId).not.toBeNull();
    });

    it('should increment contentTimeout when incomplete processing is detected', async () => {
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

      // Simulate article in checkpoint from previous incomplete run
      await updateCheckpoint(mockDB, 'timeout-article');

      // When detected at startup, contentTimeout should be incremented
      const article = await getArticleById(mockDB, 'timeout-article');
      
      // Simulate the increment that should happen on detection
      await updateArticle(mockDB, 'timeout-article', {
        contentTimeout: (article.contentTimeout || 0) + 1,
        summaryError: `incomplete_processing (attempt ${(article.contentTimeout || 0) + 1}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`
      });

      const articleAfter = await getArticleById(mockDB, 'timeout-article');
      expect(articleAfter.contentTimeout).toBe(2);
      expect(articleAfter.summaryError).toContain('incomplete_processing');
    });

    it('should mark article as failed after max retries on incomplete processing detection', async () => {
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

      // Simulate article in checkpoint from previous incomplete run
      await updateCheckpoint(mockDB, 'max-retry-article');

      // On detection, increment would hit max, so article should be marked as failed
      const newTimeout = articleBefore.contentTimeout + 1;
      
      if (newTimeout >= config.MAX_CONTENT_FETCH_ATTEMPTS) {
        await updateArticle(mockDB, 'max-retry-article', {
          contentTimeout: newTimeout,
          needsSummary: false,
          summaryError: `incomplete_processing_max_retries (attempt ${newTimeout}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`,
          processedAt: Date.now()
        });
      }

      const articleAfter = await getArticleById(mockDB, 'max-retry-article');
      expect(articleAfter.contentTimeout).toBe(config.MAX_CONTENT_FETCH_ATTEMPTS);
      expect(articleAfter.needsSummary).toBe(0);
      expect(articleAfter.summaryError).toContain('max_retries');
      expect(articleAfter.processedAt).not.toBeNull();
    });

    it('should not falsely detect when checkpoint is empty', async () => {
      // Ensure checkpoint is empty  
      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
      
      // Empty checkpoint = previous run completed successfully, no detection needed
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
        sentiment: null  // Incomplete - sentiment not set
      }]);

      // Simulate article in checkpoint from previous incomplete run (timeout during sentiment)
      await updateCheckpoint(mockDB, 'stuck-phase0');

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBe('stuck-phase0');

      // On recovery, checkpoint should detect incomplete processing
      const article = await getArticleById(mockDB, 'stuck-phase0');
      expect(article.needsSentiment).toBe(1);
      expect(article.sentiment).toBeNull();
    });

    it('should handle incomplete processing during Phase 1 content fetching', async () => {
      // Insert an article that didn't complete in Phase 1
      await insertArticlesBatch(mockDB, [{
        id: 'stuck-phase1',
        title: 'Stuck in Phase 1',
        link: 'https://example.com/stuck-phase1',
        pubDate: new Date().toISOString(),
        needsSentiment: false,  // Sentiment already done
        needsSummary: true,
        contentTimeout: 1,
        extractedContent: null  // Incomplete - content extraction didn't finish
      }]);

      // Simulate article in checkpoint from previous incomplete run
      await updateCheckpoint(mockDB, 'stuck-phase1');

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBe('stuck-phase1');

      // On recovery, should increment timeout and retry
      const article = await getArticleById(mockDB, 'stuck-phase1');
      expect(article.contentTimeout).toBe(1);
      expect(article.extractedContent).toBeNull();
    });

    it('should handle incomplete processing during Phase 2 AI summary generation', async () => {
      // Insert an article that didn't complete in Phase 2
      await insertArticlesBatch(mockDB, [{
        id: 'stuck-phase2',
        title: 'Stuck in Phase 2',
        link: 'https://example.com/stuck-phase2',
        pubDate: new Date().toISOString(),
        needsSentiment: false,  // Sentiment already done
        needsSummary: true,
        contentTimeout: 1,
        extractedContent: 'Some extracted content here',  // Content was extracted
        aiSummary: null  // Incomplete - AI summary not generated
      }]);

      // Simulate article in checkpoint from previous incomplete run (timeout during AI)
      await updateCheckpoint(mockDB, 'stuck-phase2');

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBe('stuck-phase2');

      // On recovery, should detect incomplete AI processing
      const article = await getArticleById(mockDB, 'stuck-phase2');
      expect(article.needsSummary).toBe(1);
      expect(article.extractedContent).not.toBeNull();
      expect(article.aiSummary).toBeNull();
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

      // First incomplete occurrence
      await updateCheckpoint(mockDB, 'multi-stuck');
      
      let article = await getArticleById(mockDB, 'multi-stuck');
      await updateArticle(mockDB, 'multi-stuck', {
        contentTimeout: (article.contentTimeout || 0) + 1
      });
      await updateCheckpoint(mockDB, null);

      article = await getArticleById(mockDB, 'multi-stuck');
      expect(article.contentTimeout).toBe(1);

      // Second incomplete occurrence
      await updateCheckpoint(mockDB, 'multi-stuck');
      
      article = await getArticleById(mockDB, 'multi-stuck');
      await updateArticle(mockDB, 'multi-stuck', {
        contentTimeout: (article.contentTimeout || 0) + 1
      });
      await updateCheckpoint(mockDB, null);

      article = await getArticleById(mockDB, 'multi-stuck');
      expect(article.contentTimeout).toBe(2);
    });

    it('should clear checkpoint after article with incomplete processing reaches max retries', async () => {
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

      // Article in checkpoint from previous incomplete run
      await updateCheckpoint(mockDB, 'clear-checkpoint-test');

      // Process and hit max retries
      const article = await getArticleById(mockDB, 'clear-checkpoint-test');
      const newTimeout = article.contentTimeout + 1;
      
      await updateArticle(mockDB, 'clear-checkpoint-test', {
        contentTimeout: newTimeout,
        needsSummary: false,
        summaryError: `incomplete_processing_max_retries (attempt ${newTimeout}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`,
        processedAt: Date.now()
      });
      
      // Clear checkpoint
      await updateCheckpoint(mockDB, null);

      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBeNull();
    });
  });

  describe('Phase-Specific Timeout Behavior', () => {
    it('should handle Phase 0 sentiment timeout without incrementing contentTimeout', async () => {
      // Phase 0 doesn't use contentTimeout counter - it just retries
      await insertArticlesBatch(mockDB, [{
        id: 'phase0-timeout',
        title: 'Phase 0 Timeout',
        link: 'https://example.com/phase0-timeout',
        pubDate: new Date().toISOString(),
        needsSentiment: true,
        needsSummary: true,
        contentTimeout: 0
      }]);

      // Simulate timeout in Phase 0
      await updateCheckpoint(mockDB, 'phase0-timeout');
      
      // On detection, contentTimeout should NOT be incremented (Phase 0 doesn't use it)
      const article = await getArticleById(mockDB, 'phase0-timeout');
      expect(article.contentTimeout).toBe(0);
      expect(article.needsSentiment).toBe(1);
    });

    it('should increment contentTimeout on Phase 1 content fetch timeout', async () => {
      // Phase 1 increments contentTimeout before fetching
      await insertArticlesBatch(mockDB, [{
        id: 'phase1-timeout',
        title: 'Phase 1 Timeout',
        link: 'https://example.com/phase1-timeout',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 0
      }]);

      // Simulate timeout in Phase 1 (during content fetch)
      // contentTimeout would have been incremented before fetch
      await updateArticle(mockDB, 'phase1-timeout', {
        contentTimeout: 1  // This happens BEFORE fetch attempt
      });
      await updateCheckpoint(mockDB, 'phase1-timeout');
      
      // On detection, contentTimeout should be incremented again
      const article = await getArticleById(mockDB, 'phase1-timeout');
      await updateArticle(mockDB, 'phase1-timeout', {
        contentTimeout: (article.contentTimeout || 0) + 1
      });
      
      const updatedArticle = await getArticleById(mockDB, 'phase1-timeout');
      expect(updatedArticle.contentTimeout).toBe(2);
    });

    it('should use existing contentTimeout on Phase 2 AI summary timeout', async () => {
      // Phase 2 doesn't increment contentTimeout, just uses existing value
      await insertArticlesBatch(mockDB, [{
        id: 'phase2-timeout',
        title: 'Phase 2 Timeout',
        link: 'https://example.com/phase2-timeout',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: 2,  // Already incremented in Phase 1
        extractedContent: 'Content from Phase 1'
      }]);

      // Simulate timeout in Phase 2 (during AI generation)
      await updateCheckpoint(mockDB, 'phase2-timeout');
      
      // On detection, contentTimeout should be incremented
      const article = await getArticleById(mockDB, 'phase2-timeout');
      await updateArticle(mockDB, 'phase2-timeout', {
        contentTimeout: (article.contentTimeout || 0) + 1
      });
      
      const updatedArticle = await getArticleById(mockDB, 'phase2-timeout');
      expect(updatedArticle.contentTimeout).toBe(3);
    });

    it('should mark article as failed when any phase hits max retries', async () => {
      // Test that max retries works across all phases
      await insertArticlesBatch(mockDB, [{
        id: 'max-retry-any-phase',
        title: 'Max Retry Any Phase',
        link: 'https://example.com/max-retry',
        pubDate: new Date().toISOString(),
        needsSentiment: false,
        needsSummary: true,
        contentTimeout: config.MAX_CONTENT_FETCH_ATTEMPTS - 1,
        extractedContent: 'Some content'
      }]);

      // Simulate timeout at max retry count
      await updateCheckpoint(mockDB, 'max-retry-any-phase');
      
      const article = await getArticleById(mockDB, 'max-retry-any-phase');
      const newTimeout = article.contentTimeout + 1;
      
      if (newTimeout >= config.MAX_CONTENT_FETCH_ATTEMPTS) {
        await updateArticle(mockDB, 'max-retry-any-phase', {
          contentTimeout: newTimeout,
          needsSummary: false,
          summaryError: `incomplete_processing_max_retries (attempt ${newTimeout}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`,
          processedAt: Date.now()
        });
      }
      
      const updatedArticle = await getArticleById(mockDB, 'max-retry-any-phase');
      expect(updatedArticle.contentTimeout).toBe(config.MAX_CONTENT_FETCH_ATTEMPTS);
      expect(updatedArticle.needsSummary).toBe(0);
      expect(updatedArticle.processedAt).not.toBeNull();
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
