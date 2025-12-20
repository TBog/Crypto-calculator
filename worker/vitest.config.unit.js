import { defineConfig } from 'vitest/config';

// Unit test configuration for news-processor-cron tests and provider tests
// Mocks Cloudflare Workers globals to allow importing the module
export default defineConfig({
  test: {
    include: ['worker-news-processor/index.test.js', 'shared/news-providers.test.js'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test-setup.js']
  }
});
