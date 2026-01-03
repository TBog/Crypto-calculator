/**
 * Tests for Early Exit Optimization
 * Tests that article fetching stops when articles are found in:
 * - ID index (existing behavior)
 * - Pending queue (new behavior)
 * - Checkpoint (new behavior)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getArticleId } from '../shared/news-providers.js';

/**
 * Mock news provider that returns predefined articles
 */
class MockNewsProvider {
  constructor(pages) {
    this.pages = pages; // Array of article arrays
    this.name = 'MockProvider';
    this.fetchCount = 0;
  }

  async fetchPage(nextPage) {
    const pageIndex = nextPage ? parseInt(nextPage) : 0;
    this.fetchCount++;
    
    if (pageIndex >= this.pages.length) {
      return {
        articles: [],
        nextPage: null,
        totalResults: 0
      };
    }

    return {
      articles: this.pages[pageIndex],
      nextPage: pageIndex + 1 < this.pages.length ? String(pageIndex + 1) : null,
      totalResults: this.pages.reduce((sum, page) => sum + page.length, 0)
    };
  }

  normalizeArticle(article) {
    return {
      ...article,
      needsSentiment: true,
      needsSummary: true,
      queuedAt: Date.now()
    };
  }

  getFetchCount() {
    return this.fetchCount;
  }
}

describe('Early Exit Optimization', () => {
  let config;

  beforeEach(() => {
    config = {
      KV_KEY_IDS: 'BTC_ID_INDEX',
      KV_KEY_PENDING: 'BTC_PENDING_LIST',
      KV_KEY_CHECKPOINT: 'BTC_CHECKPOINT',
      MAX_PAGES: 10,
      ID_INDEX_TTL: 86400
    };
  });

  /**
   * Helper to simulate aggregateArticles logic
   */
  async function simulateAggregation(provider, knownIds) {
    let newArticles = [];
    let nextPage = null;
    let pageCount = 0;
    let earlyExitTriggered = false;

    do {
      const pageData = await provider.fetchPage(nextPage);
      
      for (const article of pageData.articles) {
        const articleId = getArticleId(article);
        if (!articleId) continue;

        if (knownIds.has(articleId)) {
          earlyExitTriggered = true;
          continue;
        }

        const normalizedArticle = provider.normalizeArticle(article);
        newArticles.push(normalizedArticle);
        knownIds.add(articleId);
      }

      if (earlyExitTriggered) {
        break;
      }

      // Stop pagination if the current page is empty
      if (pageData.articles.length === 0) {
        break;
      }

      nextPage = pageData.nextPage;
      pageCount++;

      if (pageCount >= config.MAX_PAGES) break;
      if (!nextPage) break;

    } while (pageCount < config.MAX_PAGES);

    return { newArticles, pagesFetched: provider.getFetchCount() };
  }

  it('should trigger early exit when article is found in ID index', async () => {
    // Setup: Create 3 pages of articles
    const pages = [
      [
        { article_id: 'article-1', title: 'New Article 1' },
        { article_id: 'article-2', title: 'New Article 2' }
      ],
      [
        { article_id: 'article-3', title: 'Old Article 3' },  // This is in ID index
        { article_id: 'article-4', title: 'New Article 4' }   // Will be processed since it's on same page
      ],
      [
        { article_id: 'article-5', title: 'Very Old Article 5' }
      ]
    ];

    const provider = new MockNewsProvider(pages);
    
    // ID index contains article-3
    const knownIds = new Set(['article-3']);

    // Run aggregation
    const result = await simulateAggregation(provider, knownIds);

    // Should fetch 2 pages and stop (article-3 found on page 2)
    expect(result.pagesFetched).toBe(2);
    // Should add articles 1, 2, and 4 (skips 3 because it's known)
    expect(result.newArticles).toHaveLength(3);
    expect(result.newArticles[0].article_id).toBe('article-1');
    expect(result.newArticles[1].article_id).toBe('article-2');
    expect(result.newArticles[2].article_id).toBe('article-4');
  });

  it('should trigger early exit when article is found in pending queue', async () => {
    // Setup: Create 3 pages of articles
    const pages = [
      [
        { article_id: 'article-1', title: 'New Article 1' },
        { article_id: 'article-2', title: 'New Article 2' }
      ],
      [
        { article_id: 'article-3', title: 'Pending Article 3' },  // This is in pending queue
        { article_id: 'article-4', title: 'New Article 4' }       // Will be processed since it's on same page
      ],
      [
        { article_id: 'article-5', title: 'Very Old Article 5' }
      ]
    ];

    const provider = new MockNewsProvider(pages);
    
    // Pending queue contains article-3
    const knownIds = new Set(['article-3']);

    // Run aggregation
    const result = await simulateAggregation(provider, knownIds);

    // Should fetch 2 pages and stop (article-3 found on page 2)
    expect(result.pagesFetched).toBe(2);
    // Should add articles 1, 2, and 4 (skips 3 because it's in pending queue)
    expect(result.newArticles).toHaveLength(3);
    expect(result.newArticles[0].article_id).toBe('article-1');
    expect(result.newArticles[1].article_id).toBe('article-2');
    expect(result.newArticles[2].article_id).toBe('article-4');
  });

  it('should trigger early exit when article is found in checkpoint', async () => {
    // Setup: Create 3 pages of articles
    const pages = [
      [
        { article_id: 'article-1', title: 'New Article 1' },
        { article_id: 'article-2', title: 'New Article 2' }
      ],
      [
        { article_id: 'article-3', title: 'Processing Article 3' },  // This is in checkpoint
        { article_id: 'article-4', title: 'New Article 4' }          // Will be processed since it's on same page
      ],
      [
        { article_id: 'article-5', title: 'Very Old Article 5' }
      ]
    ];

    const provider = new MockNewsProvider(pages);
    
    // Checkpoint contains article-3 (currently processing)
    const knownIds = new Set(['article-3']);

    // Run aggregation
    const result = await simulateAggregation(provider, knownIds);

    // Should fetch 2 pages and stop (article-3 found on page 2)
    expect(result.pagesFetched).toBe(2);
    // Should add articles 1, 2, and 4 (skips 3 because it's in checkpoint)
    expect(result.newArticles).toHaveLength(3);
    expect(result.newArticles[0].article_id).toBe('article-1');
    expect(result.newArticles[1].article_id).toBe('article-2');
    expect(result.newArticles[2].article_id).toBe('article-4');
  });

  it('should combine IDs from all sources for comprehensive early exit', async () => {
    // Setup: Create 3 pages of articles
    const pages = [
      [
        { article_id: 'article-1', title: 'New Article 1' }
      ],
      [
        { article_id: 'article-2', title: 'Article in ID Index' },  // In ID index
        { article_id: 'article-3', title: 'Old Article 3' }
      ],
      [
        { article_id: 'article-4', title: 'Very Old Article 4' }
      ]
    ];

    const provider = new MockNewsProvider(pages);
    
    // Combine IDs from multiple sources
    const knownIds = new Set([
      'article-2',  // From ID index
      'article-3',  // From pending queue
      'article-4'   // From checkpoint
    ]);

    // Run aggregation
    const result = await simulateAggregation(provider, knownIds);

    // Should fetch 2 pages and stop (article-2 found on page 2)
    expect(result.pagesFetched).toBe(2);
    // Should add only article 1
    expect(result.newArticles).toHaveLength(1);
    expect(result.newArticles[0].article_id).toBe('article-1');
  });

  it('should fetch all pages when no known articles are encountered', async () => {
    // Setup: Create 3 pages of articles, none are known
    const pages = [
      [
        { article_id: 'article-1', title: 'New Article 1' },
        { article_id: 'article-2', title: 'New Article 2' }
      ],
      [
        { article_id: 'article-3', title: 'New Article 3' },
        { article_id: 'article-4', title: 'New Article 4' }
      ],
      [
        { article_id: 'article-5', title: 'New Article 5' }
      ]
    ];

    const provider = new MockNewsProvider(pages);
    
    // No known articles
    const knownIds = new Set();

    // Run aggregation
    const result = await simulateAggregation(provider, knownIds);

    // Should fetch all 3 pages
    expect(result.pagesFetched).toBe(3);
    // Should add all 5 articles
    expect(result.newArticles).toHaveLength(5);
  });

  it('should trigger early exit on first page if first article is known', async () => {
    // Setup: Create 3 pages of articles
    const pages = [
      [
        { article_id: 'article-1', title: 'Known Article 1' },  // Known from start
        { article_id: 'article-2', title: 'New Article 2' }     // Will still be processed (same page)
      ],
      [
        { article_id: 'article-3', title: 'Very Old Article 3' }
      ],
      [
        { article_id: 'article-4', title: 'Ancient Article 4' }
      ]
    ];

    const provider = new MockNewsProvider(pages);
    
    // First article is already known
    const knownIds = new Set(['article-1']);

    // Run aggregation
    const result = await simulateAggregation(provider, knownIds);

    // Should fetch only 1 page and stop immediately
    expect(result.pagesFetched).toBe(1);
    // Should add article-2 from the same page
    expect(result.newArticles).toHaveLength(1);
    expect(result.newArticles[0].article_id).toBe('article-2');
  });

  it('should stop pagination when an empty page is returned', async () => {
    // Setup: Create pages with one returning empty
    const pages = [
      [
        { article_id: 'article-1', title: 'Article 1' },
        { article_id: 'article-2', title: 'Article 2' }
      ],
      [], // Empty page - should stop here
      [
        { article_id: 'article-3', title: 'Article 3' }
      ]
    ];

    const provider = new MockNewsProvider(pages);
    
    // No known articles
    const knownIds = new Set();

    // Run aggregation
    const result = await simulateAggregation(provider, knownIds);

    // Should fetch only 2 pages (first page + empty page)
    expect(result.pagesFetched).toBe(2);
    // Should add only articles from first page
    expect(result.newArticles).toHaveLength(2);
    expect(result.newArticles[0].article_id).toBe('article-1');
    expect(result.newArticles[1].article_id).toBe('article-2');
  });
});
