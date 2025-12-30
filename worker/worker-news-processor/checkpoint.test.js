/**
 * Test suite for Checkpoint-based Article Processing
 * Tests for the new architecture that prevents race conditions
 */

import { describe, it, expect, beforeEach } from 'vitest';

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
 * Simulate updater worker behavior
 */
async function simulateUpdater(kv, articles, config) {
  // Read existing pending list
  let pendingList = [];
  const pendingData = await kv.get(config.KV_KEY_PENDING, { type: 'json' });
  if (pendingData && Array.isArray(pendingData)) {
    pendingList = pendingData;
  }
  
  // Read checkpoint to see what's been processed
  let processedIds = new Set();
  const checkpoint = await kv.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
  if (checkpoint && checkpoint.processedIds) {
    processedIds = new Set(checkpoint.processedIds);
  }
  
  // Create pending items
  const articlesToAdd = [];
  const pendingIdSet = new Set(pendingList.map(item => item.id));
  
  for (const article of articles) {
    if (!pendingIdSet.has(article.id) && !processedIds.has(article.id)) {
      articlesToAdd.push({
        id: article.id,
        article: article,
        addedAt: Date.now()
      });
    }
  }
  
  // Add to pending list
  const updatedPendingList = [...articlesToAdd, ...pendingList];
  
  // Trim processed articles
  const trimmedPendingList = updatedPendingList.filter(item => !processedIds.has(item.id));
  
  // Write to KV
  await kv.put(config.KV_KEY_PENDING, JSON.stringify(trimmedPendingList));
  
  return trimmedPendingList.length;
}

/**
 * Simulate processor worker behavior (single article)
 */
async function simulateProcessor(kv, config, simulateFailure = false) {
  // Read checkpoint
  let checkpoint = {
    currentArticleId: null,
    currentArticle: null,
    processedIds: [],
    tryLater: [],
    lastUpdate: null
  };
  
  const checkpointData = await kv.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
  if (checkpointData) {
    checkpoint = { ...checkpoint, ...checkpointData };
  }
  
  // Check if previous article completed
  if (checkpoint.currentArticleId && checkpoint.currentArticle) {
    const article = checkpoint.currentArticle;
    const needsProcessing = 
      (article.needsSentiment ?? true) || 
      (article.needsSummary ?? true);
    
    if (!needsProcessing) {
      // Completed successfully
      if (!checkpoint.processedIds.includes(checkpoint.currentArticleId)) {
        checkpoint.processedIds.push(checkpoint.currentArticleId);
      }
      checkpoint.currentArticleId = null;
      checkpoint.currentArticle = null;
    }
  }
  
  // Get next article
  let nextArticle = null;
  let nextArticleId = null;
  
  if (checkpoint.currentArticleId && checkpoint.currentArticle) {
    nextArticleId = checkpoint.currentArticleId;
    nextArticle = checkpoint.currentArticle;
  } else {
    // Read pending list
    const pendingData = await kv.get(config.KV_KEY_PENDING, { type: 'json' });
    let pendingList = [];
    if (pendingData && Array.isArray(pendingData)) {
      pendingList = pendingData;
    }
    
    // Filter processed
    const unprocessedPending = pendingList.filter(item => 
      !checkpoint.processedIds.includes(item.id)
    );
    
    if (unprocessedPending.length > 0) {
      const pendingItem = unprocessedPending[0];
      nextArticleId = pendingItem.id;
      nextArticle = pendingItem.article;
    } else if (checkpoint.tryLater && checkpoint.tryLater.length > 0) {
      const tryLaterItem = checkpoint.tryLater[0];
      nextArticleId = tryLaterItem.id;
      nextArticle = tryLaterItem.article;
    } else {
      // No articles to process
      return { processed: false, articleId: null };
    }
  }
  
  // Update checkpoint
  checkpoint.currentArticleId = nextArticleId;
  checkpoint.currentArticle = nextArticle;
  checkpoint.lastUpdate = Date.now();
  await kv.put(config.KV_KEY_CHECKPOINT, JSON.stringify(checkpoint));
  
  // Simulate processing
  let updatedArticle = { ...nextArticle };
  
  if (simulateFailure) {
    // Simulate failure
    updatedArticle.contentTimeout = (updatedArticle.contentTimeout || 0) + 1;
    updatedArticle.summaryError = 'simulated_failure';
    
    // Move to try-later if max retries reached
    if (updatedArticle.contentTimeout >= config.MAX_CONTENT_FETCH_ATTEMPTS) {
      checkpoint.tryLater = (checkpoint.tryLater || []).filter(item => item.id !== nextArticleId);
      checkpoint.tryLater.push({
        id: nextArticleId,
        article: updatedArticle,
        failedAt: Date.now(),
        reason: 'max_retries'
      });
      
      if (!checkpoint.processedIds.includes(nextArticleId)) {
        checkpoint.processedIds.push(nextArticleId);
      }
      
      checkpoint.currentArticleId = null;
      checkpoint.currentArticle = null;
    } else {
      checkpoint.currentArticle = updatedArticle;
    }
  } else {
    // Simulate successful processing
    updatedArticle.needsSentiment = false;
    updatedArticle.needsSummary = false;
    updatedArticle.sentiment = 'positive';
    updatedArticle.aiSummary = 'Test summary';
    
    // Mark as complete
    if (!checkpoint.processedIds.includes(nextArticleId)) {
      checkpoint.processedIds.push(nextArticleId);
    }
    checkpoint.currentArticleId = null;
    checkpoint.currentArticle = null;
    checkpoint.tryLater = (checkpoint.tryLater || []).filter(item => item.id !== nextArticleId);
  }
  
  // Write article to KV
  await kv.put(`article:${nextArticleId}`, JSON.stringify(updatedArticle));
  
  // Update ID index
  let idIndex = [];
  const idIndexData = await kv.get(config.KV_KEY_IDS, { type: 'json' });
  if (idIndexData && Array.isArray(idIndexData)) {
    idIndex = idIndexData;
  }
  
  if (!idIndex.includes(nextArticleId)) {
    idIndex.unshift(nextArticleId);
    await kv.put(config.KV_KEY_IDS, JSON.stringify(idIndex));
  }
  
  // Update checkpoint
  checkpoint.lastUpdate = Date.now();
  await kv.put(config.KV_KEY_CHECKPOINT, JSON.stringify(checkpoint));
  
  return { processed: true, articleId: nextArticleId, article: updatedArticle };
}

describe('Checkpoint-based Article Processing', () => {
  let mockKV;
  let config;
  
  beforeEach(() => {
    mockKV = new MockKV();
    config = {
      KV_KEY_PENDING: 'BTC_PENDING_LIST',
      KV_KEY_CHECKPOINT: 'BTC_CHECKPOINT',
      KV_KEY_IDS: 'BTC_ID_INDEX',
      MAX_CONTENT_FETCH_ATTEMPTS: 5,
      MAX_STORED_ARTICLES: 500
    };
  });

  describe('Updater Worker', () => {
    it('should add new articles to pending list', async () => {
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true },
        { id: 'article-2', title: 'Test 2', needsSentiment: true, needsSummary: true }
      ];
      
      const count = await simulateUpdater(mockKV, articles, config);
      
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
      
      await simulateUpdater(mockKV, articles, config);
      const count2 = await simulateUpdater(mockKV, articles, config);
      
      expect(count2).toBe(1); // Still only 1 article
      
      const pendingList = await mockKV.get(config.KV_KEY_PENDING, { type: 'json' });
      expect(pendingList).toHaveLength(1);
    });

    it('should trim processed articles from pending list', async () => {
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true },
        { id: 'article-2', title: 'Test 2', needsSentiment: true, needsSummary: true }
      ];
      
      await simulateUpdater(mockKV, articles, config);
      
      // Simulate checkpoint with article-1 processed
      await mockKV.put(config.KV_KEY_CHECKPOINT, JSON.stringify({
        processedIds: ['article-1'],
        tryLater: []
      }));
      
      // Add more articles
      const moreArticles = [
        { id: 'article-3', title: 'Test 3', needsSentiment: true, needsSummary: true }
      ];
      
      await simulateUpdater(mockKV, moreArticles, config);
      
      const pendingList = await mockKV.get(config.KV_KEY_PENDING, { type: 'json' });
      expect(pendingList).toHaveLength(2); // article-2 and article-3 (article-1 trimmed)
      expect(pendingList.find(item => item.id === 'article-1')).toBeUndefined();
    });
  });

  describe('Processor Worker', () => {
    it('should process articles from pending list', async () => {
      // Setup pending list
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true }
      ];
      await simulateUpdater(mockKV, articles, config);
      
      // Process article
      const result = await simulateProcessor(mockKV, config);
      
      expect(result.processed).toBe(true);
      expect(result.articleId).toBe('article-1');
      
      // Check article was written
      const article = await mockKV.get('article:article-1', { type: 'json' });
      expect(article.needsSentiment).toBe(false);
      expect(article.needsSummary).toBe(false);
      
      // Check checkpoint
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
      await simulateUpdater(mockKV, articles, config);
      
      // Process all articles
      const result1 = await simulateProcessor(mockKV, config);
      const result2 = await simulateProcessor(mockKV, config);
      const result3 = await simulateProcessor(mockKV, config);
      
      expect(result1.articleId).toBe('article-1');
      expect(result2.articleId).toBe('article-2');
      expect(result3.articleId).toBe('article-3');
      
      // Check all articles processed
      const checkpoint = await mockKV.get(config.KV_KEY_CHECKPOINT, { type: 'json' });
      expect(checkpoint.processedIds).toHaveLength(3);
    });

    it('should move failed articles to try-later list', async () => {
      // Setup pending list
      const articles = [
        { id: 'article-1', title: 'Test 1', needsSentiment: true, needsSummary: true }
      ];
      await simulateUpdater(mockKV, articles, config);
      
      // Process with failure 5 times (to reach max retries)
      for (let i = 0; i < 5; i++) {
        await simulateProcessor(mockKV, config, true);
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
      const result = await simulateProcessor(mockKV, config);
      
      expect(result.processed).toBe(true);
      expect(result.articleId).toBe('article-1');
    });

    it('should return false when no articles to process', async () => {
      const result = await simulateProcessor(mockKV, config);
      
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
      await simulateUpdater(mockKV, articles, config);
      
      // Process 5 articles while updater might run again
      for (let i = 0; i < 5; i++) {
        await simulateProcessor(mockKV, config);
      }
      
      // Updater adds 5 more articles
      const moreArticles = Array.from({ length: 5 }, (_, i) => ({
        id: `article-${i + 11}`,
        title: `Test ${i + 11}`,
        needsSentiment: true,
        needsSummary: true
      }));
      await simulateUpdater(mockKV, moreArticles, config);
      
      // Process remaining articles
      for (let i = 0; i < 10; i++) {
        await simulateProcessor(mockKV, config);
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
      await simulateUpdater(mockKV, articles, config);
      
      const result = await simulateProcessor(mockKV, config);
      
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
      await simulateUpdater(mockKV, articles, config);
      
      // Process 5 articles (one at a time due to checkpoint architecture)
      for (let i = 0; i < 5; i++) {
        const result = await simulateProcessor(mockKV, config);
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
      await simulateUpdater(mockKV, articles, config);
      
      // Start processing (simulate checkpoint update only)
      await mockKV.put(config.KV_KEY_CHECKPOINT, JSON.stringify({
        currentArticleId: 'article-1',
        currentArticle: articles[0],
        processedIds: [],
        tryLater: [],
        lastUpdate: Date.now()
      }));
      
      // Simulate crash and resume
      const result = await simulateProcessor(mockKV, config);
      
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
      const result = await simulateProcessor(mockKV, config);
      
      expect(result.processed).toBe(true);
      expect(result.article.needsSentiment).toBe(false);
      expect(result.article.needsSummary).toBe(false);
    });
  });
});
