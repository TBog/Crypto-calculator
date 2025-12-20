import { defineConfig } from 'vitest/config';

// Main test configuration using Node environment
// This avoids issues with AI bindings that can't be mocked in test environment
// Tests focus on structural validation and logic, not runtime bindings
export default defineConfig({
  test: {
    include: ['**/*.test.js'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test-setup.js']
  },
  css: {
    postcss: false // Disable PostCSS processing for tests
  }
});
