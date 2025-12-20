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

  it('should not have built-in sentiment', () => {
    expect(provider.hasSentiment()).toBe(false);
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

  it('should have built-in sentiment', () => {
    expect(provider.hasSentiment()).toBe(true);
  });

  describe('normalizeSentiment', () => {
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
    it('should normalize APITube article correctly', () => {
      const rawArticle = {
        id: 'apitube-123',
        title: 'Bitcoin surges',
        description: 'Bitcoin hits record high',
        url: 'https://example.com/article',
        published_at: '2025-01-01T12:00:00Z',
        sentiment: 'positive',
        source: {
          id: 'src1',
          name: 'Crypto News',
          url: 'https://cryptonews.com'
        }
      };

      const normalized = provider.normalizeArticle(rawArticle);

      expect(normalized.article_id).toBe('apitube-123');
      expect(normalized.title).toBe('Bitcoin surges');
      expect(normalized.sentiment).toBe('positive');
      expect(normalized.needsSentiment).toBe(false);
      expect(normalized.needsSummary).toBe(true);
      expect(normalized.queuedAt).toBeDefined();
    });

    it('should handle numeric sentiment scores', () => {
      const rawArticle = {
        id: 'test-id',
        title: 'Test',
        sentiment_score: 0.7
      };

      const normalized = provider.normalizeArticle(rawArticle);
      expect(normalized.sentiment).toBe('positive');
      expect(normalized.needsSentiment).toBe(false);
    });
  });

  describe('fetchPage', () => {
    it('should throw error on API failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403
      });
      global.fetch = mockFetch;

      await expect(provider.fetchPage()).rejects.toThrow('APITube API request failed: 403');
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
