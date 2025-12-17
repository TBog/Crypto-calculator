/**
 * Cloudflare Queue Consumer Worker for Article Processing
 * 
 * This worker processes individual articles from the queue:
 * 1. Receives article from queue (1 at a time)
 * 2. Fetches article content from URL
 * 3. Generates AI summary
 * 4. Stores result back in KV
 * 
 * Each article gets its own worker execution with fresh subrequest budget (50 on free tier).
 * This prevents "Too many subrequests" errors that occur when processing 100+ articles
 * in a single worker execution.
 */

// KV keys for storage
const KV_KEY_NEWS = 'BTC_ANALYZED_NEWS';  // Full articles payload
const KV_KEY_IDS = 'BTC_ID_INDEX';         // ID index for deduplication
const KV_KEY_PENDING = 'BTC_PENDING_ARTICLES'; // Articles pending AI processing

// Maximum characters to extract from webpage (128KB limit for AI context)
const MAX_CONTENT_CHARS = 128 * 1024;

/**
 * HTMLRewriter handler to extract text content from HTML
 * Uses Cloudflare's HTMLRewriter API for efficient, streaming HTML parsing
 */
class TextExtractor {
  constructor() {
    this.textChunks = [];
    this.charCount = 0;
    this.maxChars = MAX_CONTENT_CHARS;
  }
  
  element(element) {
    // Skip script, style, and other non-content elements
    // These will be automatically excluded from text extraction
  }
  
  text(text) {
    // Only collect text if we haven't exceeded the limit
    if (this.charCount < this.maxChars) {
      const content = text.text;
      if (content && content.trim()) {
        this.textChunks.push(content);
        this.charCount += content.length;
      }
    }
  }
  
  getText() {
    // Join all text chunks and clean up whitespace
    let text = this.textChunks.join(' ');
    text = text.replace(/\s+/g, ' ').trim();
    
    if (text.length > this.maxChars) {
      text = text.substring(0, this.maxChars);
    }
    
    return text || null;
  }
}

/**
 * Fetch article content from URL using HTMLRewriter for parsing
 * @param {string} url - Article URL
 * @returns {Promise<string|null>} Article text content or null on error
 */
async function fetchArticleContent(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0; +http://crypto-calculator.com)'
      },
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });
    
    if (!response.ok) {
      console.warn(`Failed to fetch article content: ${response.status}`);
      return null;
    }
    
    const extractor = new TextExtractor();
    
    const rewriter = new HTMLRewriter()
      .on('script', {
        element(element) {
          element.remove();
        }
      })
      .on('style', {
        element(element) {
          element.remove();
        }
      })
      .on('*', extractor);
    
    const transformed = rewriter.transform(response);
    await transformed.arrayBuffer();
    
    return extractor.getText();
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
      return null;
    }
    
    const MISMATCH_INDICATORS = ['ERROR:', 'CONTENT_MISMATCH'];
    
    const systemPrompt = [
      'You are a news summarization assistant.',
      'Task: First verify that the webpage content matches the article title, then provide a summary.',
      'Validation: If the webpage content does NOT match or discuss the topic in the title',
      '(e.g., wrong article, paywall, error page, or unrelated content),',
      'respond with exactly "ERROR: CONTENT_MISMATCH".',
      'Summary: Otherwise, provide a summary of the Bitcoin-related news, focusing on key facts and implications for Bitcoin.',
      'Format: Start your summary with the marker "SUMMARY:" followed by the actual summary text.'
    ].join(' ');
    
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Article Title: ${title}\n\nWebpage Content: ${content}\n\nFirst, verify the content matches the title. If it does not match, respond with "ERROR: CONTENT_MISMATCH". If it matches, provide a summary starting with "SUMMARY:" followed by your summary:`
        }
      ],
      max_tokens: 4096
    });
    
    let fullResponse = (response.response || response || '').trim();
    
    const hasMismatch = MISMATCH_INDICATORS.some(indicator => 
      fullResponse.toUpperCase().includes(indicator.toUpperCase())
    );
    
    if (hasMismatch) {
      console.log(`Content mismatch detected for: ${title}`);
      return null;
    }
    
    let summary = fullResponse;
    const summaryMarkerIndex = fullResponse.toUpperCase().indexOf('SUMMARY:');
    if (summaryMarkerIndex !== -1) {
      summary = fullResponse.substring(summaryMarkerIndex + 8).trim();
    } else {
      const confirmationPatterns = [
        /^The webpage content matches[^.]*\.\s*/i,
        /^This article discusses[^.]*\.\s*/i,
        /^Here'?s?\s+(a\s+)?(2-3\s+sentence\s+)?summary[^:]*:\s*/i,
        /^Summary:\s*/i
      ];
      
      for (const pattern of confirmationPatterns) {
        summary = summary.replace(pattern, '');
      }
    }
    
    summary = summary.trim();
    
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
    const text = `${article.title || ''}. ${article.description || ''}`;
    
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
    
    const sentiment = (response.response || response || '').trim().toLowerCase();
    
    if (sentiment.includes('positive')) {
      return 'positive';
    } else if (sentiment.includes('negative')) {
      return 'negative';
    } else {
      return 'neutral';
    }
  } catch (error) {
    console.error('Failed to analyze sentiment:', error);
    return 'neutral';
  }
}

/**
 * Get article ID from article object
 * @param {Object} article - Article object
 * @returns {string|null} Article ID or null if not available
 */
function getArticleId(article) {
  return article.article_id || article.link || null;
}

/**
 * Process a single article message from the queue
 * @param {Object} batch - Batch of messages from the queue
 * @param {Object} env - Environment variables
 */
async function queue(batch, env) {
  console.log(`Processing batch of ${batch.messages.length} article(s)`);
  
  for (const message of batch.messages) {
    try {
      const article = message.body;
      console.log(`Processing article: ${article.title?.substring(0, 50)}...`);
      
      // Step 1: Analyze sentiment (fast, low token count)
      const sentiment = await analyzeSentiment(env, article);
      console.log(`Sentiment: ${sentiment}`);
      
      // Step 2: Fetch article content and generate summary (slower)
      let aiSummary = null;
      if (article.link) {
        const content = await fetchArticleContent(article.link);
        
        if (content) {
          aiSummary = await generateArticleSummary(env, article.title, content);
          if (aiSummary) {
            console.log(`Generated AI summary (${aiSummary.length} chars)`);
          } else {
            console.log('No AI summary generated (content mismatch or too short)');
          }
        } else {
          console.log('Failed to fetch article content');
        }
      }
      
      // Step 3: Store enriched article in KV
      const enrichedArticle = {
        ...article,
        sentiment,
        ...(aiSummary && { aiSummary }),
        processedAt: Date.now()
      };
      
      // Read existing data
      const existingData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY_NEWS, { type: 'json' });
      
      if (existingData && existingData.articles) {
        // Find and update the article in the existing data
        const articleId = getArticleId(article);
        const articleIndex = existingData.articles.findIndex(a => getArticleId(a) === articleId);
        
        if (articleIndex !== -1) {
          // Update existing article with enriched data
          existingData.articles[articleIndex] = enrichedArticle;
          
          // Recalculate sentiment counts
          const sentimentCounts = {
            positive: 0,
            negative: 0,
            neutral: 0
          };
          
          existingData.articles.forEach(a => {
            const s = a.sentiment || 'neutral';
            sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
          });
          
          existingData.sentimentCounts = sentimentCounts;
          existingData.lastUpdatedExternal = Date.now();
          
          // Write back to KV
          await env.CRYPTO_NEWS_CACHE.put(KV_KEY_NEWS, JSON.stringify(existingData));
          console.log(`Updated article in KV: ${article.title?.substring(0, 50)}...`);
        } else {
          console.warn(`Article not found in KV (may have been removed): ${articleId}`);
          // Article was queued but not found in KV - this could happen if:
          // 1. KV write failed in producer
          // 2. Article was removed/expired from KV
          // Store as new entry to preserve enriched data
          const newData = {
            articles: [enrichedArticle],
            totalArticles: 1,
            lastUpdatedExternal: Date.now(),
            sentimentCounts: {
              positive: enrichedArticle.sentiment === 'positive' ? 1 : 0,
              negative: enrichedArticle.sentiment === 'negative' ? 1 : 0,
              neutral: enrichedArticle.sentiment === 'neutral' ? 1 : 0
            }
          };
          await env.CRYPTO_NEWS_CACHE.put(KV_KEY_NEWS, JSON.stringify(newData));
          console.log(`Stored as new entry in KV: ${article.title?.substring(0, 50)}...`);
        }
      } else {
        console.warn('No existing data in KV to update');
      }
      
      // Acknowledge message (mark as processed)
      message.ack();
      
    } catch (error) {
      console.error(`Error processing article "${article.title?.substring(0, 50)}..." (ID: ${getArticleId(article)}):`, error);
      // Retry the message (don't ack it)
      message.retry();
    }
  }
  
  console.log(`Batch processing complete`);
}

export default {
  async queue(batch, env) {
    return queue(batch, env);
  }
};
