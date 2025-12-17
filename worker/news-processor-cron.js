/**
 * Scheduled Cloudflare Worker for Processing Pending Bitcoin News Articles
 * 
 * This worker runs on a cron schedule (every 10 minutes) to:
 * 1. Read articles from KV that need processing (check postprocessing flags)
 * 2. Process up to 5 articles per run (to stay within subrequest limits)
 * 3. Update each article in KV after processing (incremental writes for reliability)
 * 
 * Postprocessing flags:
 * - needsSentiment: true → needs sentiment analysis
 * - needsSummary: true → needs AI summary generation
 * - contentTimeout: true → previous fetch timed out, retry this run
 * - summaryError: string → reason why summary failed (for debugging)
 * 
 * Summary error reasons:
 * - "content_mismatch" → webpage doesn't match article title
 * - "fetch_failed" → failed to fetch content
 * - "no_link" → article has no URL
 * - "error: <msg>" → AI generation error (token limits, API errors, etc.)
 * 
 * This approach solves the "Too many subrequests" error by:
 * - Processing articles in small batches (5 at a time)
 * - Running frequently (every 10 minutes) to keep articles up-to-date
 * - Using free KV storage instead of paid Queues
 */

// KV keys (must match news-updater-cron.js)
const KV_KEY_NEWS = 'BTC_ANALYZED_NEWS';
const KV_KEY_IDS = 'BTC_ID_INDEX';

// Maximum articles to process per run (stay within subrequest limits)
// 5 articles × 3 subrequests (fetch + 2 AI calls) = 15 subrequests (well under 50 limit)
const MAX_ARTICLES_PER_RUN = 5;

// Maximum characters to extract from webpage (128KB limit for AI context)
const MAX_CONTENT_CHARS = 128 * 1024;

/**
 * Get article ID from article object
 * @param {Object} article - Article object
 * @returns {string|null} Article ID or null if not available
 */
function getArticleId(article) {
  return article.article_id || article.link || null;
}

/**
 * HTMLRewriter handler to extract text content from HTML
 */
class TextExtractor {
  constructor() {
    this.textChunks = [];
    this.charCount = 0;
    this.maxChars = MAX_CONTENT_CHARS;
  }
  
  element(element) {
    // Skip script, style, and other non-content elements
  }
  
  text(text) {
    if (this.charCount < this.maxChars) {
      const content = text.text;
      if (content && content.trim()) {
        this.textChunks.push(content);
        this.charCount += content.length;
      }
    }
  }
  
  getText() {
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
      signal: AbortSignal.timeout(10000)
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
 * @throws {Error} With detailed message if AI processing fails
 */
async function generateArticleSummary(env, title, content) {
  try {
    if (!content || content.length < 100) {
      return null;
    }
    
    // Log content length for debugging token issues
    console.log(`  Content length: ${content.length} chars (~${Math.ceil(content.length / 4)} tokens)`);
    
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
    // Re-throw with more context about what failed
    const errorMsg = error.message || String(error);
    console.error('Failed to generate summary:', errorMsg);
    throw new Error(`AI_generation_failed: ${errorMsg}`);
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
 * Process a single article with AI analysis
 * Checks postprocessing flags and processes accordingly:
 * - needsSentiment: true → needs sentiment analysis
 * - needsSummary: true → needs AI summary generation
 * - contentTimeout: true → previous fetch timed out, retry
 * 
 * @param {Object} env - Environment variables
 * @param {Object} article - Article to process
 * @returns {Promise<Object>} Processed article with updates
 */
async function processArticle(env, article) {
  const updates = { ...article };
  let needsUpdate = false;
  
  // Process sentiment if flag is true
  if (article.needsSentiment === true) {
    try {
      const sentimentResult = await analyzeSentiment(env, article);
      updates.sentiment = sentimentResult;  // Set actual sentiment value
      updates.needsSentiment = false;       // Clear the flag
      needsUpdate = true;
      console.log(`  Sentiment: ${sentimentResult}`);
    } catch (error) {
      console.error(`  Failed sentiment analysis:`, error.message);
      // Keep flag as true to retry next run
    }
  }
  
  // Process AI summary if flag is true OR if we're retrying after contentTimeout
  // contentTimeout flag is set when fetch(article.link) times out or fails
  // This allows us to retry the fetch in the next run instead of giving up
  if (article.needsSummary === true || article.contentTimeout === true) {
    if (article.link) {
      try {
        const content = await fetchArticleContent(article.link);
        
        if (content) {
          const summary = await generateArticleSummary(env, article.title, content);
          
          if (summary) {
            updates.aiSummary = summary;         // Set actual summary text
            updates.needsSummary = false;        // Clear the flag
            updates.contentTimeout = undefined;  // Clear timeout flag if it was set
            updates.summaryError = undefined;    // Clear any previous error
            needsUpdate = true;
            console.log(`  AI Summary: Generated (${summary.length} chars)`);
          } else {
            console.log(`  AI Summary: Content mismatch or too short`);
            // Set flag to false (don't retry - content doesn't match)
            updates.needsSummary = false;
            updates.contentTimeout = undefined;
            updates.summaryError = 'content_mismatch';  // Store reason for failure
            needsUpdate = true;
          }
        } else {
          console.log(`  AI Summary: Failed to fetch content`);
          // Keep needsSummary flag, but mark as timeout for retry
          updates.contentTimeout = true;
          updates.summaryError = 'fetch_failed';  // Store reason for failure
          needsUpdate = true;
        }
      } catch (error) {
        console.error(`  Failed summary generation:`, error.message);
        // Set contentTimeout flag so we can retry next run
        updates.contentTimeout = true;
        // Store detailed error reason for diagnosis
        updates.summaryError = `error: ${error.message.substring(0, 100)}`;
        needsUpdate = true;
      }
    } else {
      console.log(`  AI Summary: No link available`);
      // No link, set flag to false (can't process)
      updates.needsSummary = false;
      updates.summaryError = 'no_link';  // Store reason for failure
      needsUpdate = true;
    }
  }
  
  // Mark processing timestamp
  if (needsUpdate) {
    updates.processedAt = Date.now();
  }
  
  return updates;
}

/**
 * Main scheduled event handler for processing pending articles
 * @param {Event} event - Scheduled event
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Execution context
 */
async function handleScheduled(event, env, ctx) {
  console.log('=== Bitcoin News Processor Cron Job Started ===');
  console.log(`Execution time: ${new Date().toISOString()}`);
  
  try {
    // Step 1: Read articles from KV
    console.log('Step 1: Reading articles from KV...');
    const newsData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY_NEWS, { type: 'json' });
    
    if (!newsData || !newsData.articles || newsData.articles.length === 0) {
      console.log('No articles found in KV');
      console.log('=== Bitcoin News Processor Cron Job Completed (No Articles) ===');
      return;
    }
    
    // Step 2: Find articles that need processing (in reverse chronological order - newest first)
    console.log('Step 2: Finding articles that need processing...');
    const pendingArticles = newsData.articles.filter(article => 
      article.needsSentiment === true || article.needsSummary === true || article.contentTimeout === true
    );
    
    if (pendingArticles.length === 0) {
      console.log('No articles need processing');
      console.log('=== Bitcoin News Processor Cron Job Completed (All Done) ===');
      return;
    }
    
    console.log(`Found ${pendingArticles.length} articles needing processing`);
    
    // Step 3: Process up to MAX_ARTICLES_PER_RUN articles
    const articlesToProcess = pendingArticles.slice(0, MAX_ARTICLES_PER_RUN);
    console.log(`Processing ${articlesToProcess.length} articles this run...`);
    
    let processedCount = 0;
    
    for (const article of articlesToProcess) {
      const articleId = getArticleId(article);
      console.log(`\nProcessing article ${processedCount + 1}/${articlesToProcess.length}: "${article.title?.substring(0, 50)}..."`);
      
      try {
        // Process the article
        const updatedArticle = await processArticle(env, article);
        
        // Step 4: Update article in KV after processing (incremental write)
        // Find and replace the article in the array
        const articleIndex = newsData.articles.findIndex(a => getArticleId(a) === articleId);
        
        if (articleIndex !== -1) {
          newsData.articles[articleIndex] = updatedArticle;
          
          // Recalculate sentiment counts (only count actual sentiment values, not flags)
          const sentimentCounts = {
            positive: 0,
            negative: 0,
            neutral: 0
          };
          
          newsData.articles.forEach(a => {
            const s = a.sentiment;
            // Only count if sentiment is a string value (not true/false flag)
            if (typeof s === 'string' && ['positive', 'negative', 'neutral'].includes(s)) {
              sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
            }
          });
          
          newsData.sentimentCounts = sentimentCounts;
          newsData.lastUpdatedExternal = Date.now();
          
          // Write updated data back to KV
          await env.CRYPTO_NEWS_CACHE.put(KV_KEY_NEWS, JSON.stringify(newsData));
          console.log(`  ✓ Article updated in KV`);
          
          processedCount++;
        } else {
          console.warn(`  Article not found in KV: ${articleId}`);
        }
      } catch (error) {
        console.error(`  ✗ Error processing article:`, error);
        // Continue with next article
      }
    }
    
    const remainingPending = pendingArticles.length - processedCount;
    console.log(`\n=== Bitcoin News Processor Cron Job Completed Successfully ===`);
    console.log(`Processed: ${processedCount} articles`);
    console.log(`Remaining: ${remainingPending} articles (will process in next run)`);
    
  } catch (error) {
    console.error('=== Bitcoin News Processor Cron Job Failed ===');
    console.error('Error:', error);
    throw error;
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env, ctx));
  }
};
