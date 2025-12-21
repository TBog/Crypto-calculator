# KV Storage Migration Guide

## Overview

This guide explains the migration from the legacy monolithic KV storage to the new individual article storage architecture.

## Storage Architecture Changes

### Before (Legacy)
- **BTC_ANALYZED_NEWS**: Single large JSON object containing all articles plus metadata
  ```json
  {
    "articles": [...],
    "totalArticles": 100,
    "lastUpdatedExternal": 1234567890,
    "sentimentCounts": { "positive": 30, "negative": 20, "neutral": 50 }
  }
  ```
- **BTC_ID_INDEX**: Array of article IDs for deduplication

### After (New)
- **article:\<id\>**: Individual KV entries for each article (e.g., `article:abc123`)
- **BTC_ID_INDEX**: Array of article IDs (latest first) - same as before
- **No metadata storage**: Sentiment counts calculated on-the-fly when needed

## Benefits

1. **Scalability**: No single large object that grows unbounded
2. **Efficiency**: Update individual articles without rewriting entire dataset
3. **Flexibility**: Easy to fetch specific articles by ID
4. **Performance**: Parallel reads/writes of individual articles
5. **Storage**: Better use of KV storage limits

## Migration Strategy

### Automatic Migration

The system includes automatic migration logic in `worker-news-updater`:

1. When `BTC_ID_INDEX` is not found, check for legacy `BTC_ANALYZED_NEWS`
2. If found, migrate all articles to individual storage (`article:<id>`)
3. Create new `BTC_ID_INDEX` from migrated articles
4. Delete legacy `BTC_ANALYZED_NEWS` key after successful migration

### Manual Migration (if needed)

If automatic migration fails or you need to trigger it manually:

1. Deploy the updated workers
2. Trigger the `worker-news-updater` scheduled job (it runs hourly)
3. Monitor logs for migration confirmation messages
4. Verify new storage format via the API endpoint

## Compatibility & Deprecation

### Backward Compatibility

The `worker-api` includes fallback logic for the transition period:

```javascript
// Checks for new format first
const idIndexData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_IDS);

// Falls back to legacy format if new format not found
if (!idIndexData) {
  const legacyData = await env.CRYPTO_NEWS_CACHE.get(config.KV_KEY_NEWS);
  // Returns legacy data if available
}
```

### Timeline

- **Phase 1** (Current): Both formats supported, automatic migration on next update cycle
- **Phase 2** (After migration): Legacy format deprecated but still readable
- **Phase 3** (Future): Legacy format support can be removed

## Testing

All existing tests have been updated to work with the new storage format:

```bash
cd worker
npm test
```

Expected result: All 132 tests passing

## Monitoring

### Check Migration Status

Call the updater worker endpoint to see current storage state:

```bash
curl https://your-worker.workers.dev/
```

Response will show:
- `totalArticles`: Number of articles in storage
- `articleIds`: Array of article IDs
- `latestArticles`: Preview of latest articles

### Verify Individual Article Storage

Check if articles are stored individually:

```bash
# Via Cloudflare CLI (wrangler)
wrangler kv:key list --namespace-id=<YOUR_NAMESPACE_ID> | grep "article:"
```

## Rollback Plan

If issues arise, rollback is simple:

1. Revert to previous worker versions
2. Legacy `BTC_ANALYZED_NEWS` data will still exist unless manually deleted
3. System will continue working with old format

## Configuration Changes

New configuration constants added:
- `KV_KEY_IDS` exported in API worker config
- `ID_INDEX_TTL` exported in processor worker config

These ensure proper TTL handling for individual articles.

## Implementation Details

### Worker-News-Updater

- Stores each new article individually with `article:<id>` key
- Updates `BTC_ID_INDEX` with merged list (latest first)
- Migrates legacy data automatically if found
- No longer creates `BTC_ANALYZED_NEWS` object

### Worker-News-Processor

- Reads individual articles by ID
- Updates individual articles in place
- Batch writes for efficiency

### Worker-API

- Reads `BTC_ID_INDEX` to get article IDs
- Fetches individual articles in parallel
- Calculates sentiment distribution on-the-fly
- Maintains backward-compatible response format

## Frequently Asked Questions

### Q: Will existing articles be lost?
A: No, automatic migration preserves all existing articles.

### Q: How long does migration take?
A: Migration happens during the next scheduled update cycle (typically within 1 hour).

### Q: Can I force immediate migration?
A: Yes, trigger the `worker-news-updater` manually via Cloudflare dashboard or `wrangler`.

### Q: What happens to metadata?
A: Metadata is no longer stored. Sentiment counts are calculated on-demand from individual articles.

### Q: How do I verify migration succeeded?
A: Check worker logs for "Migrated X articles from legacy format" message.

## Support

For issues or questions:
1. Check worker logs in Cloudflare dashboard
2. Review test output: `npm test`
3. Open an issue in the repository
