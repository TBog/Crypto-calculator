/**
 * Scheduled Cloudflare Worker for Processing Pending Bitcoin News Articles
 * 
 * This worker runs on a cron schedule (every 3 minutes) to:
 * 1. Read articles from D1 that need processing (check postprocessing flags)
 * 2. Process 1 article per run (free tier limit - HTML rewriter is CPU intensive)
 * 3. Update each article in D1 after processing (incremental writes for reliability)
 * 4. Update KV cache with final results after processing batch
 * 
 * Also supports on-demand processing via HTTP GET:
 * - URL: GET /process?articleId=<id>
 * - Processes a specific article immediately
 * - Returns processing result as JSON
 * 
 * Postprocessing flags:
 * - needsSentiment: true → needs sentiment analysis
 * - needsSummary: true → needs AI summary generation
 * - contentTimeout: integer → number of failed fetch attempts (retry if < 3)
 * - summaryError: string → reason why summary failed (for debugging)
 * 
 * Summary error reasons:
 * - "content_mismatch" → webpage doesn't match article title
 * - "fetch_failed (attempt X/3)" → failed to fetch content, retry count
 * - "no_link" → article has no URL
 * - "error: <msg> (attempt X/3)" → AI generation error with retry count
 * 
 * This approach with D1+KV:
 * - Processing articles one at a time (prevents CPU timeout on free tier)
 * - Running frequently (every 3 minutes) to maintain throughput
 * - Using D1 for intermediate article updates during processing
 * - Using KV only for final results cache (reduces KV writes to ~160/day)
 * - Phase-based processing with D1 updates after each step for crash recovery
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
import {
  getArticlesNeedingProcessing,
  getArticleById,
  updateArticle as updateArticleInD1,
  updateCheckpoint,
  rowToArticle,
  getAllArticles
} from '../shared/d1-utils.js';



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
 * - Phase 0 (needsSentiment): Analyze sentiment, save to D1, exit
 * - Phase 1 (no extractedContent): Scrape content (raw/undecoded), save to D1, exit
 * - Phase 2 (has extractedContent): Decode and run AI summary, save to D1, exit
 * 
 * This splits work naturally without defensive saves during processing.
 * The 3-minute cron schedule ensures phases execute quickly in sequence.
 * Each phase updates D1 status for crash recovery and resumability.
 * 
 * Checks postprocessing flags and processes accordingly:
 * - needsSentiment: true → needs sentiment analysis
 * - needsSummary: true → needs AI summary generation
 * - contentTimeout: integer → number of failed attempts (retry if < MAX_ATTEMPTS)
 * 
 * @param {D1Database} db - D1 database instance
 * @param {Object} env - Environment variables
 * @param {Object} article - Article to process
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Processed article with updates
 */
async function processArticle(db, env, article, config) {
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
      
      // Update article in D1
      const articleId = getArticleId(article);
      await updateArticleInD1(db, articleId, {
        sentiment: sentimentResult,
        needsSentiment: false,
        processedAt: Date.now()
      });
      
    } catch (error) {
      console.error(`  Failed sentiment analysis:`, error.message);
      // Keep flag as true to retry next run, but still record last processing attempt time
      updates.processedAt = Date.now();
      
      // Update only processedAt in D1
      const articleId = getArticleId(article);
      await updateArticleInD1(db, articleId, {
        processedAt: Date.now()
      });
      
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
          
          // Update article in D1 with extracted content or error
          const articleId = getArticleId(article);
          const articleUpdates = {
            contentTimeout: updates.contentTimeout,
            summaryError: updates.summaryError,
            processedAt: updates.processedAt
          };
          
          // Only update needsSummary if this run explicitly set it
          if (updates.needsSummary !== undefined) {
            articleUpdates.needsSummary = updates.needsSummary;
          }
          
          await updateArticleInD1(db, articleId, articleUpdates);
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
        const timeoutCount = article.contentTimeout || 0;
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
      
      // Update article in D1 after AI phase
      if (needsUpdate) {
        updates.processedAt = Date.now();
        
        const articleId = getArticleId(article);
        await updateArticleInD1(db, articleId, {
          aiSummary: updates.aiSummary,
          needsSummary: updates.needsSummary !== undefined ? updates.needsSummary : undefined,
          contentTimeout: updates.contentTimeout,
          summaryError: updates.summaryError,
          processedAt: updates.processedAt
        });
      }
    } else {
      console.log(`  AI Summary: No link available`);
      // No link, set flag to false (can't process)
      updates.needsSummary = false;
      updates.summaryError = 'no_link';  // Store reason for failure
      needsUpdate = true;
      
      // Update article in D1
      updates.processedAt = Date.now();
      const articleId = getArticleId(article);
      await updateArticleInD1(db, articleId, {
        needsSummary: false,
        summaryError: 'no_link',
        processedAt: updates.processedAt
      });
    }
  }
  
  // Mark processing timestamp
  if (needsUpdate) {
    updates.processedAt = Date.now();
  }
  
  return updates;
}

/**
 * Helper function to check if an article needs processing
 * @param {Object} article - Article object (D1 row format with integers for booleans)
 * @param {Object} config - Configuration object
 * @returns {boolean} True if article needs processing
 */
function articleNeedsProcessing(article, config) {
  // Convert D1 integer booleans to actual booleans
  const needsSentiment = article.needsSentiment === 1;
  const needsSummary = article.needsSummary === 1;
  
  return needsSentiment || 
         needsSummary || 
         (article.contentTimeout && article.contentTimeout < config.MAX_CONTENT_FETCH_ATTEMPTS);
}

/**
 * Helper function to check if an article is fully complete
 * @param {Object} article - Article object (D1 row format with integers for booleans)
 * @param {Object} config - Configuration object
 * @returns {boolean} True if article is fully complete
 */
function articleIsComplete(article, config) {
  // Convert D1 integer booleans to actual booleans
  const needsSentiment = article.needsSentiment === 1;
  const needsSummary = article.needsSummary === 1;
  
  return !needsSentiment && 
         !needsSummary && 
         !(article.contentTimeout && article.contentTimeout < config.MAX_CONTENT_FETCH_ATTEMPTS);
}

/**
 * Process next batch of articles from D1
 * Simplified approach: Read articles from D1, process them, update D1
 * 
 * @param {D1Database} db - D1 database instance
 * @param {Object} env - Environment variables (for AI processing)
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Result object with { processed: number, articlesProcessed: Array }
 */
async function processBatchFromD1(db, env, config) {
  const maxArticles = config.MAX_ARTICLES_PER_RUN || 5;
  
  console.log(`Reading up to ${maxArticles} articles needing processing from D1...`);
  
  // Get articles from D1 that need processing
  const articlesToProcess = await getArticlesNeedingProcessing(db, maxArticles);
  
  if (articlesToProcess.length === 0) {
    console.log('No articles need processing');
    return { processed: 0, articlesProcessed: [], fullyProcessed: [] };
  }
  
  console.log(`Found ${articlesToProcess.length} article(s) needing processing`);
  
  const processedArticles = [];
  const fullyProcessedArticles = [];
  
  // Process each article
  for (const article of articlesToProcess) {
    const articleId = article.id;
    console.log(`Processing article: ${articleId} - "${article.title?.substring(0, 50)}..."`);
    
    try {
      // Convert D1 row to article object format for processing
      const articleObj = rowToArticle(article);
      
      // Update checkpoint to track current article
      await updateCheckpoint(db, articleId);
      
      // Process the article (updates D1 internally)
      await processArticle(db, env, articleObj, config);
      
      // Clear checkpoint after processing
      await updateCheckpoint(db, null);
      
      // Check if article is now fully processed (no more flags set)
      const updatedArticle = await getArticleById(db, articleId);
      const isFullyProcessed = updatedArticle && 
                              updatedArticle.needsSentiment === 0 && 
                              updatedArticle.needsSummary === 0;
      
      if (isFullyProcessed) {
        fullyProcessedArticles.push(updatedArticle);
      }
      
      processedArticles.push(articleId);
      
    } catch (error) {
      console.error(`Failed to process article ${articleId}:`, error.message);
      // Clear checkpoint on failure to avoid getting stuck on this article
      try {
        await updateCheckpoint(db, null);
      } catch (checkpointError) {
        console.error('Failed to clear checkpoint after processing error:', checkpointError.message);
      }
      // Continue with next article - don't fail entire batch
    }
  }
  
  console.log(`Processed ${processedArticles.length} article(s), ${fullyProcessedArticles.length} fully processed`);
  
  return { 
    processed: processedArticles.length, 
    articlesProcessed: processedArticles,
    fullyProcessed: fullyProcessedArticles
  };
}
/**
 * Update KV cache with fully processed articles
 * This writes individual articles to KV when they complete processing
 * 
 * @param {Object} kv - KV storage binding
 * @param {Array} fullyProcessedArticles - Array of D1 article rows that are fully processed
 * @param {Object} config - Configuration object
 * @returns {Promise<number>} Number of articles written to KV
 */
async function updateKVWithProcessedArticles(kv, fullyProcessedArticles, config) {
  if (fullyProcessedArticles.length === 0) {
    console.log('No fully processed articles to update in KV');
    return 0;
  }
  
  console.log(`Updating KV with ${fullyProcessedArticles.length} fully processed article(s)...`);
  
  // Convert D1 rows to article objects
  const articleObjects = fullyProcessedArticles.map(rowToArticle);
  
  // Write each article to KV
  const writePromises = [];
  
  for (const article of articleObjects) {
    const articleId = getArticleId(article);
    if (!articleId) continue;
    
    const articleKey = `article:${articleId}`;
    const promise = kv.put(
      articleKey,
      JSON.stringify(article),
      { expirationTtl: config.ID_INDEX_TTL || 60 * 60 * 24 * 30 }
    );
    
    writePromises.push(promise);
  }
  
  // Wait for all writes to complete
  const results = await Promise.allSettled(writePromises);
  
  // Count successful writes
  let writtenCount = 0;
  results.forEach(result => {
    if (result.status === 'fulfilled') {
      writtenCount++;
    } else {
      console.error('Failed to write article to KV:', result.reason);
    }
  });
  
  console.log(`✓ Updated ${writtenCount} fully processed articles in KV`);
  
  return writtenCount;
}

/**
 * Main scheduled event handler with D1-based processing
 * 
 * Architecture:
 * 1. Read articles from D1 that need processing
 * 2. Process articles (updates D1 incrementally)
 * 3. Write fully processed articles to KV
 * 
 * The updater manages the KV article ID list, processor only updates individual articles.
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
    // Process batch of articles from D1
    const result = await processBatchFromD1(env.DB, env, config);
    
    if (result.processed > 0) {
      console.log(`✓ Processed ${result.processed} article(s)`);
      
      // Update KV only with fully processed articles
      if (result.fullyProcessed && result.fullyProcessed.length > 0) {
        const cachedCount = await updateKVWithProcessedArticles(
          env.CRYPTO_NEWS_CACHE, 
          result.fullyProcessed, 
          config
        );
        console.log(`✓ Updated ${cachedCount} fully processed articles in KV`);
      } else {
        console.log('No articles fully processed in this batch');
      }
    } else {
      console.log('No articles to process - idle run');
    }
    
    console.log('=== Bitcoin News Processor Cron Job Completed Successfully ===');
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
    
    // Read article from D1
    const article = await getArticleById(env.DB, articleId);
    
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
    
    // Convert D1 row to article object
    const articleObj = rowToArticle(article);

    // Check if we should return the article text
    if (articleText) {
      const content = await fetchArticleContent(articleObj.link, articleText === "debug");
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Article text sent to AI for summary',
        link: articleObj.link,
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
    const needsProcessing = forceProcess || articleNeedsProcessing(article, config);
    
    if (!needsProcessing) {
      return new Response(JSON.stringify({
        success: true,
        message: 'Article already processed',
        article: articleObj
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // If force processing, reset flags
    if (forceProcess) {
      articleObj.needsSummary = true;
      articleObj.contentTimeout = 1;
    }
    
    // Process the article (updates D1 internally)
    console.log(`Processing article: "${articleObj.title?.substring(0, 50)}..."`);
    
    await processArticle(env.DB, env, articleObj, config);
    
    // Read updated article from D1
    const updatedArticle = await getArticleById(env.DB, articleId);
    const updatedArticleObj = rowToArticle(updatedArticle);
    
    // Update KV cache with the processed article
    const articleKey = `article:${articleId}`;
    await env.CRYPTO_NEWS_CACHE.put(articleKey, JSON.stringify(updatedArticleObj), {
      expirationTtl: config.ID_INDEX_TTL || 60 * 60 * 24 * 30
    });
    
    console.log(`Article processed and updated in D1 and KV cache`);
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Article processed successfully',
      article: updatedArticleObj
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
export { 
  TextExtractor, 
  fetchArticleContent, 
  processBatchFromD1, 
  processArticle, 
  articleNeedsProcessing, 
  articleIsComplete, 
  updateKVWithProcessedArticles 
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
  
  async fetch(request, env, ctx) {
    return handleFetch(request, env);
  }
};
