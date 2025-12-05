import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Simplified test configuration that uses wrangler.toml for bindings
// Note: AI binding is configured in wrangler.toml but cannot be fully mocked
// in the test environment. Tests focus on structural validation and logic.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' }
      }
    }
  },
  css: {
    postcss: false // Disable PostCSS processing for tests
  }
});
