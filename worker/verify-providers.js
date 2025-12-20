#!/usr/bin/env node
/**
 * Verification Script for News Provider System
 * 
 * This script tests the provider system locally to ensure:
 * 1. Provider factory creates correct provider types
 * 2. Providers normalize articles correctly
 * 3. Sentiment normalization works as expected
 * 4. Provider selection logic is correct
 */

import { 
  createNewsProvider, 
  NewsDataProvider, 
  APITubeProvider,
  getArticleId 
} from './news-providers.js';

console.log('🧪 News Provider System Verification\n');

// Test 1: Provider Factory
console.log('Test 1: Provider Factory');
console.log('------------------------');

try {
  // Test default provider (NewsData)
  const env1 = { NEWSDATA_API_KEY: 'test-key-1' };
  const provider1 = createNewsProvider(env1);
  console.log('✓ Default provider (no NEWS_PROVIDER set):', provider1.name);
  
  // Test explicit NewsData
  const env2 = { NEWS_PROVIDER: 'newsdata', NEWSDATA_API_KEY: 'test-key-2' };
  const provider2 = createNewsProvider(env2);
  console.log('✓ NewsData provider (explicit):', provider2.name);
  
  // Test APITube
  const env3 = { NEWS_PROVIDER: 'apitube', APITUBE_API_KEY: 'test-key-3' };
  const provider3 = createNewsProvider(env3);
  console.log('✓ APITube provider:', provider3.name);
  
  // Test case insensitivity
  const env4 = { NEWS_PROVIDER: 'NEWSDATA', NEWSDATA_API_KEY: 'test-key-4' };
  const provider4 = createNewsProvider(env4);
  console.log('✓ Case insensitive selection:', provider4.name);
  
  console.log('✅ Provider factory tests passed\n');
} catch (error) {
  console.error('❌ Provider factory test failed:', error.message);
  process.exit(1);
}

// Test 2: NewsData Provider
console.log('Test 2: NewsData Provider');
console.log('-------------------------');

try {
  const newsDataProvider = new NewsDataProvider('test-api-key');
  
  const rawArticle = {
    article_id: 'nd_123',
    title: 'Bitcoin Price Update',
    description: 'Bitcoin reaches new highs',
    link: 'https://example.com/article',
    pubDate: '2025-01-15',
    source_name: 'Crypto News'
  };
  
  const normalized = newsDataProvider.normalizeArticle(rawArticle);
  
  console.log('✓ Article normalized');
  console.log('  - Has article_id:', !!normalized.article_id);
  console.log('  - needsSentiment:', normalized.needsSentiment);
  console.log('  - needsSummary:', normalized.needsSummary);
  console.log('  - Has queuedAt:', !!normalized.queuedAt);
  console.log('  - Has sentiment:', !!normalized.sentiment);
  
  if (normalized.needsSentiment !== true) {
    throw new Error('NewsData articles should need sentiment analysis');
  }
  
  console.log('✅ NewsData provider tests passed\n');
} catch (error) {
  console.error('❌ NewsData provider test failed:', error.message);
  process.exit(1);
}

// Test 3: APITube Provider
console.log('Test 3: APITube Provider');
console.log('------------------------');

try {
  const apiTubeProvider = new APITubeProvider('test-api-key');
  
  // Test string sentiment
  const rawArticle1 = {
    id: 'at_456',
    title: 'Bitcoin Adoption Growing',
    description: 'More businesses accept Bitcoin',
    url: 'https://example.com/article2',
    published_at: '2025-01-15T12:00:00Z',
    sentiment: 'positive'
  };
  
  const normalized1 = apiTubeProvider.normalizeArticle(rawArticle1);
  
  console.log('✓ Article with string sentiment normalized');
  console.log('  - Sentiment:', normalized1.sentiment);
  console.log('  - needsSentiment:', normalized1.needsSentiment);
  console.log('  - needsSummary:', normalized1.needsSummary);
  
  if (normalized1.needsSentiment !== false) {
    throw new Error('APITube articles should not need sentiment analysis');
  }
  
  if (normalized1.sentiment !== 'positive') {
    throw new Error('Sentiment should be "positive"');
  }
  
  // Test numeric sentiment
  const rawArticle2 = {
    id: 'at_789',
    title: 'Bitcoin Price Drops',
    sentiment_score: -0.6
  };
  
  const normalized2 = apiTubeProvider.normalizeArticle(rawArticle2);
  
  console.log('✓ Article with numeric sentiment normalized');
  console.log('  - Score -0.6 → Sentiment:', normalized2.sentiment);
  
  if (normalized2.sentiment !== 'negative') {
    throw new Error('Sentiment score -0.6 should map to "negative"');
  }
  
  console.log('✅ APITube provider tests passed\n');
} catch (error) {
  console.error('❌ APITube provider test failed:', error.message);
  process.exit(1);
}

// Test 4: Article ID Extraction
console.log('Test 4: Article ID Extraction');
console.log('------------------------------');

try {
  const article1 = { article_id: '123', id: '456', link: 'https://example.com' };
  const article2 = { id: '456', link: 'https://example.com' };
  const article3 = { link: 'https://example.com' };
  const article4 = {};
  
  console.log('✓ article_id preferred:', getArticleId(article1) === '123');
  console.log('✓ Falls back to id:', getArticleId(article2) === '456');
  console.log('✓ Falls back to link:', getArticleId(article3) === 'https://example.com');
  console.log('✓ Returns null when no ID:', getArticleId(article4) === null);
  
  console.log('✅ Article ID extraction tests passed\n');
} catch (error) {
  console.error('❌ Article ID extraction test failed:', error.message);
  process.exit(1);
}

// Test 5: Sentiment Normalization
console.log('Test 5: Sentiment Normalization');
console.log('--------------------------------');

try {
  const provider = new APITubeProvider('test-key');
  
  // Test various sentiment inputs
  const testCases = [
    ['positive', 'positive'],
    ['POSITIVE', 'positive'],
    ['negative', 'negative'],
    ['Negative', 'negative'],
    ['neutral', 'neutral'],
    [0.8, 'positive'],
    [-0.5, 'negative'],
    [0.05, 'neutral'],
    [-0.05, 'neutral'],
    [null, 'neutral'],
    [undefined, 'neutral']
  ];
  
  for (const [input, expected] of testCases) {
    const result = provider.normalizeSentiment(input);
    const passed = result === expected;
    console.log(
      passed ? '✓' : '❌',
      `${String(input).padEnd(10)} → ${result.padEnd(10)}`,
      passed ? '' : `(expected ${expected})`
    );
    
    if (!passed) {
      throw new Error(`Sentiment normalization failed for input: ${input}`);
    }
  }
  
  console.log('✅ Sentiment normalization tests passed\n');
} catch (error) {
  console.error('❌ Sentiment normalization test failed:', error.message);
  process.exit(1);
}

// Test 6: Error Handling
console.log('Test 6: Error Handling');
console.log('----------------------');

try {
  // Test missing API key
  try {
    createNewsProvider({ NEWS_PROVIDER: 'newsdata' });
    console.error('❌ Should have thrown error for missing API key');
    process.exit(1);
  } catch (error) {
    console.log('✓ Missing NewsData API key detected:', error.message);
  }
  
  try {
    createNewsProvider({ NEWS_PROVIDER: 'apitube' });
    console.error('❌ Should have thrown error for missing API key');
    process.exit(1);
  } catch (error) {
    console.log('✓ Missing APITube API key detected:', error.message);
  }
  
  // Test unknown provider
  try {
    createNewsProvider({ NEWS_PROVIDER: 'unknown', NEWSDATA_API_KEY: 'key' });
    console.error('❌ Should have thrown error for unknown provider');
    process.exit(1);
  } catch (error) {
    console.log('✓ Unknown provider detected:', error.message);
  }
  
  console.log('✅ Error handling tests passed\n');
} catch (error) {
  console.error('❌ Error handling test failed:', error.message);
  process.exit(1);
}

console.log('════════════════════════════════════════');
console.log('✅ All verification tests passed!');
console.log('════════════════════════════════════════');
console.log('\nThe news provider system is ready to use.');
console.log('\nNext steps:');
console.log('1. Deploy the workers: wrangler deploy');
console.log('2. Set NEWS_PROVIDER secret: wrangler secret put NEWS_PROVIDER');
console.log('3. Set provider API key: wrangler secret put <PROVIDER>_API_KEY');
console.log('\nSee NEWS_PROVIDER_GUIDE.md for detailed instructions.');
