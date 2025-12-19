import { defineConfig } from 'vitest/config';

// Unit test configuration for news-processor-cron tests
// These tests run in standard Node.js environment without Cloudflare Workers runtime
export default defineConfig({
  test: {
    include: ['news-processor-cron.test.js'],
    environment: 'node',
    globals: false
  }
});
