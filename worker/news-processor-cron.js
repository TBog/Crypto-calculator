/**
 * Scheduled Cloudflare Worker for Processing Pending Bitcoin News Articles
 * 
 * This worker runs on a cron schedule (every 10 minutes) to:
 * 1. Read articles from KV that need processing (check postprocessing flags)
 * 2. Process up to 5 articles per run (to stay within subrequest limits)
 * 3. Update each article in KV after processing (incremental writes for reliability)
 * 
 * Also supports on-demand processing via HTTP GET:
 * - URL: GET /process?articleId=<id>
 * - Processes a specific article immediately
 * - Returns processing result as JSON
 * 
 * Postprocessing flags:
 * - needsSentiment: true → needs sentiment analysis
 * - needsSummary: true → needs AI summary generation
 * - contentTimeout: integer → number of failed fetch attempts (retry if < 5)
 * - summaryError: string → reason why summary failed (for debugging)
 * 
 * Summary error reasons:
 * - "content_mismatch" → webpage doesn't match article title
 * - "fetch_failed (attempt X/5)" → failed to fetch content, retry count
 * - "no_link" → article has no URL
 * - "error: <msg> (attempt X/5)" → AI generation error with retry count
 * 
 * This approach solves the "Too many subrequests" error by:
 * - Processing articles in small batches (5 at a time)
 * - Running frequently (every 10 minutes) to keep articles up-to-date
 * - Using free KV storage instead of paid Queues
 * 
 * Neuron Budget Optimization:
 * - Content extraction skips headers, footers, navigation, ads, and sidebars
 * - Only main article content is sent to AI for summarization
 * - Reduces neuron usage by 50-70%, maximizing daily 10,000 neuron budget on Free Tier
 */

// KV keys (must match news-updater-cron.js)
const KV_KEY_NEWS = 'BTC_ANALYZED_NEWS';
const KV_KEY_IDS = 'BTC_ID_INDEX';

// Maximum articles to process per run (stay within subrequest limits)
// 5 articles × 3 subrequests (fetch + 2 AI calls) = 15 subrequests (well under 50 limit)
const MAX_ARTICLES_PER_RUN = 5;

// Maximum characters to extract from webpage (128KB limit for AI context)
const MAX_CONTENT_CHARS = 10 * 1024;

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
 * Optimized to skip headers, footers, menus, and other non-content elements
 * to reduce Cloudflare neuron usage.
 * 
 * Performance optimizations:
 * - Static skip tags (nav, header, footer, etc.) removed via element.remove() at Rust level
 * - Pre-compiled regex for dynamic pattern matching (class/ID based)
 * - Check canHaveContent before attaching onEndTag listeners
 * - Early exit when max content reached
 * - Set-based tag lookups for O(1) performance
 */
class TextExtractor {
  // Remaining tags that need skipDepth tracking (not removed via element.remove())
  // Moved button, input, select, textarea here as they're often inline and safer with depth tracking
  static SKIP_TAGS = new Set([
    'button', 'input', 'select', 'textarea'
  ]);
  
  // Pre-compiled regex for pattern matching (much faster than array.some with includes)
  // Matches skip patterns in class names and IDs
  static SKIP_REGEXP = /(?:^|\s)(nav|menu|menu-item|header|footer|sidebar|aside|advertisement|ad-|promo|banner|widget|share|social|comment|related|recommend)(?:\s|$)/i;
  
  constructor() {
    this.textChunks = [];
    this.charCount = 0;
    this.maxChars = MAX_CONTENT_CHARS;
    this.skipDepth = 0; // Track depth of skipped elements (for dynamic patterns only)
    this.debugOutput = false;
    this.lastElementTagName = null;
  }

  /**
   * Enable debug output mode for text extraction.
   * 
   * WARNING: Debug mode is for inspection and troubleshooting only.
   * When enabled, element tags like "[div]" and "(p)" are inserted into the extracted text,
   * contaminating the actual article content. The resulting text should NOT be used for
   * production processing, AI summarization, or any automated workflows.
   * 
   * Debug mode is useful for:
   * - Understanding which HTML elements contributed to the extracted text
   * - Debugging extraction issues and verifying skip patterns work correctly
   * - Manual inspection and testing of the text extraction logic
   */
  setDebugOutput() {
    this.debugOutput = true;
  }
  
  element(element) {
    // HTMLRewriter may invoke element handlers for nodes that have been removed
    if (element.removed) return;

    // Early exit if we already have enough content (saves CPU on large pages)
    if (this.charCount >= this.maxChars) return;

    const tagName = element.tagName.toLowerCase();
    this.lastElementTagName = tagName;

    // Check if this element can have content and closing tag
    const canHaveEndTag = element.canHaveContent && !element.selfClosing;
    
    // Quick tag check first (O(1) with Set) - only for remaining tags
    if (TextExtractor.SKIP_TAGS.has(tagName)) {
      // Only track skip depth for elements with content
      if (canHaveEndTag) {
        this.skipDepth++;
        element.onEndTag(() => {
          this.skipDepth--;
        });
      }
      // Self-closing elements (like input) don't need depth tracking - no content to skip
      return; // Skip pattern check if already matched by tag
    }
    
    // Only check patterns if not already skipping (optimization)
    if (this.skipDepth === 0) {
      // Check for common ad/menu class names and IDs using pre-compiled regex
      const className = element.getAttribute('class') || '';
      const id = element.getAttribute('id') || '';
      const combined = className + ' ' + id;
      
      // Early exit if no meaningful class or id (nothing to check)
      if (!combined.trim()) return;
      
      // Use regex test (faster than some/includes pattern)
      if (TextExtractor.SKIP_REGEXP.test(combined)) {
        // Only track skip depth for elements with content
        if (canHaveEndTag) {
          this.skipDepth++;
          element.onEndTag(() => {
            this.skipDepth--;
          });
        }
        // Self-closing elements don't need depth tracking - no content to skip
      }
    }

    if (this.debugOutput && this.skipDepth === 0) {
      this.textChunks.push("[" + tagName + "]\n");
    }
  }
  
  text(text) {
    // HTMLRewriter may invoke text handlers for nodes that have been removed
    if (text.removed) return;

    // Only extract text if we're not inside a skipped element and haven't reached limit
    if (this.skipDepth === 0 && this.charCount < this.maxChars) {
      const content = text.text;
      if (content && content.trim()) {
        if (this.debugOutput) {
          this.textChunks.push("(" + this.lastElementTagName + ")");
        }
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
 * @param {boolean} enableDebug - Enable debug output in TextExtractor to show extracted element tags.
 *                                WARNING: Debug mode contaminates text with element markers and should
 *                                only be used for inspection/troubleshooting, NOT for production processing.
 * @returns {Promise<string|null>} Article text content or null on error
 */
async function fetchArticleContent(url, enableDebug = false) {
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
    if (enableDebug) {
      extractor.setDebugOutput();
    }
    
    // Use element.remove() for static skip tags (more efficient - removes at Rust level)
    // This prevents text() handler from even waking up for content inside these tags
    const rewriter = new HTMLRewriter();
    
    // Define static skip tags as an array for clarity and easy edits
    const tagsToRemove = [
      'script', 'style', 'nav', 'header', 'footer', 'aside', 'menu',
      'form', 'svg', 'canvas', 'iframe', 'noscript'
    ];
    
    // Register remove handlers for each tag
    // Note: Both element and text handlers are needed. While text handlers receive t.removed=true,
    // explicitly calling t.remove() ensures the text is properly removed before other handlers process it.
    for (const tag of tagsToRemove) {
      rewriter.on(tag, { 
        element(e) { e.remove(); },
        text(t) { t.remove(); }
      });
    }

    // Register the text extractor for all other elements
    rewriter.on('*', extractor);
    
    const transformed = rewriter.transform(response);
    
    // Use ReadableStream to cancel fetch as soon as we have enough content
    // This physically severs the connection and stops CPU from processing more bytes
    const reader = transformed.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Check if we have enough content and stop immediately
        if (extractor.charCount >= MAX_CONTENT_CHARS) {
          await reader.cancel(); // Stop the parser and network IMMEDIATELY
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    
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
      max_tokens: 1024
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
  
  const needsSentiment = article.needsSentiment ?? true;
  const needsSummary = article.needsSummary ?? true;

  // Process sentiment if flag is true
  if (needsSentiment === true) {
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
  // contentTimeout is an integer counter of failed attempts (retry if < 5)
  // This allows us to retry the fetch in the next run instead of giving up
  const shouldRetry = article.contentTimeout && article.contentTimeout < 5;
  
  if (needsSummary === true || shouldRetry) {
    if (article.link) {
      try {
        const content = await fetchArticleContent(article.link);
        
        if (content) {
          const summary = await generateArticleSummary(env, article.title, content);
          
          if (summary) {
            updates.aiSummary = summary;         // Set actual summary text
            updates.needsSummary = false;        // Clear the flag
            updates.contentTimeout = undefined;  // Clear timeout counter
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
          // Increment timeout counter (start at 1 if undefined)
          const timeoutCount = (article.contentTimeout || 0) + 1;
          updates.contentTimeout = timeoutCount;
          updates.summaryError = `fetch_failed (attempt ${timeoutCount}/5)`;
          
          // If we've hit max retries, stop trying
          if (timeoutCount >= 5) {
            console.log(`  AI Summary: Max retries (${timeoutCount}) reached, giving up`);
            updates.needsSummary = false;  // Stop retrying
          }
          
          needsUpdate = true;
        }
      } catch (error) {
        console.error(`  Failed summary generation:`, error.message);
        // Increment timeout counter
        const timeoutCount = (article.contentTimeout || 0) + 1;
        updates.contentTimeout = timeoutCount;
        // Store detailed error reason for diagnosis
        updates.summaryError = `error: ${error.message.substring(0, 100)} (attempt ${timeoutCount}/5)`;
        
        // If we've hit max retries, stop trying
        if (timeoutCount >= 5) {
          console.log(`  AI Summary: Max retries (${timeoutCount}) reached, giving up`);
          updates.needsSummary = false;  // Stop retrying
        }
        
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
 */
async function handleScheduled(event, env) {
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
      (article.needsSentiment ?? true) || 
      (article.needsSummary ?? true) || 
      (article.contentTimeout && article.contentTimeout < 5)  // Retry if timeout count < 5
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

/**
 * Handle HTTP GET requests to process a specific article on demand
 * URL: /process?articleId=<id>
 * 
 * @param {Request} request - HTTP request
 * @param {Object} env - Environment variables
 * @returns {Promise<Response>} JSON response with processing result
 */
async function handleFetch(request, env) {
  try {
    // Only allow GET requests
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Method not allowed. Use GET with ?articleId=<id> parameter'
      }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // Parse URL and get articleId parameter
    const url = new URL(request.url);
    const articleId = url.searchParams.get('articleId');
    const forceProcess = url.searchParams.has('force');
    const articleText = url.searchParams.get('text');
    
    if (!articleId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing articleId parameter. Use ?articleId=<id>'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    console.log(`Processing on-demand request for article: ${articleId}`);
    
    // Read articles from KV
    const newsData = await env.CRYPTO_NEWS_CACHE.get(KV_KEY_NEWS, { type: 'json' });
    
    if (!newsData || !newsData.articles) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No articles found in KV'
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // Find the article by ID
    const articleIndex = newsData.articles.findIndex(a => getArticleId(a) === articleId);
    
    if (articleIndex === -1) {
      return new Response(JSON.stringify({
        success: false,
        error: `Article not found with ID: ${articleId}`
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    const article = newsData.articles[articleIndex];

    // Check if we should return the article text
    if (articleText) {
      const content = await fetchArticleContent(article.link, articleText === "debug");
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Article text sent to AI for summary',
        link: article.link,
        content: content
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // Check if article needs processing
    const needsProcessing = forceProcess ||
                           (article.needsSentiment ?? true) || 
                           (article.needsSummary ?? true) || 
                           ((article.contentTimeout ?? 0) < 5);
    
    if (needsProcessing) {
      // make sure we're generating a new summary
      article.needsSummary = true;
      article.contentTimeout = 1;
    } else {
      return new Response(JSON.stringify({
        success: true,
        message: 'Article already processed',
        article: article
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // Process the article
    console.log(`Processing article: "${article.title?.substring(0, 50)}..."`);
    const updatedArticle = await processArticle(env, article);
    
    // Update article in KV
    newsData.articles[articleIndex] = updatedArticle;
    
    // Recalculate sentiment counts
    const sentimentCounts = {
      positive: 0,
      negative: 0,
      neutral: 0
    };
    
    newsData.articles.forEach(a => {
      const s = a.sentiment;
      if (typeof s === 'string' && ['positive', 'negative', 'neutral'].includes(s)) {
        sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
      }
    });
    
    newsData.sentimentCounts = sentimentCounts;
    newsData.lastUpdatedExternal = Date.now();
    
    // Write back to KV
    await env.CRYPTO_NEWS_CACHE.put(KV_KEY_NEWS, JSON.stringify(newsData));
    
    console.log(`Article processed and updated in KV`);
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Article processed successfully',
      article: updatedArticle
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
    
  } catch (error) {
    console.error('Error processing on-demand request:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Internal server error'
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
  
  async fetch(request, env, ctx) {
    return handleFetch(request, env);
  }
};
