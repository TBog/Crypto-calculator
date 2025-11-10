import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityDate: '2024-10-01',
          compatibilityFlags: ['nodejs_compat'],
          bindings: {
            // Mock AI binding for tests
            AI: {
              run: async (model, options) => {
                // Mock AI response for testing
                return {
                  response: 'Test AI summary response for Bitcoin price analysis.'
                };
              }
            }
          }
        }
      }
    }
  }
});
