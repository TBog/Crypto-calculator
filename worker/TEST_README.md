# Worker Tests

This directory contains comprehensive tests for the Cloudflare Worker that handles AI-powered Bitcoin price summaries.

## Test Coverage

### Core Functionality
- **AI Summary Generation**: Tests for the `/ai/summary` endpoint with all period options (24h, 7d, 30d, 90d)
- **Price Data Conversion**: Validates the text conversion logic for LLM input
- **Sampling Logic**: Verifies correct sampling intervals for different data sizes
- **Token Limits**: Ensures `max_tokens` is set correctly to prevent truncation

### Bug Fix Verification
- **30-day Summary Truncation**: Tests specifically verify the fix for the reported issue
- **90-day Summary Truncation**: Tests for the extended period mentioned in requirements
- **Max Tokens Configuration**: Validates that `max_tokens: 1024` is used (vs default 256)

### Integration Tests
- **Request/Response Flow**: End-to-end tests for summary requests
- **Cache Configuration**: Validates cache TTL settings
- **Origin Validation**: Security tests for CORS and origin checking
- **Response Headers**: Validates required metadata headers

## Running Tests

### Prerequisites
```bash
npm install
```

### Run All Tests
```bash
npm test
```

### Watch Mode (for development)
```bash
npm run test:watch
```

### Coverage Report
```bash
npm run test:coverage
```

## Test Framework

We use **Vitest** with **@cloudflare/vitest-pool-workers** for testing Cloudflare Workers:

- **Vitest**: Fast, modern test runner with Jest-compatible API
- **@cloudflare/vitest-pool-workers**: Enables testing Workers in a simulated environment
- **Miniflare**: Provides local Worker simulation for testing

## Mock Data

The test suite includes mock price data generators that simulate:
- 24-hour data (~24 points)
- 7-day data (~168 points)
- 30-day data (~720 points)
- 90-day data (~2160 points)

## Configuration

### vitest.config.js
Configures the test environment with:
- Miniflare compatibility settings
- Mock AI binding for testing without actual API calls
- Wrangler configuration integration

### package.json
Defines test scripts and dependencies

## Writing New Tests

When adding new tests:

1. **Use descriptive test names** that explain what is being tested
2. **Group related tests** using `describe()` blocks
3. **Test edge cases** including empty data, single points, and large datasets
4. **Verify the fix** for any bugs by adding specific regression tests
5. **Mock external dependencies** (AI API, CoinGecko API) to keep tests fast and reliable

## CI/CD Integration

These tests can be integrated into GitHub Actions or other CI/CD pipelines:

```yaml
- name: Run Worker Tests
  run: |
    cd worker
    npm install
    npm test
```

## Troubleshooting

### Tests Failing Locally
- Ensure Node.js version >= 18.x
- Run `npm install` to install all dependencies
- Check that wrangler.toml is properly configured

### Mock AI Not Working
- Verify the mock AI binding in vitest.config.js
- Ensure the mock returns the expected response structure

## Related Documentation

- [Cloudflare Workers Testing Guide](https://developers.cloudflare.com/workers/testing/)
- [Vitest Documentation](https://vitest.dev/)
- [Miniflare Documentation](https://miniflare.dev/)
