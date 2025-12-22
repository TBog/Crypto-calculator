/**
 * Scheduled Cloudflare Worker for Processing Pending Bitcoin News Articles
 * 
 * This worker runs on a cron schedule (every minute) to:
 * 1. Load MAX_ARTICLES_PER_RUN articles from KV (starting from last processed position)
 * 2. Process ALL loaded articles that need processing (not limited to MAX_ARTICLES_PER_RUN)
 * 3. Update each article in KV after processing (incremental writes for reliability)
 * 4. Track last processed article ID to resume from that position in next run
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
 * Resume-based processing approach:
 * - Loads articles in batches (MAX_ARTICLES_PER_RUN per run)
 * - Processes ALL loaded articles that need work
 * - Tracks last loaded article ID in KV to resume from next batch
 * - Cycles through entire article list, then resets to beginning
 * 
 * Neuron Budget Optimization:
 * - Content extraction skips headers, footers, navigation, ads, and sidebars
 * - Only main article content is sent to AI for summarization
 * - Reduces neuron usage by 50-70%, maximizing daily 10,000 neuron budget on Free Tier
 */

import { getArticleId } from '../shared/news-providers.js';
import { 
  getNewsProcessorConfig,
  MAX_CONTENT_FETCH_ATTEMPTS,
  decodeHTMLEntities
} from '../shared/constants.js';

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
  
  constructor(maxChars = 10 * 1024) {
    this.textChunks = [];
    this.charCount = 0;
    this.maxChars = maxChars;
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
  enableDebugOutput() {
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
      this.textChunks.push("[" + tagName + "]");
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
          // don't count the debug text in this.charCount to preserve the initial parsing amount
          this.textChunks.push("(" + this.lastElementTagName + ")");
        }
        this.textChunks.push(content);
        this.charCount += content.length;
      }
    }
  }
  
  getText() {
    let text = this.textChunks.join(' ');
    // replacing multiple space type characters with one space may take too long on large webpages
    //text = text.replace(/\s+/g, ' ').trim();
    
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
 * @param {number} maxContentChars - Maximum characters to extract from webpage
 * @returns {Promise<string|null>} Article text content or null on error
 */
async function fetchArticleContent(url, enableDebug = false, maxContentChars = 10 * 1024) {
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
    
    const extractor = new TextExtractor(maxContentChars);
    if (enableDebug) {
      extractor.enableDebugOutput();
    }
    
    // Use element.remove() for static skip tags (more efficient - removes at Rust level)
    // This prevents text() handler from even waking up for content inside these tags
    const rewriter = new HTMLRewriter();
    
    // Define static skip tags as an array for clarity and easy editing
    const tagsToRemove = [
      'script', 'style', 'nav', 'header', 'footer', 'aside', 'menu',
      'form', 'svg', 'canvas', 'iframe', 'noscript', 'title'
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
        if (extractor.charCount >= maxContentChars) {
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
 * 
 * Architecture: Phase-based processing across successive cron runs
 * - Phase 0 (needsSentiment): Analyze sentiment, save, exit
 * - Phase 1 (no extractedContent): Scrape content (raw/undecoded), save, exit
 * - Phase 2 (has extractedContent): Decode and run AI summary, save, exit
 * 
 * This splits work naturally without defensive saves during processing.
 * The 1-minute cron schedule ensures phases execute quickly in sequence.
 * 
 * Checks postprocessing flags and processes accordingly:
 * - needsSentiment: true → needs sentiment analysis
 * - needsSummary: true → needs AI summary generation
 * - contentTimeout: integer → number of failed attempts (retry if < MAX_ATTEMPTS)
 * 
 * @param {Object} env - Environment variables
 * @param {Object} article - Article to process
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Processed article with updates
 */
async function processArticle(env, article, config) {
  const updates = { ...article };
  let needsUpdate = false;
  
  const needsSentiment = article.needsSentiment ?? true;
  const needsSummary = article.needsSummary ?? true;

  // PHASE 0: Sentiment Analysis
  // Process sentiment as a separate phase before scraping/AI
  if (needsSentiment === true) {
    try {
      console.log(`  Phase 0: Analyzing sentiment...`);
      const sentimentResult = await analyzeSentiment(env, article);
      updates.sentiment = sentimentResult;  // Set actual sentiment value
      updates.needsSentiment = false;       // Clear the flag
      needsUpdate = true;
      console.log(`  ✓ Sentiment: ${sentimentResult}`);
      
    } catch (error) {
      console.error(`  Failed sentiment analysis:`, error.message);
      // Keep flag as true to retry next run, but still record last processing attempt time
      updates.processedAt = Date.now();
      return updates;
    }
  }

  if (needsUpdate) {
      // Exit after sentiment phase - scraping/AI will run in next cron call
      updates.processedAt = Date.now();
      return updates;
  }
  
  // Process AI summary if flag is true OR if we're retrying after contentTimeout
  // contentTimeout is an integer counter of failed attempts (retry if < MAX_CONTENT_FETCH_ATTEMPTS)
  // This allows us to retry the fetch in the next run instead of giving up
  const shouldRetry = article.contentTimeout && article.contentTimeout < config.MAX_CONTENT_FETCH_ATTEMPTS;
  
  if (needsSummary === true || shouldRetry) {
    if (article.link) {
      // PHASE 1: Content Scraping
      // Skip if we already have extracted content from a previous run
      let content = article.extractedContent || null;
      
      if (!content) {
        // Increment timeout counter for crash tracking only when we actually attempt scraping
        const timeoutCount = (article.contentTimeout || 0) + 1;
        updates.contentTimeout = timeoutCount;
        
        // This is the scraping phase - extract RAW content (undecoded) and exit
        try {
          console.log(`  Phase 1: Fetching article content...`);
          content = await fetchArticleContent(article.link, false, config.MAX_CONTENT_CHARS);
          
          if (content) {
            // Save RAW extracted content (undecoded) for next run
            // HTML entities will be decoded in Phase 2 when actually used
            updates.extractedContent = content;
            updates.summaryError = `scraping_complete (attempt ${timeoutCount}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`;
            needsUpdate = true;
            console.log(`  ✓ Content extracted (${content.length} chars, raw) - AI processing in next run`);
          } else {
            console.log(`  AI Summary: Failed to fetch content`);
            updates.summaryError = `fetch_failed (attempt ${timeoutCount}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`;
            
            // If we've hit max retries, stop trying
            if (timeoutCount >= config.MAX_CONTENT_FETCH_ATTEMPTS) {
              console.log(`  AI Summary: Max retries (${timeoutCount}) reached, giving up`);
              updates.needsSummary = false;  // Stop retrying
              updates.contentTimeout = undefined;
            }
            
            needsUpdate = true;
          }
        } catch (error) {
          console.error(`  Failed to fetch content:`, error.message);
          updates.summaryError = `fetch_error: ${error.message.substring(0, 100)} (attempt ${timeoutCount}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`;
          
          // If we've hit max retries, stop trying
          if (timeoutCount >= config.MAX_CONTENT_FETCH_ATTEMPTS) {
            console.log(`  AI Summary: Max retries (${timeoutCount}) reached, giving up`);
            updates.needsSummary = false;  // Stop retrying
            updates.contentTimeout = undefined;
          }
          
          needsUpdate = true;
        }
        
        // Exit after scraping phase - AI will run in next cron call
        if (needsUpdate) {
          updates.processedAt = Date.now();
        }
        return updates;
      }
      
      // PHASE 2: AI Processing
      // We have RAW content from previous run - decode and process with AI
      console.log(`  Phase 2: Using previously extracted content (${content.length} chars, raw)`);
      
      try {
        console.log(`  Generating AI summary...`);
        
        // Decode HTML entities in content ONLY when actually using it
        // This prevents double-decoding since we store raw content
        const decodedText = decodeHTMLEntities(content).replace(/\s+/g, ' ').trim();
        
        console.log(`  Decoded content (${decodedText.length} chars)`);
        
        const summary = await generateArticleSummary(env, article.title, decodedText);
        
        if (summary) {
          updates.aiSummary = summary;                // Set actual summary text
          updates.needsSummary = false;               // Clear the flag
          updates.contentTimeout = undefined;         // Clear timeout counter
          updates.summaryError = undefined;           // Clear any previous error
          updates.extractedContent = undefined;       // Clear cached content (no longer needed)
          needsUpdate = true;
          console.log(`  ✓ AI Summary: Generated (${summary.length} chars)`);
        } else {
          console.log(`  AI Summary: Content mismatch or too short`);
          // Set flag to false (don't retry - content doesn't match)
          updates.needsSummary = false;
          updates.contentTimeout = undefined;
          updates.extractedContent = undefined;       // Clear cached content
          updates.summaryError = 'content_mismatch';  // Store reason for failure
          needsUpdate = true;
        }
      } catch (error) {
        console.error(`  Failed AI summary generation:`, error.message);
        // Keep the extracted content for next retry
        updates.summaryError = `ai_error: ${error.message.substring(0, 100)} (attempt ${timeoutCount}/${config.MAX_CONTENT_FETCH_ATTEMPTS})`;
        
        // If we've hit max retries, stop trying
        if (timeoutCount >= config.MAX_CONTENT_FETCH_ATTEMPTS) {
          console.log(`  AI Summary: Max retries (${timeoutCount}) reached, giving up`);
          updates.needsSummary = false;               // Stop retrying
          updates.contentTimeout = undefined;
          updates.extractedContent = undefined;       // Clear cached content
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
 * Process articles batch using priority queue
 * 
 * This is the core processing logic extracted for testability.
 * Uses a KV-based queue to prioritize articles needing processing.
 * 
 * Queue behavior:
 * - Processes articles from the front of the queue
 * - Keeps articles in queue until all processing phases complete
 * - On fetch timeout, moves article to end of queue for retry
 * - Removes articles from queue when fully processed
 * 
 * @param {Object} kv - KV interface with get/put/delete methods
 * @param {Object} env - Environment for AI processing
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Result with processedCount and queue info
 */
async function processArticlesBatch(kv, env, config) {
  // Step 1: Read pending queue
  let pendingQueue = [];
  try {
    const queueData = await kv.get(config.KV_KEY_PENDING_QUEUE, { type: 'json' });
    if (queueData && Array.isArray(queueData)) {
      pendingQueue = queueData;
    }
  } catch (error) {
    console.error('Error reading pending queue:', error);
  }
  
  if (pendingQueue.length === 0) {
    return { 
      processedCount: 0, 
      loadedCount: 0, 
      queueLength: 0,
      status: 'no_articles' 
    };
  }
  
  // Step 2: Load articles from front of queue
  const articlesToLoad = Math.min(config.MAX_ARTICLES_PER_RUN, pendingQueue.length);
  const idsToLoad = pendingQueue.slice(0, articlesToLoad);
  
  const articlePromises = idsToLoad.map(id => 
    kv.get(`article:${id}`, { type: 'json' })
      .then(article => ({ id, article }))
  );
  
  const articleResults = await Promise.all(articlePromises);
  
  // Step 3: Process each article and track queue changes
  let processedCount = 0;
  const updatePromises = [];
  const idsToRemoveFromQueue = [];
  const idsToMoveToEnd = [];
  
  for (const { id, article } of articleResults) {
    if (!article) {
      console.warn(`Article not found for ID: ${id}, removing from queue`);
      idsToRemoveFromQueue.push(id);
      continue;
    }
    
    // Check if article still needs processing
    const needsProcessing = 
      (article.needsSentiment ?? true) || 
      (article.needsSummary ?? true) || 
      (article.contentTimeout && article.contentTimeout < config.MAX_CONTENT_FETCH_ATTEMPTS);
    
    if (!needsProcessing) {
      // Article is fully processed, remove from queue
      idsToRemoveFromQueue.push(id);
      continue;
    }
    
    try {
      // Process the article (one phase per run)
      const updatedArticle = await processArticle(env, article, config);
      
      // Check if processing resulted in a fetch timeout
      const hadTimeout = updatedArticle.contentTimeout > (article.contentTimeout || 0);
      
      if (hadTimeout && updatedArticle.contentTimeout < config.MAX_CONTENT_FETCH_ATTEMPTS) {
        // Move to end of queue for retry
        idsToMoveToEnd.push(id);
      } else {
        // Check if article is now fully processed
        const stillNeedsProcessing = 
          (updatedArticle.needsSentiment ?? false) || 
          (updatedArticle.needsSummary ?? false) || 
          (updatedArticle.contentTimeout && updatedArticle.contentTimeout < config.MAX_CONTENT_FETCH_ATTEMPTS);
        
        if (!stillNeedsProcessing) {
          // Fully processed, remove from queue
          idsToRemoveFromQueue.push(id);
        }
        // Otherwise, keep in queue at current position for next phase
      }
      
      // Queue the write operation
      const articleKey = `article:${id}`;
      updatePromises.push(
        kv.put(articleKey, JSON.stringify(updatedArticle), {
          expirationTtl: config.ID_INDEX_TTL || 60 * 60 * 24 * 30
        })
      );
      
      processedCount++;
    } catch (error) {
      console.error(`Error processing article ${id}:`, error);
      // On error, move to end of queue for retry
      idsToMoveToEnd.push(id);
    }
  }
  
  // Step 4: Batch write article updates
  if (updatePromises.length > 0) {
    await Promise.all(updatePromises);
  }
  
  // Step 5: Update the queue
  // Remove processed articles and articles to be moved
  let newQueue = pendingQueue.filter(id => 
    !idsToRemoveFromQueue.includes(id) && !idsToMoveToEnd.includes(id)
  );
  
  // Append articles to be retried to the end
  if (idsToMoveToEnd.length > 0) {
    newQueue.push(...idsToMoveToEnd);
  }
  
  // Save updated queue
  await kv.put(
    config.KV_KEY_PENDING_QUEUE,
    JSON.stringify(newQueue),
    {
      expirationTtl: config.ID_INDEX_TTL || 60 * 60 * 24 * 30
    }
  );
  
  return {
    processedCount,
    loadedCount: idsToLoad.length,
    queueLength: newQueue.length,
    removedFromQueue: idsToRemoveFromQueue.length,
    movedToEnd: idsToMoveToEnd.length,
    status: 'success'
  };
}

/**
 * Main scheduled event handler for processing pending articles
 * 
 * Uses a priority queue approach to process articles:
 * - Reads articles from pending queue (prioritizes unprocessed articles)
 * - Processes articles from front of queue
 * - Removes fully processed articles from queue
 * - Moves timeout/error articles to end of queue for retry
 * 
 * @param {Event} event - Scheduled event
 * @param {Object} env - Environment variables
 */
async function handleScheduled(event, env) {
  console.log('=== Bitcoin News Processor Cron Job Started ===');
  console.log(`Execution time: ${new Date().toISOString()}`);
  
  // Load configuration with environment variable overrides
  const config = getNewsProcessorConfig(env);
  
  try {
    const result = await processArticlesBatch(env.CRYPTO_NEWS_CACHE, env, config);
    
    if (result.status === 'no_articles') {
      console.log('No articles in pending queue');
      console.log('=== Bitcoin News Processor Cron Job Completed (No Articles) ===');
      return;
    }
    
    console.log(`\n=== Bitcoin News Processor Cron Job Completed Successfully ===`);
    console.log(`Loaded: ${result.loadedCount} articles`);
    console.log(`Processed: ${result.processedCount} articles`);
    console.log(`Removed from queue: ${result.removedFromQueue} articles`);
    console.log(`Moved to end for retry: ${result.movedToEnd} articles`);
    console.log(`Queue length: ${result.queueLength} articles remaining`);
    
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
  const config = getNewsProcessorConfig(env);
  
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
    
    // Read article from KV
    const articleKey = `article:${articleId}`;
    const article = await env.CRYPTO_NEWS_CACHE.get(articleKey, { type: 'json' });
    
    if (!article) {
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
                           ((article.contentTimeout ?? 0) < config.MAX_CONTENT_FETCH_ATTEMPTS);
    
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
    
    const updatedArticle = await processArticle(env, article, config);
    
    // Write back to KV
    await env.CRYPTO_NEWS_CACHE.put(articleKey, JSON.stringify(updatedArticle), {
      expirationTtl: config.ID_INDEX_TTL || 60 * 60 * 24 * 30
    });
    
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

// Export for testing
export { TextExtractor, fetchArticleContent, processArticlesBatch };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
  
  async fetch(request, env, ctx) {
    return handleFetch(request, env);
  }
};
