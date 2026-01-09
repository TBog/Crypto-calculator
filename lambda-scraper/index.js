/**
 * AWS Lambda Function for Bitcoin News Article Scraping
 * 
 * This function replaces the Cloudflare Worker processor's HTMLRewriter-based
 * text extraction with a full headless browser environment using Puppeteer + Chromium.
 * 
 * Architecture:
 * - Trigger: Amazon EventBridge (CloudWatch Events) - every 2 minutes
 * - Runtime: Node.js with 1024 MB memory, 20-second timeout
 * - Browser: Chromium via @sparticuz/chromium Lambda Layer
 * - Execution: Batch processing with parallel tabs (2+ sites simultaneously)
 * - Storage: Cloudflare D1 via Client API
 * 
 * Free Tier Safety:
 * - Monthly invocations: ~21,600 (well below 1M limit)
 * - Compute time: ~172,800 GB-seconds @ 8s avg (well below 400K limit)
 * - Data transfer: Minimal text egress (well below 100 GB limit)
 * 
 * Processing Flow:
 * 1. Fetch articles needing processing from Cloudflare D1
 * 2. Launch single browser context for batch
 * 3. Open parallel tabs (2+ per batch) for efficiency
 * 4. Extract text using browser DOM traversal (ports HTMLRewriter logic)
 * 5. Update articles back to Cloudflare D1
 * 6. Gracefully handle individual site failures without crashing batch
 */

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// Configuration constants ported from worker/shared/constants.js
const MAX_CONTENT_CHARS = 10 * 1024; // 10KB max content per article
const MAX_CONTENT_FETCH_ATTEMPTS = 3; // Max retries for failed scrapes
const BATCH_SIZE = 2; // Process 2 sites in parallel per invocation
const BROWSER_TIMEOUT = 10000; // 10s timeout for page load
const PAGE_IDLE_TIMEOUT = 2000; // 2s wait for networkidle2

// HTML entity decoding map (ported from constants.js)
const HTML_ENTITY_MAP = {
  'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'", 'nbsp': ' '
};

const HTML_ENTITY_REGEX = /&(?:#(\d+)|#x([a-fA-F\d]+)|([a-zA-Z\d]+));/g;

/**
 * Decode HTML entities in text
 * Ported from worker/shared/constants.js
 */
function decodeHTMLEntities(str) {
  if (!str || typeof str !== 'string') return str || '';

  return str.replace(HTML_ENTITY_REGEX, (match, dec, hex, named) => {
    if (dec) {
      const codePoint = parseInt(dec, 10);
      if (codePoint > 0x10FFFF) return match;
      return String.fromCodePoint(codePoint);
    }
    if (hex) {
      const codePoint = parseInt(hex, 16);
      if (codePoint > 0x10FFFF) return match;
      return String.fromCodePoint(codePoint);
    }
    if (named) return HTML_ENTITY_MAP[named] || match;
    return match;
  });
}

/**
 * Extract text content from webpage using browser DOM traversal
 * Ports the HTMLRewriter TextExtractor logic from worker-news-processor/index.js
 * 
 * This function runs in the browser context and performs recursive DOM walking
 * to extract visible text while skipping navigation, headers, footers, ads, etc.
 * 
 * @param {number} maxChars - Maximum characters to extract
 * @returns {string|null} Extracted text content
 */
function extractTextFromDOM(maxChars) {
  // Skip tags (elements to completely ignore)
  const SKIP_TAGS = new Set([
    'script', 'style', 'nav', 'header', 'footer', 'aside', 'menu',
    'form', 'svg', 'canvas', 'iframe', 'noscript', 'title',
    'button', 'input', 'select', 'textarea'
  ]);
  
  // Skip pattern regex for class names and IDs
  const SKIP_REGEXP = /(?:^|\s)(nav|menu|menu-item|header|footer|sidebar|aside|advertisement|ad-|promo|banner|widget|share|social|comment|related|recommend)(?:\s|$)/i;
  
  const textChunks = [];
  let charCount = 0;
  
  /**
   * Recursively walk DOM tree and extract text
   * @param {Node} node - DOM node to process
   * @returns {boolean} True if should continue, false if char limit reached
   */
  function walkNode(node) {
    // Stop if we've collected enough
    if (charCount >= maxChars) return false;
    
    // Skip non-element and non-text nodes
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        textChunks.push(text);
        charCount += text.length;
      }
      return charCount < maxChars;
    }
    
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }
    
    const tagName = node.tagName.toLowerCase();
    
    // Skip tags completely
    if (SKIP_TAGS.has(tagName)) {
      return true;
    }
    
    // Check for skip patterns in class/id
    const className = node.className || '';
    const id = node.id || '';
    const combined = `${className} ${id}`;
    
    if (combined.trim() && SKIP_REGEXP.test(combined)) {
      return true; // Skip this element and its children
    }
    
    // Recursively process children
    for (const child of node.childNodes) {
      if (!walkNode(child)) {
        return false; // Stop if char limit reached
      }
    }
    
    return true;
  }
  
  // Start walking from document body
  if (document.body) {
    walkNode(document.body);
  }
  
  // Join chunks and trim to max length
  let text = textChunks.join(' ');
  if (text.length > maxChars) {
    text = text.substring(0, maxChars);
  }
  
  return text || null;
}

/**
 * Scrape article content from URL using headless browser
 * 
 * @param {import('puppeteer-core').Page} page - Puppeteer page instance
 * @param {string} url - Article URL to scrape
 * @param {number} maxContentChars - Maximum characters to extract
 * @returns {Promise<string|null>} Extracted text or null on error
 */
async function scrapeArticleContent(page, url, maxContentChars = MAX_CONTENT_CHARS) {
  try {
    console.log(`  Navigating to: ${url}`);
    
    // Navigate to the page with timeout
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: BROWSER_TIMEOUT
    });
    
    // Wait a bit more for dynamic content
    await page.waitForTimeout(PAGE_IDLE_TIMEOUT);
    
    console.log(`  Extracting text content...`);
    
    // Execute text extraction in browser context
    const text = await page.evaluate(extractTextFromDOM, maxContentChars);
    
    if (text) {
      console.log(`  ✓ Extracted ${text.length} characters`);
      return text;
    }
    
    console.log(`  ✗ No text extracted`);
    return null;
    
  } catch (error) {
    console.error(`  ✗ Error scraping ${url}:`, error.message);
    return null;
  }
}

/**
 * Fetch articles needing processing from Cloudflare D1
 * Uses the Cloudflare D1 Client API (HTTP)
 * 
 * @param {string} accountId - Cloudflare account ID
 * @param {string} databaseId - D1 database ID
 * @param {string} apiToken - Cloudflare API token
 * @param {number} limit - Max articles to fetch
 * @returns {Promise<Array>} Articles needing processing
 */
async function fetchArticlesFromD1(accountId, databaseId, apiToken, limit = BATCH_SIZE) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  
  // Use parameterized query to prevent SQL injection
  const query = `
    SELECT * FROM articles 
    WHERE needsSummary = 1 OR (contentTimeout IS NOT NULL AND contentTimeout < ?)
    ORDER BY pubDate DESC
    LIMIT ?
  `;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sql: query,
      params: [MAX_CONTENT_FETCH_ATTEMPTS, limit]
    })
  });
  
  if (!response.ok) {
    throw new Error(`D1 API fetch failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.success || !data.result || !data.result[0]) {
    throw new Error('D1 API returned invalid response');
  }
  
  const rows = data.result[0].results || [];
  console.log(`Fetched ${rows.length} articles from D1`);
  
  return rows;
}

/**
 * Update article in Cloudflare D1
 * 
 * @param {string} accountId - Cloudflare account ID
 * @param {string} databaseId - D1 database ID
 * @param {string} apiToken - Cloudflare API token
 * @param {string} articleId - Article ID to update
 * @param {Object} updates - Fields to update
 * @returns {Promise<void>}
 */
async function updateArticleInD1(accountId, databaseId, apiToken, articleId, updates) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  
  // Build UPDATE statement
  const setFields = [];
  const params = [];
  
  if (updates.extractedContent !== undefined) {
    setFields.push('extractedContent = ?');
    params.push(updates.extractedContent);
  }
  if (updates.contentTimeout !== undefined) {
    setFields.push('contentTimeout = ?');
    params.push(updates.contentTimeout);
  }
  if (updates.summaryError !== undefined) {
    setFields.push('summaryError = ?');
    params.push(updates.summaryError);
  }
  if (updates.needsSummary !== undefined) {
    setFields.push('needsSummary = ?');
    params.push(updates.needsSummary ? 1 : 0);
  }
  if (updates.processedAt !== undefined) {
    setFields.push('processedAt = ?');
    params.push(updates.processedAt);
  }
  
  if (setFields.length === 0) {
    return; // Nothing to update
  }
  
  const query = `UPDATE articles SET ${setFields.join(', ')} WHERE id = ?`;
  params.push(articleId);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sql: query,
      params: params
    })
  });
  
  if (!response.ok) {
    throw new Error(`D1 API update failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.success) {
    throw new Error(`D1 API update failed: ${data.errors?.[0]?.message || 'Unknown error'}`);
  }
  
  console.log(`  ✓ Updated article ${articleId} in D1`);
}

/**
 * Process a single article with browser scraping
 * 
 * @param {import('puppeteer-core').Browser} browser - Puppeteer browser instance
 * @param {Object} article - Article object from D1
 * @param {Object} config - Configuration object with D1 credentials
 * @returns {Promise<void>}
 */
async function processArticle(browser, article, config) {
  const articleId = article.id || article.article_id;
  const title = article.title || '';
  const link = article.link;
  
  console.log(`Processing article: ${articleId} - "${title.substring(0, 50)}..."`);
  
  if (!link) {
    console.log(`  ✗ No link available`);
    await updateArticleInD1(config.accountId, config.databaseId, config.apiToken, articleId, {
      needsSummary: false,
      summaryError: 'no_link',
      processedAt: Date.now()
    });
    return;
  }
  
  // Skip if already extracted content in previous run
  if (article.extractedContent) {
    console.log(`  ℹ Content already extracted, skipping scrape`);
    return;
  }
  
  // Increment timeout counter BEFORE attempting fetch
  // This ensures the counter is saved even if Lambda times out during scrape
  const timeoutCount = (article.contentTimeout || 0) + 1;
  
  console.log(`  Fetching article content (attempt ${timeoutCount}/${MAX_CONTENT_FETCH_ATTEMPTS})...`);
  
  // Save incremented counter to D1 BEFORE attempting scrape
  // This way if Lambda times out during scrape, the counter is already updated
  await updateArticleInD1(config.accountId, config.databaseId, config.apiToken, articleId, {
    contentTimeout: timeoutCount,
    summaryError: `fetch_attempt (${timeoutCount}/${MAX_CONTENT_FETCH_ATTEMPTS})`,
    processedAt: Date.now()
  });
  
  try {
    // Open a new page (tab) in the browser
    const page = await browser.newPage();
    
    try {
      // Set user agent
      await page.setUserAgent('Mozilla/5.0 (compatible; NewsBot/1.0; +http://crypto-calculator.com)');
      
      // Now attempt the scrape - if this times out, counter is already saved
      const content = await scrapeArticleContent(page, link, MAX_CONTENT_CHARS);
      
      if (content) {
        // Save extracted content for AI processing later
        // Note: Text is extracted directly from DOM (already decoded by browser)
        // contentTimeout was already saved before the operation, no need to update again
        await updateArticleInD1(config.accountId, config.databaseId, config.apiToken, articleId, {
          extractedContent: content,
          summaryError: `scraping_complete (attempt ${timeoutCount}/${MAX_CONTENT_FETCH_ATTEMPTS})`,
          processedAt: Date.now()
        });
        
        console.log(`  ✓ Content extracted and saved (${content.length} chars)`);
      } else {
        // Failed to extract content
        const shouldGiveUp = timeoutCount >= MAX_CONTENT_FETCH_ATTEMPTS;
        
        // contentTimeout was already saved before the operation, no need to update again
        await updateArticleInD1(config.accountId, config.databaseId, config.apiToken, articleId, {
          summaryError: `fetch_failed (attempt ${timeoutCount}/${MAX_CONTENT_FETCH_ATTEMPTS})`,
          needsSummary: shouldGiveUp ? false : undefined,
          processedAt: Date.now()
        });
        
        if (shouldGiveUp) {
          console.log(`  ✗ Max retries (${timeoutCount}) reached, giving up`);
        } else {
          console.log(`  ✗ Failed to fetch content (attempt ${timeoutCount}/${MAX_CONTENT_FETCH_ATTEMPTS})`);
        }
      }
      
    } finally {
      // Always close the page
      await page.close();
    }
    
  } catch (error) {
    console.error(`  ✗ Error processing article:`, error.message);
    
    const shouldGiveUp = timeoutCount >= MAX_CONTENT_FETCH_ATTEMPTS;
    
    // contentTimeout was already saved before the operation, no need to update again
    await updateArticleInD1(config.accountId, config.databaseId, config.apiToken, articleId, {
      summaryError: `fetch_error: ${error.message.substring(0, 100)} (attempt ${timeoutCount}/${MAX_CONTENT_FETCH_ATTEMPTS})`,
      needsSummary: shouldGiveUp ? false : undefined,
      processedAt: Date.now()
    });
  }
}

/**
 * Main Lambda handler
 * Triggered by EventBridge (CloudWatch Events) every 2 minutes
 * 
 * @param {Object} event - EventBridge event
 * @param {Object} context - Lambda context
 * @returns {Promise<Object>} Execution result
 */
export async function handler(event, context) {
  console.log('=== Bitcoin News Scraper Lambda Started ===');
  console.log(`Execution time: ${new Date().toISOString()}`);
  console.log(`Request ID: ${context.requestId}`);
  
  // Get configuration from environment variables
  const config = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN
  };
  
  // Validate environment variables
  if (!config.accountId || !config.databaseId || !config.apiToken) {
    throw new Error('Missing required environment variables: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN');
  }
  
  let browser = null;
  
  try {
    // Fetch articles needing processing
    console.log(`Fetching up to ${BATCH_SIZE} articles from Cloudflare D1...`);
    const articles = await fetchArticlesFromD1(config.accountId, config.databaseId, config.apiToken, BATCH_SIZE);
    
    if (articles.length === 0) {
      console.log('No articles need processing - idle run');
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          processed: 0,
          message: 'No articles to process'
        })
      };
    }
    
    console.log(`Found ${articles.length} article(s) to process`);
    
    // Launch browser once for all articles (batch processing)
    console.log('Launching headless Chromium...');
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });
    
    console.log('✓ Browser launched successfully');
    
    // Process articles in parallel using Promise.allSettled
    // This ensures one failure doesn't crash the entire batch
    console.log(`Processing ${articles.length} articles in parallel...`);
    const processPromises = articles.map(article => 
      processArticle(browser, article, config)
    );
    
    const results = await Promise.allSettled(processPromises);
    
    // Count successes and failures
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    console.log(`✓ Processed ${succeeded} article(s) successfully`);
    if (failed > 0) {
      console.log(`✗ Failed to process ${failed} article(s)`);
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`  Article ${articles[index].id}: ${result.reason}`);
        }
      });
    }
    
    console.log('=== Bitcoin News Scraper Lambda Completed Successfully ===');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        processed: succeeded,
        failed: failed,
        total: articles.length
      })
    };
    
  } catch (error) {
    console.error('=== Bitcoin News Scraper Lambda Failed ===');
    console.error('Error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
    
  } finally {
    // Always close browser to free resources
    if (browser) {
      console.log('Closing browser...');
      await browser.close();
      console.log('✓ Browser closed');
    }
  }
}
