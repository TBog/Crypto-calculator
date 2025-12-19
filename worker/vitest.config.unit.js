import { defineConfig } from 'vitest/config';

// Unit test configuration for news-processor-cron tests
// Mocks Cloudflare Workers globals to allow importing the module
export default defineConfig({
  test: {
    include: ['news-processor-cron.test.js'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test-setup.js']
  }
});
