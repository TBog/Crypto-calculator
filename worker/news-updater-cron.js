/**
 * Scheduled Cloudflare Worker for Bitcoin News Aggregation & Analysis
 * 
 * This worker runs on a cron schedule (hourly) to:
 * 1. Fetch Bitcoin articles from NewsData.io using pagination with early-exit optimization
 * 2. Analyze sentiment of each article using Gemini API
 * 3. Store enriched data in Cloudflare KV for fast retrieval
 * 
 * This approach optimizes API credit usage by:
 * - Running on a schedule (not per-request)
 * - Early-exit when hitting known articles (stops fetching old data)
 * - Using separate ID index for fast deduplication
 */

// KV keys for optimized storage
const KV_KEY_NEWS = 'BTC_ANALYZED_NEWS';  // Full articles payload
const KV_KEY_IDS = 'BTC_ID_INDEX';         // ID index for deduplication

// Maximum articles to keep in KV storage (prevent size issues)
const MAX_STORED_ARTICLES = 500;

// Maximum number of pages to fetch (safety limit)
const MAX_PAGES = 15;

// ID index TTL in seconds (30 days)
const ID_INDEX_TTL = 60 * 60 * 24 * 30;

/**
 * Get article ID from article object
 * Uses article_id as primary identifier, falls back to link
 * @param {Object} article - Article object
 * @returns {string|null} Article ID or null if not available
 */
function getArticleId(article) {
  return article.article_id || article.link || null;
}

/**
 * Fetch articles from NewsData.io with pagination support
 * @param {string} apiKey - NewsData.io API key
 * @param {string|null} nextPage - Pagination token from previous response
 * @returns {Promise<{articles: Array, nextPage: string|null, totalResults: number}>}
 */
async function fetchNewsPage(apiKey, nextPage = null) {
  const newsUrl = new URL('https://newsdata.io/api/1/crypto');
  newsUrl.searchParams.set('apikey', apiKey);
  newsUrl.searchParams.set('coin', 'btc');
  newsUrl.searchParams.set('language', 'en');
  newsUrl.searchParams.set('removeduplicate', '1');
  
  if (nextPage) {
    newsUrl.searchParams.set('page', nextPage);
  }
  
  const response = await fetch(newsUrl.toString());
  
  if (!response.ok) {
    throw new Error(`NewsData.io API request failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  return {
    articles: data.results || [],
    nextPage: data.nextPage || null,
    totalResults: data.totalResults || 0
  };
}

/**
 * Fetch article content from URL
 * 
 * SECURITY NOTE: The extracted text is used solely as input to AI for summary generation.
 * It is never rendered as HTML or injected into the DOM. The AI-generated summary is
 * displayed using textContent (not innerHTML) in the frontend, preventing XSS.
 * 
 * @param {string} url - Article URL
 * @returns {Promise<string|null>} Article text content or null on error
 */
async function fetchArticleContent(url) {
  try {
    // Set a timeout and user agent to avoid being blocked
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0; +http://crypto-calculator.com)'
      },
      // Add a timeout
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });
    
    if (!response.ok) {
      console.warn(`Failed to fetch article content: ${response.status}`);
      return null;
    }
    
    const html = await response.text();
    
    // Extract text from HTML for AI processing (not for HTML display)
    // IMPORTANT: This text is only used as input to AI, never rendered as HTML
    // CodeQL may flag the HTML parsing, but this is safe because:
    // 1. Text is only used for AI input (not DOM injection)
    // 2. AI output is displayed via textContent (not innerHTML)
    // 3. Additional < and > removal for defense in depth
    let text = html;
    
    // Remove script tags (multiple passes to catch malformed tags)
    // Note: The extracted text is only used for AI input, not HTML rendering
    for (let i = 0; i < 3; i++) {
      // More permissive regex to catch whitespace variations in closing tags
      text = text.replace(/<script[^>]*>[\s\S]*?<\/script[\s]*>/gi, '');
      text = text.replace(/<script[^>]*>/gi, ''); // Remove unclosed script tags
    }
    
    // Remove style tags (multiple passes)
    for (let i = 0; i < 3; i++) {
      text = text.replace(/<style[^>]*>[\s\S]*?<\/style[\s]*>/gi, '');
      text = text.replace(/<style[^>]*>/gi, ''); // Remove unclosed style tags
    }
    
    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ');
    
    // Additional safety: Remove any remaining < or > characters
    text = text.replace(/[<>]/g, '');
    
    // Decode common HTML entities (basic set)
    const entities = {
      '&nbsp;': ' ',
      '&quot;': '"',
      '&apos;': "'",
      '&#39;': "'",
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&mdash;': '—',
      '&ndash;': '–',
      '&hellip;': '…'
    };
    
    for (const [entity, char] of Object.entries(entities)) {
      text = text.replace(new RegExp(entity, 'g'), char);
    }
    
    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    // Limit to first 5000 characters to avoid token limits
    if (text.length > 5000) {
      text = text.substring(0, 5000);
    }
    
    return text || null;
  } catch (error) {
    console.error(`Error fetching article content from ${url}:`, error.message);
    return null;
  }
}

/**
 * Generate AI summary of article content with validation
 * @param {Object} env - Environment variables (includes AI binding)
 * @param {string} title - Article title
 * @param {string} content - Article content
 * @returns {Promise<string|null>} AI-generated summary or null if content doesn't match title
 */
async function generateArticleSummary(env, title, content) {
  try {
    if (!content || content.length < 100) {
      return null; // Not enough content to summarize
    }
    
    // Error indicators for content mismatch detection
    const MISMATCH_INDICATORS = ['ERROR:', 'CONTENT_MISMATCH', 'does not match', 'unrelated'];
    
    // System prompt for AI summarization with content validation
    const systemPrompt = [
      'You are a news summarization assistant.',
      'Task: First verify that the webpage content matches the article title, then provide a summary.',
      'Validation: If the webpage content does NOT match or discuss the topic in the title',
      '(e.g., wrong article, paywall, error page, or unrelated content),',
      'respond with exactly "ERROR: CONTENT_MISMATCH".',
      'Summary: Otherwise, provide a concise 2-3 sentence summary of the Bitcoin-related news,',
      'focusing on key facts and implications for Bitcoin.'
    ].join(' ');
    
    // Use Cloudflare Workers AI to generate summary with content validation
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Article Title: ${title}\n\nWebpage Content: ${content}\n\nFirst, verify the content matches the title. If it does not match, respond with "ERROR: CONTENT_MISMATCH". If it matches, provide a brief summary:`
        }
      ],
      max_tokens: 150
    });
    
    // Extract summary from response
    // Workers AI returns different formats: {response: "text"} or just "text"
    const summary = (response.response || response || '').trim();
    
    // Check if AI detected content mismatch
    const hasMismatch = MISMATCH_INDICATORS.some(indicator => 
      summary.toLowerCase().includes(indicator.toLowerCase())
    );
    
    if (hasMismatch) {
      console.log(`Content mismatch detected for: ${title}`);
      return null;
    }
    
    if (summary && summary.length > 20) {
      return summary;
    }
    
    return null;
  } catch (error) {
    console.error('Failed to generate summary:', error);
    return null;
  }
}

/**
 * Analyze sentiment of an article using Cloudflare Workers AI
 * @param {Object} env - Environment variables (includes AI binding)
 * @param {Object} article - Article object to analyze
 * @returns {Promise<string>} Sentiment classification (positive, negative, neutral)
 */
async function analyzeSentiment(env, article) {
  try {
    // Construct prompt from article title and description
    const text = `${article.title || ''}. ${article.description || ''}`;
    
    // Use Cloudflare Workers AI to classify sentiment
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a sentiment analysis assistant. Classify the sentiment of the provided Bitcoin-related news article as exactly one word: "positive", "negative", or "neutral". Only respond with that single word.'
        },
        {
          role: 'user',
          content: text
        }
      ],
      max_tokens: 10
    });
    
    // Extract sentiment from response
    const sentiment = (response.response || response || '').trim().toLowerCase();
    
    // Validate and normalize sentiment
    if (sentiment.includes('positive')) {
      return 'positive';
    } else if (sentiment.includes('negative')) {
      return 'negative';
    } else {
      return 'neutral';
    }
  } catch (error) {
    console.error('Failed to analyze sentiment:', error);
    // Default to neutral on error
    return 'neutral';
  }
}

/**
 * Fetch and aggregate articles with early-exit optimization
 * Stops pagination immediately when a known article is encountered
 * @param {Object} env - Environment variables
 * @param {Set} knownIds - Set of known article IDs for deduplication
 * @returns {Promise<Array>} Array of new articles
 */
async function aggregateArticles(env, knownIds) {
  const apiKey = env.NEWSDATA_API_KEY;
  if (!apiKey) {
    throw new Error('NEWSDATA_API_KEY not configured');
  }
  
  let newArticles = [];
  let nextPage = null;
  let pageCount = 0;
  let creditsUsed = 0;
  let earlyExitTriggered = false;
  
  console.log('Starting article aggregation with early-exit optimization...');
  console.log(`Known article IDs: ${knownIds.size}`);
  
  // Pagination loop with early exit
  do {
    try {
      console.log(`Fetching page ${pageCount + 1}...`);
      const pageData = await fetchNewsPage(apiKey, nextPage);
      creditsUsed++;
      
      // Check each article in this page
      for (const article of pageData.articles) {
        const articleId = getArticleId(article);
        
        if (!articleId) {
          console.warn('Article missing ID, skipping');
          continue;
        }
        
        // Early exit: If we hit a known article, stop immediately
        if (knownIds.has(articleId)) {
          console.log(`Early exit triggered: Found known article "${article.title?.substring(0, 50)}..."`);
          earlyExitTriggered = true;
          break;
        }
        
        // Add new article to collection
        newArticles.push(article);
        knownIds.add(articleId);
      }
      
      // Break out of pagination loop if early exit was triggered
      if (earlyExitTriggered) {
        console.log(`Stopping pagination due to early exit after ${pageCount} page(s)`);
        break;
      }
      
      console.log(`Page ${pageCount + 1}: ${pageData.articles.length} total, ${newArticles.length} new articles so far`);
      
      nextPage = pageData.nextPage;
      pageCount++;
      
      // Stop if we've reached max pages
      if (pageCount >= MAX_PAGES) {
        console.log(`Stopping: Max pages (${MAX_PAGES}) reached`);
        break;
      }
      
      // If there's no nextPage, we've reached the end
      if (!nextPage) {
        console.log('No more pages available');
        break;
      }
      
    } catch (error) {
      console.error(`Error fetching page ${pageCount + 1}:`, error);
      break;
    }
  } while (nextPage && pageCount < MAX_PAGES);
  
  console.log(`Aggregation complete: ${newArticles.length} new articles, ${creditsUsed} credits used`);
  
  return newArticles;
}

/**
 * Analyze sentiment and generate summaries for all articles
 * @param {Object} env - Environment variables
 * @param {Array} articles - Array of articles to analyze
 * @returns {Promise<Array>} Articles with sentiment tags and AI summaries
 */
async function analyzeArticles(env, articles) {
  console.log(`Starting analysis for ${articles.length} articles...`);
  
  const analyzedArticles = [];
  
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    
    try {
      // Analyze sentiment (fast)
      const sentiment = await analyzeSentiment(env, article);
      
      // Fetch article content and generate summary (slower, may fail)
      let aiSummary = null;
      if (article.link) {
        const content = await fetchArticleContent(article.link);
        
        if (content) {
          aiSummary = await generateArticleSummary(env, article.title, content);
          
          if (aiSummary && (i + 1) % 5 === 0) {
            console.log(`Generated ${analyzedArticles.filter(a => a.aiSummary).length} AI summaries so far`);
          }
        }
      }
      
      analyzedArticles.push({
        ...article,
        sentiment: sentiment,
        ...(aiSummary && { aiSummary: aiSummary })
      });
      
      if ((i + 1) % 5 === 0) {
        console.log(`Analyzed ${i + 1}/${articles.length} articles`);
      }
    } catch (error) {
      console.error(`Error analyzing article ${i + 1}:`, error);
      // Include article with neutral sentiment on error
      analyzedArticles.push({
        ...article,
        sentiment: 'neutral'
      });
    }
  }
  
  const withSummaries = analyzedArticles.filter(a => a.aiSummary).length;
  console.log(`Analysis complete: ${analyzedArticles.length} articles processed, ${withSummaries} with AI summaries`);
  
  return analyzedArticles;
}

/**
 * Store analyzed articles in Cloudflare KV using two-key optimization
 * Write #1: Update full news payload (BTC_ANALYZED_NEWS)
 * Write #2: Update ID index (BTC_ID_INDEX)
 * @param {Object} env - Environment variables
 * @param {Array} newArticles - New analyzed articles
 * @returns {Promise<void>}
 */
async function storeInKV(env, newArticles) {
  const timestamp = Date.now();
  
  // Merge with existing articles to maintain history
  let allArticles = [...newArticles];
  
  try {
    const existingData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY_NEWS, { type: 'json' });
    if (existingData && existingData.articles) {
      // Keep existing articles (up to a reasonable limit to avoid KV size issues)
      const existingArticles = existingData.articles.slice(0, MAX_STORED_ARTICLES - newArticles.length);
      allArticles = [...newArticles, ...existingArticles];
      console.log(`Merged ${newArticles.length} new articles with ${existingArticles.length} existing articles`);
    }
  } catch (error) {
    console.log('No existing data to merge:', error.message);
  }
  
  // Calculate sentiment distribution
  const sentimentCounts = {
    positive: 0,
    negative: 0,
    neutral: 0
  };
  
  allArticles.forEach(article => {
    const sentiment = article.sentiment || 'neutral';
    sentimentCounts[sentiment] = (sentimentCounts[sentiment] || 0) + 1;
  });
  
  const finalData = {
    articles: allArticles,
    totalArticles: allArticles.length,
    lastUpdatedExternal: timestamp,
    sentimentCounts: sentimentCounts
  };
  
  // Write #1: Update full news payload
  await env.CRYPTO_NEWS_CACHE.put(KV_KEY_NEWS, JSON.stringify(finalData));
  console.log(`Write #1: Stored ${allArticles.length} articles in KV under key: ${KV_KEY_NEWS}`);
  
  // Write #2: Update ID index - MUST match the articles actually stored
  // Extract IDs from the articles we're storing using consistent helper function
  const storedArticleIds = allArticles
    .map(article => getArticleId(article))
    .filter(id => id); // Remove any null/undefined IDs
  
  await env.CRYPTO_NEWS_CACHE.put(
    KV_KEY_IDS, 
    JSON.stringify(storedArticleIds),
    {
      expirationTtl: ID_INDEX_TTL
    }
  );
  console.log(`Write #2: Stored ${storedArticleIds.length} article IDs in index under key: ${KV_KEY_IDS}`);
  console.log(`ID index now matches the ${allArticles.length} articles stored in payload`);
  console.log('Total KV writes this run: 2');
}

/**
 * Main scheduled event handler with optimized three-phase pipeline
 * Phase 1: Preparation - Read ID index from KV
 * Phase 2: Fetch & Early Exit - Aggregate new articles, stop when hitting known article
 * Phase 3: KV Update - Write both full payload and ID index (2 writes)
 * @param {Event} event - Scheduled event
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 */
async function handleScheduled(event, env, ctx) {
  console.log('=== Bitcoin News Updater Cron Job Started ===');
  console.log(`Execution time: ${new Date().toISOString()}`);
  
  try {
    // Phase 1: Preparation - Read ID index
    console.log('Phase 1: Reading ID index from KV...');
    let knownIds = new Set();
    
    try {
      const idIndexData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY_IDS, { type: 'json' });
      if (idIndexData && Array.isArray(idIndexData)) {
        knownIds = new Set(idIndexData);
        console.log(`Loaded ${knownIds.size} known article IDs from index`);
      } else {
        console.log('No existing ID index found, starting fresh');
      }
    } catch (error) {
      console.log('Error reading ID index, starting fresh:', error.message);
    }
    
    // Phase 2: Optimized Fetch with Early Exit
    console.log('Phase 2: Fetching articles with early-exit optimization...');
    const newArticles = await aggregateArticles(env, knownIds);
    
    if (newArticles.length === 0) {
      console.log('No new articles to process, skipping analysis and KV update');
      console.log('=== Bitcoin News Updater Cron Job Completed (No Updates) ===');
      return;
    }
    
    // Analyze sentiment for new articles only
    console.log('Phase 2: Analyzing sentiment for new articles...');
    const analyzedArticles = await analyzeArticles(env, newArticles);
    
    // Phase 3: KV Update (exactly 2 writes)
    console.log('Phase 3: Updating KV (2 writes)...');
    await storeInKV(env, analyzedArticles);
    
    console.log('=== Bitcoin News Updater Cron Job Completed Successfully ===');
  } catch (error) {
    console.error('=== Bitcoin News Updater Cron Job Failed ===');
    console.error('Error:', error);
    throw error;
  }
}

export default {
  async scheduled(event, env, ctx) {
    // Use waitUntil to ensure the job completes even if it takes time
    ctx.waitUntil(handleScheduled(event, env, ctx));
  }
};
