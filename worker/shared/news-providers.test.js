/**
 * Tests for News Provider Interface
 * 
 * Tests the provider abstraction, NewsData provider, and APITube provider
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NewsDataProvider,
  APITubeProvider,
  createNewsProvider,
  getArticleId
} from './news-providers.js';

describe('getArticleId', () => {
  it('should return article_id if available', () => {
    const article = { article_id: '123', id: '456', link: 'https://example.com' };
    expect(getArticleId(article)).toBe('123');
  });

  it('should fall back to id if article_id is not available', () => {
    const article = { id: '456', link: 'https://example.com' };
    expect(getArticleId(article)).toBe('456');
  });

  it('should fall back to link if no IDs are available', () => {
    const article = { link: 'https://example.com' };
    expect(getArticleId(article)).toBe('https://example.com');
  });

  it('should return null if no identifiers are available', () => {
    const article = {};
    expect(getArticleId(article)).toBeNull();
  });
});

describe('NewsDataProvider', () => {
  let provider;
  
  beforeEach(() => {
    provider = new NewsDataProvider('test-api-key');
  });

  it('should have correct name', () => {
    expect(provider.name).toBe('NewsData.io');
  });

  describe('normalizeArticle', () => {
    it('should normalize NewsData article correctly', () => {
      const rawArticle = {
        article_id: '123',
        title: 'Bitcoin hits new high',
        description: 'Bitcoin reached $50k today',
        link: 'https://example.com/article',
        pubDate: '2025-01-01',
        source_id: 'source1',
        source_name: 'Example News',
        image_url: 'https://example.com/image.jpg'
      };

      const normalized = provider.normalizeArticle(rawArticle);

      expect(normalized.article_id).toBe('123');
      expect(normalized.title).toBe('Bitcoin hits new high');
      expect(normalized.needsSentiment).toBe(true);
      expect(normalized.needsSummary).toBe(true);
      expect(normalized.queuedAt).toBeDefined();
    });
  });

  describe('fetchPage', () => {
    it('should construct correct API URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [],
          nextPage: null,
          totalResults: 0
        })
      });
      global.fetch = mockFetch;

      await provider.fetchPage();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://newsdata.io/api/1/crypto')
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('apikey=test-api-key')
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('coin=btc')
      );
    });

    it('should handle pagination token', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [],
          nextPage: null,
          totalResults: 0
        })
      });
      global.fetch = mockFetch;

      await provider.fetchPage('page-token-123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('page=page-token-123')
      );
    });

    it('should throw error on API failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401
      });
      global.fetch = mockFetch;

      await expect(provider.fetchPage()).rejects.toThrow('NewsData.io API request failed: 401');
    });
  });
});

describe('APITubeProvider', () => {
  let provider;
  
  beforeEach(() => {
    provider = new APITubeProvider('test-api-key');
  });

  it('should have correct name', () => {
    expect(provider.name).toBe('APITube');
  });

  describe('normalizeSentiment', () => {
    it('should normalize APITube sentiment object with overall polarity', () => {
      const sentimentObj = {
        overall: { score: 0.8, polarity: 'positive' },
        title: { score: 0.7, polarity: 'positive' },
        body: { score: 0.9, polarity: 'positive' }
      };
      expect(provider.normalizeSentiment(sentimentObj)).toBe('positive');
      
      const negativeSentiment = {
        overall: { score: -0.6, polarity: 'negative' },
        title: { score: -0.5, polarity: 'negative' },
        body: { score: -0.7, polarity: 'negative' }
      };
      expect(provider.normalizeSentiment(negativeSentiment)).toBe('negative');
      
      const neutralSentiment = {
        overall: { score: 0.05, polarity: 'neutral' },
        title: { score: 0.1, polarity: 'neutral' },
        body: { score: 0.0, polarity: 'neutral' }
      };
      expect(provider.normalizeSentiment(neutralSentiment)).toBe('neutral');
    });

    it('should fallback to overall score if polarity not available', () => {
      const sentimentWithScore = {
        overall: { score: 0.8 },
        title: { score: 0.7 },
        body: { score: 0.9 }
      };
      expect(provider.normalizeSentiment(sentimentWithScore)).toBe('positive');
      
      const negativeSentiment = {
        overall: { score: -0.5 }
      };
      expect(provider.normalizeSentiment(negativeSentiment)).toBe('negative');
    });

    it('should normalize string sentiment values', () => {
      expect(provider.normalizeSentiment('positive')).toBe('positive');
      expect(provider.normalizeSentiment('Positive')).toBe('positive');
      expect(provider.normalizeSentiment('NEGATIVE')).toBe('negative');
      expect(provider.normalizeSentiment('neutral')).toBe('neutral');
    });

    it('should normalize numeric sentiment scores', () => {
      expect(provider.normalizeSentiment(0.8)).toBe('positive');
      expect(provider.normalizeSentiment(-0.5)).toBe('negative');
      expect(provider.normalizeSentiment(0.05)).toBe('neutral');
      expect(provider.normalizeSentiment(-0.05)).toBe('neutral');
    });

    it('should default to neutral for missing sentiment', () => {
      expect(provider.normalizeSentiment(null)).toBe('neutral');
      expect(provider.normalizeSentiment(undefined)).toBe('neutral');
    });
  });

  describe('normalizeArticle', () => {
    it('should normalize APITube article correctly with proper field mapping', () => {
      const rawArticle = {
        id: 12345,  // integer in APITube
        title: 'Bitcoin surges',
        description: 'Bitcoin hits record high',
        href: 'https://example.com/article',  // 'href' not 'url'
        published_at: '2025-01-15T12:00:00Z',
        language: 'en',
        image: 'https://example.com/image.jpg',
        sentiment: {
          overall: { score: 0.8, polarity: 'positive' },
          title: { score: 0.7, polarity: 'positive' },
          body: { score: 0.9, polarity: 'positive' }
        },
        source: {
          id: 1,
          name: 'Crypto News',
          uri: 'https://cryptonews.com',  // 'uri' not 'url'
          favicon: 'https://cryptonews.com/favicon.ico'
        },
        categories: [
          { id: 1, name: 'cryptocurrency' },
          { id: 2, name: 'finance' }
        ]
      };

      const normalized = provider.normalizeArticle(rawArticle);

      expect(normalized.article_id).toBe(12345);
      expect(normalized.title).toBe('Bitcoin surges');
      expect(normalized.link).toBe('https://example.com/article');
      expect(normalized.source_url).toBe('https://cryptonews.com');
      expect(normalized.source_icon).toBe('https://cryptonews.com/favicon.ico');
      expect(normalized.category).toBe('cryptocurrency');  // First category
      expect(normalized.sentiment).toBe('positive');
      expect(normalized.needsSentiment).toBe(false);
      expect(normalized.needsSummary).toBe(true);
      expect(normalized.queuedAt).toBeDefined();
    });

    it('should handle articles without categories', () => {
      const rawArticle = {
        id: 123,
        title: 'Test Article',
        href: 'https://example.com/test',
        sentiment: {
          overall: { score: 0.05, polarity: 'neutral' }
        }
      };

      const normalized = provider.normalizeArticle(rawArticle);
      expect(normalized.category).toBe('crypto');  // Default when no categories
      expect(normalized.sentiment).toBe('neutral');
    });

    it('should handle legacy string sentiment format', () => {
      const rawArticle = {
        id: 'test-id',
        title: 'Test',
        sentiment: 'positive'
      };

      const normalized = provider.normalizeArticle(rawArticle);
      expect(normalized.sentiment).toBe('positive');
      expect(normalized.needsSentiment).toBe(false);
    });
    
    it('should handle sentiment object with negative polarity', () => {
      const rawArticle = {
        id: 456,
        title: 'Bitcoin drops',
        href: 'https://example.com/drop',
        sentiment: {
          overall: { score: -0.6, polarity: 'negative' }
        }
      };

      const normalized = provider.normalizeArticle(rawArticle);
      expect(normalized.sentiment).toBe('negative');
      expect(normalized.link).toBe('https://example.com/drop');
    });
  });

  describe('fetchPage', () => {
    it('should throw error on API failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden'
      });
      global.fetch = mockFetch;

      await expect(provider.fetchPage()).rejects.toThrow('APITube API request failed: 403');
    });

    it('should log error details when API returns error with JSON body', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          error: 'Invalid query parameter',
          message: 'Query must not be empty'
        })
      });
      global.fetch = mockFetch;

      await expect(provider.fetchPage()).rejects.toThrow('APITube API request failed: 400 Bad Request - Invalid query parameter');
      expect(consoleSpy).toHaveBeenCalledWith('APITube API error details:', expect.objectContaining({
        error: 'Invalid query parameter'
      }));
      
      consoleSpy.mockRestore();
    });

    it('should include APITube-specific topic and category filters for cryptocurrency', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [],
          meta: { total: 0 },
          links: { next_page: null }
        })
      });
      global.fetch = mockFetch;

      await provider.fetchPage();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('topic.id=crypto_news'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('category.id=medtop%3A20001279'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('language=en'),
        expect.any(Object)
      );
    });
  });
});

describe('createNewsProvider', () => {
  it('should create NewsData provider by default', () => {
    const env = {
      NEWSDATA_API_KEY: 'test-key'
    };

    const provider = createNewsProvider(env);
    expect(provider).toBeInstanceOf(NewsDataProvider);
    expect(provider.name).toBe('NewsData.io');
  });

  it('should create NewsData provider when specified', () => {
    const env = {
      NEWS_PROVIDER: 'newsdata',
      NEWSDATA_API_KEY: 'test-key'
    };

    const provider = createNewsProvider(env);
    expect(provider).toBeInstanceOf(NewsDataProvider);
  });

  it('should create APITube provider when specified', () => {
    const env = {
      NEWS_PROVIDER: 'apitube',
      APITUBE_API_KEY: 'test-key'
    };

    const provider = createNewsProvider(env);
    expect(provider).toBeInstanceOf(APITubeProvider);
  });

  it('should be case-insensitive for provider selection', () => {
    const env1 = {
      NEWS_PROVIDER: 'NEWSDATA',
      NEWSDATA_API_KEY: 'test-key'
    };
    const env2 = {
      NEWS_PROVIDER: 'APITube',
      APITUBE_API_KEY: 'test-key'
    };

    expect(createNewsProvider(env1)).toBeInstanceOf(NewsDataProvider);
    expect(createNewsProvider(env2)).toBeInstanceOf(APITubeProvider);
  });

  it('should throw error for missing NewsData API key', () => {
    const env = {
      NEWS_PROVIDER: 'newsdata'
    };

    expect(() => createNewsProvider(env)).toThrow('NEWSDATA_API_KEY not configured');
  });

  it('should throw error for missing APITube API key', () => {
    const env = {
      NEWS_PROVIDER: 'apitube'
    };

    expect(() => createNewsProvider(env)).toThrow('APITUBE_API_KEY not configured');
  });

  it('should throw error for unknown provider', () => {
    const env = {
      NEWS_PROVIDER: 'unknown-provider',
      NEWSDATA_API_KEY: 'test-key'
    };

    expect(() => createNewsProvider(env)).toThrow('Unknown news provider: unknown-provider');
  });
});
