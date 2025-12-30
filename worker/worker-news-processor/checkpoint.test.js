/**
 * Test suite for Checkpoint-based Article Processing
 * Tests for the new architecture that prevents race conditions
 * Uses actual worker functions with mocked KV interface
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { addToPendingList } from '../worker-news-updater/index.js';
import { processNextArticle, processArticle } from './index.js';

/**
 * Mock KV interface for testing
 */
class MockKV {
  constructor() {
    this.storage = new Map();
    this.writeCount = 0;
    this.readCount = 0;
  }

  async get(key, options) {
    this.readCount++;
    const value = this.storage.get(key);
    if (!value) return null;
    
    if (options?.type === 'json') {
      return JSON.parse(value);
    }
    return value;
  }

  async put(key, value, options) {
    this.writeCount++;
    this.storage.set(key, value);
  }

  async delete(key) {
    this.storage.delete(key);
  }

  reset() {
    this.storage.clear();
    this.writeCount = 0;
    this.readCount = 0;
  }

  getWriteCount() {
    return this.writeCount;
  }

  getReadCount() {
    return this.readCount;
  }
}

/**
 * Mock environment for AI processing
 */
function createMockEnv() {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({ response: 'positive' })
    }
  };
}

/**
 * Mock processArticle function that simulates phase-based processing
 */
function createMockProcessArticle(simulateFailure = false) {
  return vi.fn(async (env, article, config) => {
    const updates = { ...article };
    
    if (simulateFailure) {
      // Simulate failure
      updates.contentTimeout = (updates.contentTimeout || 0) + 1;
      updates.summaryError = 'simulated_failure';
      return updates;
    }
    
    // Simulate phase-based processing - only ONE phase per call
    if (updates.needsSentiment) {
      // Phase 0: Sentiment
      updates.needsSentiment = false;
      updates.sentiment = 'positive';
      return updates;
    }
    
    if (updates.needsSummary) {
      // Phase 1/2: Summary
      updates.needsSummary = false;
      updates.aiSummary = 'Test summary';
      return updates;
    }
    
    return updates;
  });
}

describe('Checkpoint-based Article Processing', () => {
  let mockKV;
  let mockEnv;
  let config;
  
  beforeEach(() => {
    mockKV = new MockKV();
    mockEnv = createMockEnv();
    config = {
      KV_KEY_PENDING: 'BTC_PENDING_LIST',
      KV_KEY_CHECKPOINT: 'BTC_CHECKPOINT',
      KV_KEY_IDS: 'BTC_ID_INDEX',
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      MAX_STORED_ARTICLES: 500,
      ID_INDEX_TTL: 2592000
    };
  });

  describe('Updater Worker - addToPendingList', () => {
    it('should add new articles to pending list', async () => {
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true },
        { id: 'article-2', title: 'Test 2', needsSentiment: true, needsSummary: true }
      ];
      
      const count = await addToPendingList(mockKV, articles, config);
      
      expect(count).toBe(2);
      
      const pendingList = await mockKV.get(config.KV_KEY_PENDING, { type: 'json' });
      expect(pendingList).toHaveLength(2);
      expect(pendingList[0].id).toBe('article-1');
      expect(pendingList[1].id).toBe('article-2');
    });

    it('should not add duplicate articles', async () => {
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true }
      ];
      
      await addToPendingList(mockKV, articles, config);
      const count2 = await addToPendingList(mockKV, articles, config);
      
      expect(count2).toBe(1); // Still only 1 article
      
      const pendingList = await mockKV.get(config.KV_KEY_PENDING, { type: 'json' });
      expect(pendingList).toHaveLength(1);
    });

    it('should trim processed articles from pending list', async () => {
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true },
        { id: 'article-2', title: 'Test 2', needsSentiment: true, needsSummary: true }
      ];
      
      await addToPendingList(mockKV, articles, config);
      
      // Simulate checkpoint with article-1 processed
      await mockKV.put(config.KV_KEY_CHECKPOINT, JSON.stringify({
        processedIds: ['article-1'],
        tryLater: []
      }));
      
      // Add more articles
      const moreArticles = [
        { id: 'article-3', title: 'Test 3', needsSentiment: true, needsSummary: true }
      ];
      
      await addToPendingList(mockKV, moreArticles, config);
      
      const pendingList = await mockKV.get(config.KV_KEY_PENDING, { type: 'json' });
      expect(pendingList).toHaveLength(2); // article-2 and article-3 (article-1 trimmed)
      expect(pendingList.find(item => item.id === 'article-1')).toBeUndefined();
    });
  });

  describe('Processor Worker - processNextArticle', () => {
    it('should process articles from pending list', async () => {
      // Setup pending list
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true }
      ];
      await addToPendingList(mockKV, articles, config);
      
      // Process article with mock function (needs 2 phases: sentiment + summary)
      const mockProcess = createMockProcessArticle(false);
      const result1 = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      const result2 = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      
      expect(result1.processed).toBe(true);
      expect(result1.articleId).toBe('article-1');
      expect(result2.processed).toBe(true);
      expect(result2.articleId).toBe('article-1'); // Same article, second phase
      
      // Check article was written and fully processed
      const article = await mockKV.get('article:article-1', { type: 'json' });
      expect(article.needsSentiment).toBe(false);
      expect(article.needsSummary).toBe(false);
      expect(article.sentiment).toBe('positive');
      expect(article.aiSummary).toBe('Test summary');
      
      // Check checkpoint - should be marked as processed after both phases
      const checkpoint = await mockKV.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
      expect(checkpoint.processedIds).toContain('article-1');
      expect(checkpoint.currentArticleId).toBeNull();
    });

    it('should handle multiple articles sequentially', async () => {
      // Setup pending list with 3 articles
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true },
        { id: 'article-2', title: 'Test 2', needsSentiment: true, needsSummary: true },
        { id: 'article-3', title: 'Test 3', needsSentiment: true, needsSummary: true }
      ];
      await addToPendingList(mockKV, articles, config);
      
      // Process all articles (each needs 2 phases)
      const mockProcess = createMockProcessArticle(false);
      const result1 = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      const result2 = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      const result3 = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      const result4 = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      const result5 = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      const result6 = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      
      expect(result1.articleId).toBe('article-1');
      expect(result2.articleId).toBe('article-1'); // Second phase
      expect(result3.articleId).toBe('article-2');
      expect(result4.articleId).toBe('article-2'); // Second phase
      expect(result5.articleId).toBe('article-3');
      expect(result6.articleId).toBe('article-3'); // Second phase
      
      // Check all articles processed
      const checkpoint = await mockKV.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
      expect(checkpoint.processedIds).toHaveLength(3);
    });

    it('should move failed articles to try-later list', async () => {
      // Setup pending list
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true }
      ];
      await addToPendingList(mockKV, articles, config);
      
      // Process with failure 5 times (to reach max retries)
      const mockProcess = createMockProcessArticle(true);
      for (let i = 0; i < 5; i++) {
        await processNextArticle(mockKV, mockEnv, config, mockProcess);
      }
      
      // Check checkpoint
      const checkpoint = await mockKV.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
      expect(checkpoint.tryLater).toHaveLength(1);
      expect(checkpoint.tryLater[0].id).toBe('article-1');
      expect(checkpoint.processedIds).toContain('article-1');
    });

    it('should process try-later articles when pending list is empty', async () => {
      // Setup checkpoint with try-later article
      await mockKV.put(config.KV_KEY_CHECKPOINT, JSON.stringify({
        processedIds: [],
        tryLater: [
          {
            id: 'article-1',
            article: { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true },
            failedAt: Date.now(),
            reason: 'test'
          }
        ],
        currentArticleId: null,
        currentArticle: null
      }));
      
      // Process should pick from try-later
      const mockProcess = createMockProcessArticle(false);
      const result = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      
      expect(result.processed).toBe(true);
      expect(result.articleId).toBe('article-1');
    });

    it('should return false when no articles to process', async () => {
      const mockProcess = createMockProcessArticle(false);
      const result = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      
      expect(result.processed).toBe(false);
      expect(result.articleId).toBeNull();
    });
  });

  describe('Concurrent Worker Execution', () => {
    it('should not lose articles when updater and processor run simultaneously', async () => {
      // Simulate adding 10 articles
      const articles = Array.from({ length: 10 }, (_, i) => ({
        id: `article-${i + 1}`,
        title: `Test ${i + 1}`,
        needsSentiment: true,
        needsSummary: true
      }));
      
      // Updater adds articles
      await addToPendingList(mockKV, articles, config);
      
      // Process 5 articles (each needs 2 phases = 10 calls)
      const mockProcess = createMockProcessArticle(false);
      for (let i = 0; i < 10; i++) {
        await processNextArticle(mockKV, mockEnv, config, mockProcess);
      }
      
      // Updater adds 5 more articles
      const moreArticles = Array.from({ length: 5 }, (_, i) => ({
        id: `article-${i + 11}`,
        title: `Test ${i + 11}`,
        needsSentiment: true,
        needsSummary: true
      }));
      await addToPendingList(mockKV, moreArticles, config);
      
      // Process remaining articles (10 articles * 2 phases = 20 calls)
      for (let i = 0; i < 20; i++) {
        await processNextArticle(mockKV, mockEnv, config, mockProcess);
      }
      
      // Check all articles processed
      const checkpoint = await mockKV.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
      expect(checkpoint.processedIds.length).toBeGreaterThanOrEqual(15);
      
      // Check ID index
      const idIndex = await mockKV.get(config.KV_KEY_IDS, { type: 'json' });
      expect(idIndex.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('Configuration Tests', () => {
    it('should work with MAX_ARTICLES_PER_RUN = 1', async () => {
      config.MAX_ARTICLES_PER_RUN = 1;
      
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true }
      ];
      await addToPendingList(mockKV, articles, config);
      
      const mockProcess = createMockProcessArticle(false);
      const result = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      
      expect(result.processed).toBe(true);
      expect(result.articleId).toBe('article-1');
    });

    it('should work with MAX_ARTICLES_PER_RUN = 5', async () => {
      config.MAX_ARTICLES_PER_RUN = 5;
      
      const articles = Array.from({ length: 5 }, (_, i) => ({
        id: `article-${i + 1}`,
        title: `Test ${i + 1}`,
        needsSentiment: true,
        needsSummary: true
      }));
      await addToPendingList(mockKV, articles, config);
      
      // Process 5 articles (each needs 2 phases = 10 calls total)
      const mockProcess = createMockProcessArticle(false);
      for (let i = 0; i < 10; i++) {
        const result = await processNextArticle(mockKV, mockEnv, config, mockProcess);
        expect(result.processed).toBe(true);
      }
      
      const checkpoint = await mockKV.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
      expect(checkpoint.processedIds).toHaveLength(5);
    });
  });

  describe('Checkpoint Recovery', () => {
    it('should resume processing after crash', async () => {
      // Setup pending list
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true }
      ];
      await addToPendingList(mockKV, articles, config);
      
      // Start processing (simulate checkpoint update only)
      await mockKV.put(config.KV_KEY_CHECKPOINT, JSON.stringify({
        currentArticleId: 'article-1',
        currentArticle: articles[0],
        processedIds: [],
        tryLater: [],
        lastUpdate: Date.now()
      }));
      
      // Simulate crash and resume
      const mockProcess = createMockProcessArticle(false);
      const result = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      
      expect(result.processed).toBe(true);
      expect(result.articleId).toBe('article-1');
    });

    it('should continue with partial processing', async () => {
      // Setup checkpoint with partially processed article
      const partialArticle = {
        id: 'article-1',
        title: 'Test 1',
        needsSentiment: false,  // Already done
        needsSummary: true,     // Still needs this
        sentiment: 'positive'
      };
      
      await mockKV.put(config.KV_KEY_CHECKPOINT, JSON.stringify({
        currentArticleId: 'article-1',
        currentArticle: partialArticle,
        processedIds: [],
        tryLater: [],
        lastUpdate: Date.now()
      }));
      
      // Resume processing
      const mockProcess = createMockProcessArticle(false);
      const result = await processNextArticle(mockKV, mockEnv, config, mockProcess);
      
      expect(result.processed).toBe(true);
      expect(result.article.needsSentiment).toBe(false);
      expect(result.article.needsSummary).toBe(false);
    });
  });
});
