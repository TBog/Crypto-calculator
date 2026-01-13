/**
 * Comprehensive tests for article processing through all phases
 * Tests complete workflow: Phase 0 (Sentiment) → Phase 1 (Content Scraping) → Phase 2 (AI Summary)
 * 
 * This test suite addresses the issue: "Missing processing phase that should summarize the article"
 * It validates that all three phases execute correctly in sequence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processArticle } from './index.js';

describe('Complete Article Processing - All Phases', () => {
  let mockDB;
  let mockEnv;
  let config;
  let consoleLogs;

  beforeEach(() => {
    // Capture console logs to verify phase execution
    consoleLogs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      consoleLogs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      consoleLogs.push('[ERROR] ' + args.join(' '));
    });

    // Mock D1 database
    const articles = new Map();
    mockDB = {
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
            if (sql.includes('UPDATE')) {
              const articleId = query._params[query._params.length - 1];
              const article = articles.get(articleId);
              if (article) {
                const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
                if (setMatch) {
                  const setClause = setMatch[1];
                  const fields = setClause.split(',').map(f => f.trim().split('=')[0].trim());
                  fields.forEach((field, index) => {
                    if (index < query._params.length - 1) {
                      article[field] = query._params[index];
                    }
                  });
                }
                article.updatedAt = Date.now();
                return { meta: { changes: 1 } };
              }
            }
            return { meta: { changes: 0 } };
          },
          first: async () => {
            if (sql.includes('processing_checkpoint')) {
              return {
                id: 1,
                currentArticleId: null,
                lastProcessedAt: Date.now(),
                articlesProcessedCount: 0
              };
            }
            if (sql.includes('WHERE id = ?')) {
              return articles.get(query._params[0]) || null;
            }
            return null;
          },
          all: async () => {
            if (sql.includes('WHERE needsSentiment = 1 OR needsSummary = 1')) {
              const results = Array.from(articles.values())
                .filter(a => a.needsSentiment === 1 || a.needsSummary === 1);
              return { results };
            }
            return { results: [] };
          }
        };
        return query;
      }
    };

    // Mock environment with AI
    mockEnv = {
      DB: mockDB,
      AI: {
        run: vi.fn(async (model, params) => {
          // Mock sentiment analysis
          if (params.messages[0].content.includes('sentiment')) {
            return { response: 'positive' };
          }
          // Mock summary generation - check if it's a summarization request
          if (params.messages[0].content.includes('summarization assistant') || 
              params.messages[1]?.content?.includes('provide a summary')) {
            return { response: 'SUMMARY: This is a comprehensive AI-generated summary of the Bitcoin article discussing market trends and price movements.' };
          }
          return { response: 'neutral' };
        })
      }
    };

    // Default config
    config = {
      MAX_CONTENT_FETCH_ATTEMPTS: 3,
      MAX_CONTENT_CHARS: 10 * 1024,
      MAX_ARTICLES_PER_RUN: 1
    };
  });

  describe('Phase 0: Sentiment Analysis', () => {
    it('should execute Phase 0 and log sentiment analysis', async () => {
      const article = {
        id: 'test-article-phase0',
        title: 'Bitcoin Price Surges',
        description: 'Bitcoin hits new highs',
        link: 'https://example.com/article',
        needsSentiment: true,
        needsSummary: true
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 1,
        needsSummary: 1
      });

      const result = await processArticle(mockDB, mockEnv, article, config);

      // Verify Phase 0 executed
      expect(consoleLogs.some(log => log.includes('Phase 0: Analyzing sentiment'))).toBe(true);
      expect(consoleLogs.some(log => log.includes('✓ Sentiment:'))).toBe(true);
      
      // Verify sentiment was set
      expect(result.sentiment).toBeDefined();
      expect(result.needsSentiment).toBe(false);
      
      // Should NOT execute Phase 1 or 2 in same run
      expect(consoleLogs.some(log => log.includes('Phase 1:'))).toBe(false);
      expect(consoleLogs.some(log => log.includes('Phase 2:'))).toBe(false);
    });

    it('should mark needsSentiment as false after Phase 0', async () => {
      const article = {
        id: 'test-sentiment-complete',
        title: 'Test Article',
        needsSentiment: true,
        needsSummary: true
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 1,
        needsSummary: 1
      });

      const result = await processArticle(mockDB, mockEnv, article, config);

      expect(result.needsSentiment).toBe(false);
      expect(result.sentiment).toBeTruthy();
    });
  });

  describe('Phase 1: Content Scraping', () => {
    it('should execute Phase 1 when sentiment is complete and article has link', async () => {
      const article = {
        id: 'test-article-phase1',
        title: 'Bitcoin Market Analysis',
        link: 'https://example.com/article',
        needsSentiment: false,  // Phase 0 already complete
        needsSummary: true,
        sentiment: 'positive'
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 0,
        needsSummary: 1
      });

      const result = await processArticle(mockDB, mockEnv, article, config);

      // Verify Phase 1 attempted (will fail in test environment due to lack of HTMLRewriter, but logs should show it tried)
      expect(consoleLogs.some(log => log.includes('Phase 1: Fetching article content'))).toBe(true);
      
      // In test environment without real fetch/HTMLRewriter, contentTimeout will increment
      expect(result.contentTimeout).toBe(1);
    });

    it('should skip Phase 1 when article has no link', async () => {
      const article = {
        id: 'test-no-link',
        title: 'Test Article',
        needsSentiment: false,
        needsSummary: true,
        sentiment: 'positive'
        // No link property
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 0,
        needsSummary: 1
      });

      const result = await processArticle(mockDB, mockEnv, article, config);

      // Should log no link message
      expect(consoleLogs.some(log => log.includes('AI Summary: No link available'))).toBe(true);
      expect(result.needsSummary).toBe(false);
      expect(result.summaryError).toBe('no_link');
    });
  });

  describe('Phase 2: AI Summary Generation', () => {
    it('should execute Phase 2 when content is extracted', async () => {
      const article = {
        id: 'test-article-phase2',
        title: 'Bitcoin Analysis',
        link: 'https://example.com/article',
        needsSentiment: false,  // Phase 0 complete
        needsSummary: true,
        sentiment: 'positive',
        extractedContent: 'Bitcoin is performing well in the market. The price has increased significantly over the past month. Analysts are optimistic about future growth.'  // Phase 1 complete
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 0,
        needsSummary: 1
      });

      const result = await processArticle(mockDB, mockEnv, article, config);

      // Verify Phase 2 executed
      expect(consoleLogs.some(log => log.includes('Phase 2: Using previously extracted content'))).toBe(true);
      expect(consoleLogs.some(log => log.includes('Generating AI summary'))).toBe(true);
      expect(consoleLogs.some(log => log.includes('✓ AI Summary: Generated'))).toBe(true);
      
      // Verify summary was generated
      expect(result.aiSummary).toBeDefined();
      expect(result.needsSummary).toBe(false);
      expect(result.extractedContent).toBeUndefined(); // Should be cleared after Phase 2
    });

    it('should log Phase 2 start and completion', async () => {
      const article = {
        id: 'test-phase2-logging',
        title: 'Bitcoin News',
        link: 'https://example.com/article',  // Link is required for Phase 2 to execute
        needsSentiment: false,
        needsSummary: true,
        extractedContent: 'Sample extracted content for AI processing with sufficient length to pass the minimum 100 character check that is required for AI summary generation.'
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 0,
        needsSummary: 1
      });

      await processArticle(mockDB, mockEnv, article, config);

      // Verify Phase 2 logging includes phase start and key steps
      expect(consoleLogs.some(log => log.includes('Phase 2:'))).toBe(true);
      expect(consoleLogs.some(log => log.includes('Decoded content'))).toBe(true);
      expect(consoleLogs.some(log => log.includes('Generating AI summary'))).toBe(true);
    });

    it('should execute Phase 2 and attempt AI summary generation', async () => {
      const article = {
        id: 'test-cleanup',
        title: 'Bitcoin Article',
        link: 'https://example.com/article',  // Link is required
        needsSentiment: false,
        needsSummary: true,
        extractedContent: 'Content to be cleared after summarization with enough text to trigger AI processing.'
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 0,
        needsSummary: 1
      });

      const result = await processArticle(mockDB, mockEnv, article, config);

      // Verify Phase 2 executed
      expect(consoleLogs.some(log => log.includes('Phase 2:'))).toBe(true);
      expect(consoleLogs.some(log => log.includes('Generating AI summary'))).toBe(true);
      
      // After Phase 2 completes (successfully or not), extractedContent should be cleared
      // and needsSummary should be false
      expect(result.needsSummary).toBe(false);
    });
  });

  describe('Complete Processing Workflow', () => {
    it('should process article through all 3 phases in sequence (Phase 0 → Phase 1 → Phase 2)', async () => {
      const articleId = 'complete-workflow-test';
      const initialArticle = {
        id: articleId,
        title: 'Complete Workflow Test',
        description: 'Testing all phases',
        link: 'https://example.com/complete',
        needsSentiment: true,
        needsSummary: true
      };

      mockDB._articles.set(articleId, {
        ...initialArticle,
        needsSentiment: 1,
        needsSummary: 1
      });

      // Phase 0: Sentiment Analysis
      consoleLogs = [];
      let article = { ...initialArticle };
      let result = await processArticle(mockDB, mockEnv, article, config);
      
      expect(consoleLogs.some(log => log.includes('Phase 0:'))).toBe(true);
      expect(result.needsSentiment).toBe(false);
      expect(result.sentiment).toBeDefined();

      // Phase 1: Content Scraping (will fail in test but shows it attempted)
      consoleLogs = [];
      article = { ...result };
      mockDB._articles.set(articleId, {
        ...mockDB._articles.get(articleId),
        needsSentiment: 0,
        sentiment: result.sentiment
      });
      result = await processArticle(mockDB, mockEnv, article, config);
      
      expect(consoleLogs.some(log => log.includes('Phase 1:'))).toBe(true);
      // Phase 1 increments contentTimeout when fetch fails
      expect(result.contentTimeout).toBe(1);

      // Phase 2: AI Summary (simulate having extracted content)
      consoleLogs = [];
      article = { ...result, extractedContent: 'Simulated extracted content from Phase 1 with enough text to trigger summarization properly in this test.', link: 'https://example.com/complete' };
      mockDB._articles.set(articleId, {
        ...mockDB._articles.get(articleId),
        extractedContent: article.extractedContent
      });
      result = await processArticle(mockDB, mockEnv, article, config);
      
      expect(consoleLogs.some(log => log.includes('Phase 2:'))).toBe(true);
      expect(result.aiSummary).toBeDefined();
      expect(result.needsSummary).toBe(false);
      expect(result.extractedContent).toBeUndefined();

      // Verify all phases completed
      expect(result.sentiment).toBeDefined();
      expect(result.aiSummary).toBeDefined();
      expect(result.needsSentiment).toBe(false);
      expect(result.needsSummary).toBe(false);
    });

    it('should have distinct logs for each phase', async () => {
      const articleId = 'phase-logging-test';
      
      // Track all logs across phases
      const allPhaseLogs = [];
      
      // Phase 0
      mockDB._articles.set(articleId, {
        id: articleId,
        title: 'Test',
        needsSentiment: 1,
        needsSummary: 1
      });
      consoleLogs = [];
      await processArticle(mockDB, mockEnv, { id: articleId, title: 'Test', needsSentiment: true, needsSummary: true }, config);
      allPhaseLogs.push(...consoleLogs);

      // Phase 1 - will attempt and log
      mockDB._articles.set(articleId, {
        ...mockDB._articles.get(articleId),
        needsSentiment: 0,
        sentiment: 'positive',
        link: 'https://example.com/test'
      });
      consoleLogs = [];
      await processArticle(mockDB, mockEnv, { 
        id: articleId, 
        title: 'Test', 
        link: 'https://example.com/test',
        needsSentiment: false, 
        needsSummary: true,
        sentiment: 'positive'
      }, config);
      allPhaseLogs.push(...consoleLogs);

      // Phase 2 - with simulated content
      mockDB._articles.set(articleId, {
        ...mockDB._articles.get(articleId),
        extractedContent: 'Sample content with enough text to process and meet the minimum character requirements for AI summarization.'
      });
      consoleLogs = [];
      await processArticle(mockDB, mockEnv, { 
        id: articleId, 
        title: 'Test',
        link: 'https://example.com/test',  // Link is required
        needsSentiment: false, 
        needsSummary: true,
        extractedContent: 'Sample content with enough text to process and meet the minimum character requirements for AI summarization.'
      }, config);
      allPhaseLogs.push(...consoleLogs);

      // Verify each phase has distinct logging
      expect(allPhaseLogs.some(log => log.includes('Phase 0:'))).toBe(true);
      expect(allPhaseLogs.some(log => log.includes('Phase 1:'))).toBe(true);
      expect(allPhaseLogs.some(log => log.includes('Phase 2:'))).toBe(true);
      
      // Verify completion/status logs for all phases
      expect(allPhaseLogs.some(log => log.includes('✓ Sentiment:'))).toBe(true);
      expect(allPhaseLogs.some(log => log.includes('✓ AI Summary: Generated'))).toBe(true);
    });
  });

  describe('Phase Execution Verification', () => {
    it('should execute only one phase per call', async () => {
      const article = {
        id: 'single-phase-test',
        title: 'Test Article',
        needsSentiment: true,
        needsSummary: true
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 1,
        needsSummary: 1
      });

      consoleLogs = [];
      await processArticle(mockDB, mockEnv, article, config);

      // Count phase mentions
      const phaseCount = consoleLogs.filter(log => 
        log.includes('Phase 0:') || 
        log.includes('Phase 1:') || 
        log.includes('Phase 2:')
      ).length;

      expect(phaseCount).toBe(1); // Only one phase should execute
    });

    it('should not skip phases', async () => {
      // Verify we cannot jump from Phase 0 directly to Phase 2
      const article = {
        id: 'no-skip-test',
        title: 'Test',
        needsSentiment: true,
        needsSummary: true,
        // NO extractedContent, so Phase 2 should not run
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 1,
        needsSummary: 1
      });

      consoleLogs = [];
      await processArticle(mockDB, mockEnv, article, config);

      // Should only see Phase 0
      expect(consoleLogs.some(log => log.includes('Phase 0:'))).toBe(true);
      expect(consoleLogs.some(log => log.includes('Phase 2:'))).toBe(false);
    });

    it('should require extractedContent for Phase 2 to execute', async () => {
      const article = {
        id: 'phase2-requirement-test',
        title: 'Test Article',
        link: 'https://example.com/test',
        needsSentiment: false,  // Phase 0 complete
        needsSummary: true,
        // NO extractedContent - this is the problem in production!
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 0,
        needsSummary: 1
      });

      consoleLogs = [];
      await processArticle(mockDB, mockEnv, article, config);

      // Phase 1 should run (attempting to fetch content)
      expect(consoleLogs.some(log => log.includes('Phase 1:'))).toBe(true);
      
      // Phase 2 should NOT run because extractedContent is not present
      expect(consoleLogs.some(log => log.includes('Phase 2:'))).toBe(false);
      
      // This demonstrates the production issue: if Phase 1 fails to fetch content,
      // Phase 2 will never execute, even though needsSummary = true
    });

    it('should demonstrate Phase 2 only runs with extractedContent present', async () => {
      const article = {
        id: 'phase2-with-content-test',
        title: 'Test Article',
        link: 'https://example.com/test',
        needsSentiment: false,
        needsSummary: true,
        extractedContent: 'This is extracted content from Phase 1 that allows Phase 2 to execute properly.'
      };

      mockDB._articles.set(article.id, {
        ...article,
        needsSentiment: 0,
        needsSummary: 1
      });

      consoleLogs = [];
      await processArticle(mockDB, mockEnv, article, config);

      // Phase 2 should run because extractedContent IS present
      expect(consoleLogs.some(log => log.includes('Phase 2:'))).toBe(true);
      expect(consoleLogs.some(log => log.includes('Generating AI summary'))).toBe(true);
      
      // Phase 1 should NOT run because extractedContent already exists
      expect(consoleLogs.some(log => log.includes('Phase 1: Fetching'))).toBe(false);
    });
  });
});
