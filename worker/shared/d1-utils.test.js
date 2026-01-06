/**
 * Tests for D1 Database Utilities
 * Validates that all schema fields are properly handled in CRUD operations
 * 
 * These tests ensure that the bug where extractedContent was silently dropped
 * doesn't happen with any other field.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  insertArticle,
  insertArticlesBatch,
  updateArticle,
  getArticleById,
  rowToArticle
} from './d1-utils.js';

describe('D1 Utils - Schema Field Completeness', () => {
  // Simplified mock D1 for testing field persistence
  const createMockD1 = () => {
    const articles = new Map();
    
    return {
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
                needsSentiment: rest[6],
                needsSummary: rest[7],
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
                const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/is);
                if (setMatch) {
                  const setClause = setMatch[1];
                  const fields = setClause.split(',').map(f => f.trim().split('=')[0].trim());
                  
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
            
            return { meta: { changes: 0 } };
          },
          
          first: async () => {
            if (sql.includes('WHERE id = ?')) {
              const id = query._params[0];
              return articles.get(id) || null;
            }
            return null;
          },
          
          all: async () => {
            return { results: Array.from(articles.values()) };
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

  let mockDB;

  beforeEach(() => {
    mockDB = createMockD1();
  });

  describe('insertArticle - No Fields Dropped', () => {
    it('should persist all provided fields to database', async () => {
      const article = {
        id: 'test-123',
        title: 'Test Article',
        description: 'Test description',
        link: 'https://example.com',
        pubDate: '2024-01-01T00:00:00.000Z',
        source: 'Test Source',
        imageUrl: 'https://example.com/image.jpg',
        needsSentiment: true,
        needsSummary: true,
        sentiment: 'positive',
        aiSummary: 'Test summary',
        contentTimeout: 1,
        summaryError: 'Test error',
        extractedContent: 'Test content',
        queuedAt: Date.now()
      };

      await insertArticle(mockDB, article);

      // Verify article was stored with all fields
      const stored = mockDB._articles.get('test-123');
      expect(stored).toBeDefined();
      expect(stored.id).toBe('test-123');
      expect(stored.title).toBe('Test Article');
      expect(stored.description).toBe('Test description');
      expect(stored.link).toBe('https://example.com');
      expect(stored.source).toBe('Test Source');
      expect(stored.imageUrl).toBe('https://example.com/image.jpg');
      expect(stored.sentiment).toBe('positive');
      expect(stored.aiSummary).toBe('Test summary');
      expect(stored.contentTimeout).toBe(1);
      expect(stored.summaryError).toBe('Test error');
      expect(stored.extractedContent).toBe('Test content');
      expect(stored.needsSentiment).toBe(1);
      expect(stored.needsSummary).toBe(1);
    });

    it('should not silently drop extractedContent or any other field', async () => {
      const article = {
        id: 'test-456',
        title: 'Another Test',
        description: 'Another description',
        link: 'https://example2.com',
        source: 'Source 2',
        imageUrl: 'https://example2.com/img.jpg',
        sentiment: 'negative',
        aiSummary: 'Summary 2',
        contentTimeout: 2,
        summaryError: 'Error 2',
        extractedContent: 'Content 2',
        needsSentiment: false,
        needsSummary: false
      };

      await insertArticle(mockDB, article);

      const stored = mockDB._articles.get('test-456');
      
      // Check all fields are present and match input
      expect(stored.title).toBe('Another Test');
      expect(stored.description).toBe('Another description');
      expect(stored.link).toBe('https://example2.com');
      expect(stored.source).toBe('Source 2');
      expect(stored.imageUrl).toBe('https://example2.com/img.jpg');
      expect(stored.sentiment).toBe('negative');
      expect(stored.aiSummary).toBe('Summary 2');
      expect(stored.contentTimeout).toBe(2);
      expect(stored.summaryError).toBe('Error 2');
      expect(stored.extractedContent).toBe('Content 2');
      expect(stored.needsSentiment).toBe(0);
      expect(stored.needsSummary).toBe(0);
    });
  });

  describe('insertArticlesBatch - No Fields Dropped', () => {
    it('should persist extractedContent in batch inserts', async () => {
      const articles = [
        {
          id: 'batch-1',
          title: 'Batch 1',
          extractedContent: 'Content 1',
          sentiment: 'positive',
          aiSummary: 'Summary 1'
        },
        {
          id: 'batch-2',
          title: 'Batch 2',
          extractedContent: 'Content 2',
          sentiment: 'negative',
          aiSummary: 'Summary 2'
        }
      ];

      await insertArticlesBatch(mockDB, articles);

      // Verify both articles were stored with all fields
      const stored1 = mockDB._articles.get('batch-1');
      const stored2 = mockDB._articles.get('batch-2');
      
      expect(stored1).toBeDefined();
      expect(stored1.extractedContent).toBe('Content 1');
      expect(stored1.sentiment).toBe('positive');
      expect(stored1.aiSummary).toBe('Summary 1');
      
      expect(stored2).toBeDefined();
      expect(stored2.extractedContent).toBe('Content 2');
      expect(stored2.sentiment).toBe('negative');
      expect(stored2.aiSummary).toBe('Summary 2');
    });
  });

  describe('updateArticle - No Fields Dropped', () => {
    it('should update all updatable fields including extractedContent', async () => {
      // First insert an article
      await insertArticle(mockDB, {
        id: 'update-test',
        title: 'Original Title'
      });

      // Update with all fields that should be updatable
      const updates = {
        sentiment: 'positive',
        aiSummary: 'Updated summary',
        needsSentiment: false,
        needsSummary: false,
        contentTimeout: 3,
        summaryError: 'New error',
        extractedContent: 'New content',
        processedAt: Date.now()
      };

      await updateArticle(mockDB, 'update-test', updates);

      // Verify all fields were updated
      const stored = mockDB._articles.get('update-test');
      expect(stored.sentiment).toBe('positive');
      expect(stored.aiSummary).toBe('Updated summary');
      expect(stored.extractedContent).toBe('New content');
      expect(stored.contentTimeout).toBe(3);
      expect(stored.summaryError).toBe('New error');
      expect(stored.needsSentiment).toBe(0);
      expect(stored.needsSummary).toBe(0);
    });

    it('should not silently drop extractedContent during Phase 1 update', async () => {
      // This reproduces the original bug scenario
      await insertArticle(mockDB, {
        id: 'phase1-test',
        title: 'Phase 1 Test',
        needsSummary: true
      });

      // Phase 1: Content scraping - save extractedContent
      await updateArticle(mockDB, 'phase1-test', {
        extractedContent: 'Scraped HTML content from article',
        contentTimeout: 1,
        summaryError: 'scraping_complete (attempt 1/5)'
      });

      // Verify extractedContent was persisted (this was the bug)
      const stored = mockDB._articles.get('phase1-test');
      expect(stored.extractedContent).toBe('Scraped HTML content from article');
      expect(stored.contentTimeout).toBe(1);
      expect(stored.summaryError).toBe('scraping_complete (attempt 1/5)');
    });

    it('should clear extractedContent when explicitly set to null', async () => {
      // Insert with extractedContent
      await insertArticle(mockDB, {
        id: 'clear-test',
        title: 'Clear Test',
        extractedContent: 'Old content'
      });

      // Phase 2: AI processing - clear extractedContent (use null, not undefined)
      await updateArticle(mockDB, 'clear-test', {
        aiSummary: 'Generated summary',
        extractedContent: null,
        needsSummary: false
      });

      const stored = mockDB._articles.get('clear-test');
      expect(stored.aiSummary).toBe('Generated summary');
      expect(stored.extractedContent).toBeNull();
      expect(stored.needsSummary).toBe(0);
    });
  });

  describe('rowToArticle - No Fields Dropped', () => {
    it('should convert all schema fields from D1 row to article object', async () => {
      const dbRow = {
        id: 'row-test',
        title: 'Row Test',
        description: 'Test description',
        link: 'https://example.com',
        pubDate: '2024-01-01T00:00:00.000Z',
        source: 'Test Source',
        imageUrl: 'https://example.com/img.jpg',
        needsSentiment: 1,
        needsSummary: 0,
        sentiment: 'positive',
        aiSummary: 'Test summary',
        contentTimeout: 2,
        summaryError: 'Test error',
        extractedContent: 'Test content',
        queuedAt: 1234567890,
        processedAt: 1234567900,
        createdAt: 1234567800,
        updatedAt: 1234567850
      };

      const article = rowToArticle(dbRow);

      // Verify all fields are present in converted object
      expect(article.id).toBe('row-test');
      expect(article.title).toBe('Row Test');
      expect(article.description).toBe('Test description');
      expect(article.link).toBe('https://example.com');
      expect(article.pubDate).toBe('2024-01-01T00:00:00.000Z');
      expect(article.source).toBe('Test Source');
      expect(article.imageUrl).toBe('https://example.com/img.jpg');
      expect(article.needsSentiment).toBe(true);  // Converted from 1
      expect(article.needsSummary).toBe(false);   // Converted from 0
      expect(article.sentiment).toBe('positive');
      expect(article.aiSummary).toBe('Test summary');
      expect(article.contentTimeout).toBe(2);
      expect(article.summaryError).toBe('Test error');
      expect(article.extractedContent).toBe('Test content');
      expect(article.queuedAt).toBe(1234567890);
      expect(article.processedAt).toBe(1234567900);
      expect(article.createdAt).toBe(1234567800);
      expect(article.updatedAt).toBe(1234567850);
    });

    it('should not silently drop extractedContent field', async () => {
      const dbRow = {
        id: 'extract-test',
        title: 'Extract Test',
        extractedContent: 'Important scraped content',
        needsSentiment: 0,
        needsSummary: 1
      };

      const article = rowToArticle(dbRow);

      expect(article.extractedContent).toBe('Important scraped content');
      expect(article.id).toBe('extract-test');
      expect(article.title).toBe('Extract Test');
    });
  });

  describe('Round-trip Persistence (Integration)', () => {
    it('should preserve all fields through insert → read → update cycle', async () => {
      // Insert article with all fields
      const original = {
        id: 'roundtrip-test',
        title: 'Round Trip Test',
        description: 'Full description',
        link: 'https://example.com/article',
        pubDate: '2024-01-01T00:00:00.000Z',
        source: 'News Source',
        imageUrl: 'https://example.com/image.jpg',
        needsSentiment: true,
        needsSummary: true,
        sentiment: null,
        aiSummary: null,
        contentTimeout: 0,
        summaryError: null,
        extractedContent: null
      };

      await insertArticle(mockDB, original);

      // Read back
      const read = await getArticleById(mockDB, 'roundtrip-test');
      const article = rowToArticle(read);

      // Update with extracted content (simulating Phase 1)
      await updateArticle(mockDB, 'roundtrip-test', {
        extractedContent: 'Scraped content from webpage',
        contentTimeout: 1,
        summaryError: 'scraping_complete (attempt 1/5)'
      });

      // Read again
      const updated = await getArticleById(mockDB, 'roundtrip-test');
      const articleUpdated = rowToArticle(updated);

      // Verify extracted content was persisted
      expect(articleUpdated.extractedContent).toBe('Scraped content from webpage');
      expect(articleUpdated.contentTimeout).toBe(1);
      expect(articleUpdated.summaryError).toBe('scraping_complete (attempt 1/5)');
      
      // Verify other fields weren't lost
      expect(articleUpdated.id).toBe('roundtrip-test');
      expect(articleUpdated.title).toBe('Round Trip Test');
      expect(articleUpdated.description).toBe('Full description');
      expect(articleUpdated.link).toBe('https://example.com/article');
    });
  });
});
