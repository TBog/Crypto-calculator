/**
 * Test setup file for mocking Cloudflare Workers globals
 * This allows importing news-processor-cron.js without the full Workers runtime
 */

// Mock HTMLRewriter class (minimal implementation for imports)
global.HTMLRewriter = class HTMLRewriter {
  on() { return this; }
  transform() { 
    // Return a Response-like object with a readable stream body
    return {
      body: {
        getReader: () => ({
          read: async () => ({ done: true }),
          releaseLock: () => {},
          cancel: async () => {}
        })
      }
    };
  }
};

// Mock fetch if not available
if (typeof global.fetch === 'undefined') {
  global.fetch = async () => {
    throw new Error('fetch is not implemented in test environment');
  };
}

// Mock AbortSignal if not available
if (typeof global.AbortSignal === 'undefined') {
  global.AbortSignal = {
    timeout: () => ({})
  };
}
