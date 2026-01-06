/**
 * Integration tests for News Processor with mocked KV and D1
 * Tests the complete workflow with phase-based processing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('News Processor - D1+KV Integration', () => {
  // Mock D1 database
  const createMockD1 = () => {
    const articles = new Map();
    
    return {
      // Store articles in memory
      _articles: articles,
      
      prepare: (sql) => {
        const query = {
          _sql: sql,
          _params: [],
          
          bind: (...params) => {
            query._params = params;
            return query;
          },
          
          run: async () => {
            // Handle INSERT
            if (sql.includes('INSERT')) {
              const [id, ...rest] = query._params;
              articles.set(id, {
                id,
                title: rest[0] || '',
                description: rest[1] || null,
                link: rest[2] || null,
                pubDate: rest[3] || new Date().toISOString(),
                source: rest[4] || null,
                imageUrl: rest[5] || null,
                needsSentiment: rest[6] || 1,
                needsSummary: rest[7] || 1,
                sentiment: rest[8] || null,
                aiSummary: rest[9] || null,
                contentTimeout: rest[10] || 0,
                summaryError: rest[11] || null,
                extractedContent: rest[12] || null,
                queuedAt: rest[13] || Date.now(),
                createdAt: rest[14] || Date.now(),
                updatedAt: rest[15] || Date.now(),
              });
              return { meta: { changes: 1 } };
            }
            
            // Handle UPDATE
            if (sql.includes('UPDATE')) {
              const articleId = query._params[query._params.length - 1];
              const article = articles.get(articleId);
              if (article) {
                // Parse SET clause and update fields
                // The query format is: UPDATE articles SET field1 = ?, field2 = ?, ... WHERE id = ?
                // Parameters are in order: value1, value2, ..., articleId
                const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
                if (setMatch) {
                  const setClause = setMatch[1];
                  const fields = setClause.split(',').map(f => f.trim().split('=')[0].trim());
                  
                  // Update article with new values (params exclude the last one which is articleId)
                  fields.forEach((field, index) => {
                    if (index < query._params.length - 1) {
                      const value = query._params[index];
                      article[field] = value;
                    }
                  });
                }
                article.updatedAt = Date.now();
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            
            // Handle DELETE
            if (sql.includes('DELETE')) {
              const deleteCount = articles.size;
              articles.clear();
              return { meta: { changes: deleteCount } };
            }
            
            return { meta: { changes: 0 } };
          },
          
          all: async () => {
            // Handle SELECT
            if (sql.includes('WHERE needsSentiment = 1 OR needsSummary = 1')) {
              const limit = query._params[0] || 1;
              const results = Array.from(articles.values())
                .filter(a => a.needsSentiment === 1 || a.needsSummary === 1)
                .slice(0, limit);
              return { results };
            }
            
            if (sql.includes('SELECT * FROM articles')) {
              const limit = query._params[0] || 100;
              const results = Array.from(articles.values()).slice(0, limit);
              return { results };
            }
            
            return { results: [] };
          },
          
          first: async () => {
            // Handle SELECT single row
            if (sql.includes('WHERE id = ?')) {
              const id = query._params[0];
              return articles.get(id) || null;
            }
            
            if (sql.includes('processing_checkpoint')) {
              return {
                id: 1,
                currentArticleId: null,
                lastProcessedAt: Date.now(),
                articlesProcessedCount: 0
              };
            }
            
            return null;
          }
        };
        
        return query;
      },
      
      batch: async (statements) => {
        const results = [];
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        return results;
      }
    };
  };
  
  // Mock KV storage
  const createMockKV = () => {
    const store = new Map();
    
    return {
      // Store data in memory
      _store: store,
      
      get: async (key, options) => {
        const value = store.get(key);
        if (!value) return null;
        
        if (options?.type === 'json') {
          return JSON.parse(value);
        }
        return value;
      },
      
      put: async (key, value, options) => {
        store.set(key, value);
      },
      
      delete: async (key) => {
        store.delete(key);
      },
      
      list: async () => {
        return {
          keys: Array.from(store.keys()).map(name => ({ name }))
        };
      }
    };
  };

  let mockDB;
  let mockKV;
  let env;

  beforeEach(() => {
    mockDB = createMockD1();
    mockKV = createMockKV();
    
    env = {
      DB: mockDB,
      CRYPTO_NEWS_CACHE: mockKV,
      AI: {
        run: vi.fn(async () => ({
          response: 'Mocked AI response: positive sentiment'
        }))
      }
    };
  });

  describe('Phase-Based Processing', () => {
    it('should process article through all phases with D1 updates', async () => {
      // Import after mocks are set up
      const { 
        insertArticlesBatch,
        getArticlesNeedingProcessing,
        getArticleById,
        updateArticle
      } = await import('../shared/d1-utils.js');
      
      // Phase 0: Insert article needing processing
      const testArticle = {
        id: 'test-article-1',
        title: 'Test Article',
        link: 'https://example.com/test',
        pubDate: new Date().toISOString(),
        needsSentiment: true,
        needsSummary: true
      };
      
      await insertArticlesBatch(mockDB, [testArticle]);
      
      // Verify article was inserted
      const articles = await getArticlesNeedingProcessing(mockDB, 10);
      expect(articles).toHaveLength(1);
      expect(articles[0].id).toBe('test-article-1');
      expect(articles[0].needsSentiment).toBe(1);
      expect(articles[0].needsSummary).toBe(1);
      
      // Phase 1: Process sentiment
      await updateArticle(mockDB, 'test-article-1', {
        sentiment: 'positive',
        needsSentiment: false
      });
      
      // Verify sentiment was updated
      const afterSentiment = await getArticleById(mockDB, 'test-article-1');
      expect(afterSentiment.sentiment).toBe('positive');
      expect(afterSentiment.needsSentiment).toBe(0);
      expect(afterSentiment.needsSummary).toBe(1); // Still needs summary
      
      // Phase 2: Process summary
      await updateArticle(mockDB, 'test-article-1', {
        aiSummary: 'Test summary content',
        needsSummary: false,
        processedAt: Date.now()
      });
      
      // Verify article is fully processed
      const afterSummary = await getArticleById(mockDB, 'test-article-1');
      expect(afterSummary.aiSummary).toBe('Test summary content');
      expect(afterSummary.needsSentiment).toBe(0);
      expect(afterSummary.needsSummary).toBe(0);
      expect(afterSummary.processedAt).toBeTruthy();
      
      // Verify article no longer appears in pending list
      const stillPending = await getArticlesNeedingProcessing(mockDB, 10);
      expect(stillPending).toHaveLength(0);
    });

    it('should handle processing failures and retry', async () => {
      const { 
        insertArticlesBatch,
        updateArticle,
        getArticleById
      } = await import('../shared/d1-utils.js');
      
      // Insert article
      const testArticle = {
        id: 'failing-article',
        title: 'Failing Article',
        link: 'https://example.com/fail',
        pubDate: new Date().toISOString(),
        needsSentiment: true,
        needsSummary: true
      };
      
      await insertArticlesBatch(mockDB, [testArticle]);
      
      // Simulate failed content fetch (first attempt)
      await updateArticle(mockDB, 'failing-article', {
        contentTimeout: 1,
        summaryError: 'fetch_failed (attempt 1/3)'
      });
      
      let article = await getArticleById(mockDB, 'failing-article');
      expect(article.contentTimeout).toBe(1);
      expect(article.summaryError).toBe('fetch_failed (attempt 1/3)');
      expect(article.needsSummary).toBe(1); // Still needs processing
      
      // Simulate second failed attempt
      await updateArticle(mockDB, 'failing-article', {
        contentTimeout: 2,
        summaryError: 'fetch_failed (attempt 2/3)'
      });
      
      article = await getArticleById(mockDB, 'failing-article');
      expect(article.contentTimeout).toBe(2);
      
      // Simulate final attempt - give up
      await updateArticle(mockDB, 'failing-article', {
        contentTimeout: 0,
        summaryError: 'fetch_failed (max retries)',
        needsSummary: false // Give up
      });
      
      article = await getArticleById(mockDB, 'failing-article');
      expect(article.needsSummary).toBe(0);
      expect(article.contentTimeout).toBe(0);
    });
  });

  describe('KV Integration', () => {
    it('should only write fully processed articles to KV', async () => {
      const { 
        insertArticlesBatch,
        updateArticle,
        getArticleById,
        rowToArticle
      } = await import('../shared/d1-utils.js');
      
      // Insert two articles
      await insertArticlesBatch(mockDB, [
        {
          id: 'article-1',
          title: 'Article 1',
          link: 'https://example.com/1',
          pubDate: new Date().toISOString(),
          needsSentiment: true,
          needsSummary: true
        },
        {
          id: 'article-2',
          title: 'Article 2',
          link: 'https://example.com/2',
          pubDate: new Date().toISOString(),
          needsSentiment: true,
          needsSummary: true
        }
      ]);
      
      // Process article-1 completely
      await updateArticle(mockDB, 'article-1', {
        sentiment: 'positive',
        needsSentiment: false,
        aiSummary: 'Summary 1',
        needsSummary: false,
        processedAt: Date.now()
      });
      
      // Process article-2 partially (only sentiment)
      await updateArticle(mockDB, 'article-2', {
        sentiment: 'neutral',
        needsSentiment: false
      });
      
      // Get articles and check which should be written to KV
      const article1 = await getArticleById(mockDB, 'article-1');
      const article2 = await getArticleById(mockDB, 'article-2');
      
      const isArticle1FullyProcessed = article1.needsSentiment === 0 && article1.needsSummary === 0;
      const isArticle2FullyProcessed = article2.needsSentiment === 0 && article2.needsSummary === 0;
      
      expect(isArticle1FullyProcessed).toBe(true);
      expect(isArticle2FullyProcessed).toBe(false);
      
      // Only write fully processed article to KV
      if (isArticle1FullyProcessed) {
        const articleObj = rowToArticle(article1);
        await mockKV.put(`article:${article1.id}`, JSON.stringify(articleObj));
      }
      
      // Verify KV state
      const kvArticle1 = await mockKV.get('article:article-1', { type: 'json' });
      const kvArticle2 = await mockKV.get('article:article-2', { type: 'json' });
      
      expect(kvArticle1).toBeTruthy();
      expect(kvArticle1.aiSummary).toBe('Summary 1');
      expect(kvArticle2).toBeNull(); // Not written because not fully processed
    });
  });

  describe('Updater KV Management', () => {
    it('should manage KV article ID list and trim D1', async () => {
      const { 
        insertArticlesBatch,
        getArticleIds
      } = await import('../shared/d1-utils.js');
      
      // Simulate updater adding articles to both KV and D1
      const articles = [
        {
          id: 'article-1',
          title: 'Article 1',
          pubDate: new Date().toISOString(),
          needsSentiment: true,
          needsSummary: true
        },
        {
          id: 'article-2',
          title: 'Article 2',
          pubDate: new Date().toISOString(),
          needsSentiment: true,
          needsSummary: true
        },
        {
          id: 'article-3',
          title: 'Article 3',
          pubDate: new Date().toISOString(),
          needsSentiment: true,
          needsSummary: true
        }
      ];
      
      // Add to D1
      await insertArticlesBatch(mockDB, articles);
      
      // Add to KV (individual articles + ID list)
      for (const article of articles) {
        await mockKV.put(`article:${article.id}`, JSON.stringify(article));
      }
      const kvIdList = ['article-1', 'article-2', 'article-3'];
      await mockKV.put('BTC_ID_INDEX', JSON.stringify(kvIdList));
      
      // Verify D1 has all articles
      const d1Ids = await getArticleIds(mockDB, 100);
      expect(d1Ids.size).toBe(3);
      
      // Now updater removes article-3 from KV (source of truth)
      await mockKV.delete('article:article-3');
      const updatedKvIdList = ['article-1', 'article-2'];
      await mockKV.put('BTC_ID_INDEX', JSON.stringify(updatedKvIdList));
      
      // Trimming logic: D1 should remove articles not in KV ID list
      const kvIds = await mockKV.get('BTC_ID_INDEX', { type: 'json' });
      const kvIdSet = new Set(kvIds);
      
      const d1IdsArray = Array.from(d1Ids);
      const idsToDelete = d1IdsArray.filter(id => !kvIdSet.has(id));
      
      expect(idsToDelete).toContain('article-3');
      expect(idsToDelete).not.toContain('article-1');
      expect(idsToDelete).not.toContain('article-2');
      
      // Execute deletion
      for (const id of idsToDelete) {
        await mockDB.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
      }
      
      // Verify D1 now matches KV
      const d1IdsAfterTrim = await getArticleIds(mockDB, 100);
      expect(d1IdsAfterTrim.size).toBe(2);
      expect(d1IdsAfterTrim.has('article-3')).toBe(false);
    });
  });

  describe('API Worker KV-Only Reads', () => {
    it('should read articles from KV without D1 access', async () => {
      // Simulate articles in KV
      const articles = [
        {
          id: 'article-1',
          title: 'Article 1',
          sentiment: 'positive',
          aiSummary: 'Summary 1'
        },
        {
          id: 'article-2',
          title: 'Article 2',
          sentiment: 'negative',
          aiSummary: 'Summary 2'
        }
      ];
      
      // Write to KV
      for (const article of articles) {
        await mockKV.put(`article:${article.id}`, JSON.stringify(article));
      }
      await mockKV.put('BTC_ID_INDEX', JSON.stringify(['article-1', 'article-2']));
      
      // API worker reads from KV only
      const idList = await mockKV.get('BTC_ID_INDEX', { type: 'json' });
      expect(idList).toHaveLength(2);
      
      const articleData = await Promise.all(
        idList.map(id => mockKV.get(`article:${id}`, { type: 'json' }))
      );
      
      expect(articleData).toHaveLength(2);
      expect(articleData[0].title).toBe('Article 1');
      expect(articleData[1].title).toBe('Article 2');
      
      // Calculate sentiment counts
      const sentimentCounts = {
        positive: 0,
        negative: 0,
        neutral: 0
      };
      
      articleData.forEach(article => {
        if (article.sentiment === 'positive') sentimentCounts.positive++;
        if (article.sentiment === 'negative') sentimentCounts.negative++;
        if (article.sentiment === 'neutral') sentimentCounts.neutral++;
      });
      
      expect(sentimentCounts.positive).toBe(1);
      expect(sentimentCounts.negative).toBe(1);
      expect(sentimentCounts.neutral).toBe(0);
    });
  });

  describe('Error Recovery', () => {
    it('should resume processing after worker crash', async () => {
      const { 
        insertArticlesBatch,
        updateArticle,
        getArticleById,
        updateCheckpoint,
        getCheckpoint
      } = await import('../shared/d1-utils.js');
      
      // Insert article and start processing
      await insertArticlesBatch(mockDB, [{
        id: 'crash-article',
        title: 'Crash Test',
        link: 'https://example.com/crash',
        pubDate: new Date().toISOString(),
        needsSentiment: true,
        needsSummary: true
      }]);
      
      // Simulate starting to process
      await updateCheckpoint(mockDB, 'crash-article');
      
      const checkpoint = await getCheckpoint(mockDB);
      expect(checkpoint.currentArticleId).toBe('crash-article');
      
      // Simulate completing sentiment phase
      await updateArticle(mockDB, 'crash-article', {
        sentiment: 'positive',
        needsSentiment: false
      });
      
      // Simulate worker crash (checkpoint still shows processing)
      // On recovery, worker would check checkpoint and see article is still marked as needing summary
      
      const article = await getArticleById(mockDB, 'crash-article');
      expect(article.needsSentiment).toBe(0); // Completed
      expect(article.needsSummary).toBe(1);   // Still needs this
      
      // Recovery: continue processing from where we left off
      await updateArticle(mockDB, 'crash-article', {
        aiSummary: 'Recovered summary',
        needsSummary: false,
        processedAt: Date.now()
      });
      
      await updateCheckpoint(mockDB, null); // Clear checkpoint
      
      const recovered = await getArticleById(mockDB, 'crash-article');
      expect(recovered.needsSummary).toBe(0);
      expect(recovered.aiSummary).toBe('Recovered summary');
    });
  });
});
