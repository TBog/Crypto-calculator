# Processor Frequency Optimization with D1

## Current Configuration
- **Frequency**: Every 10 minutes (144 runs/day)
- **Articles per run**: 1 (configurable via MAX_ARTICLES_PER_RUN)
- **D1 writes per run**: ~1-5 (depending on articles processed)
- **KV writes per run**: 1 (cache update after batch)

## Current Daily Usage
- **D1 writes**: 144 runs × ~3 articles avg = ~432 writes/day
- **KV writes**: 144 cache updates = 144 writes/day
- **Total**: Well within free tier limits

## D1 Free Tier Limits
- **Reads**: 5 million rows/day
- **Writes**: 100,000 rows/day
- **Storage**: 500 MB

## KV Free Tier Limits
- **Reads**: 100,000 operations/day
- **Writes**: 1,000 operations/day
- **Storage**: 1 GB

## Optimization Opportunity

With D1, we're only using ~0.4% of our daily write limit. We can significantly increase processor frequency to reduce article processing latency.

### Option 1: Every 5 Minutes (288 runs/day) - **RECOMMENDED**
- **D1 writes**: 288 × 3 = ~864 writes/day (0.9% of limit)
- **KV writes**: 288 cache updates = 288 writes/day (28.8% of limit)
- **Benefit**: Halves article processing time (from 10 min to 5 min avg)
- **Safety**: Very safe, plenty of headroom

### Option 2: Every 2 Minutes (720 runs/day) - AGGRESSIVE
- **D1 writes**: 720 × 3 = ~2,160 writes/day (2.2% of limit)
- **KV writes**: 720 cache updates = 720 writes/day (72% of limit)
- **Benefit**: Much faster processing (2 min avg)
- **Risk**: Higher KV usage, less room for spikes

### Option 3: Every 3 Minutes (480 runs/day) - BALANCED
- **D1 writes**: 480 × 3 = ~1,440 writes/day (1.4% of limit)
- **KV writes**: 480 cache updates = 480 writes/day (48% of limit)
- **Benefit**: Faster than current (3 min avg vs 10 min)
- **Safety**: Good balance between speed and safety

## Recommendation: Every 5 Minutes

**Rationale:**
1. **Safe**: Uses only 28.8% of KV write limit (plenty of headroom for spikes)
2. **Fast**: Halves average processing time from 10 to 5 minutes
3. **Scalable**: Can still increase MAX_ARTICLES_PER_RUN from 1 to 3-5 without hitting limits
4. **Buffer**: Leaves room for API cache misses and manual cache refreshes

## Implementation

Update `worker-news-processor/wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]  # Changed from "*/10 * * * *"
```

## Optional: Increase Batch Size

If processing latency is still too high, consider also increasing MAX_ARTICLES_PER_RUN:

```toml
[vars]
MAX_ARTICLES_PER_RUN = 3  # Changed from 1
```

This would process articles even faster while still staying well within limits:
- D1 writes: 288 × 5 = ~1,440 writes/day (1.4% of limit)
- KV writes: 288 = 288 writes/day (28.8% of limit)

## Monitoring

After deploying the change, monitor:
1. **Cloudflare Dashboard**: Check D1 and KV usage metrics
2. **Worker Logs**: Verify processing times and article throughput
3. **Article Processing Lag**: Check how long it takes from article creation to full processing

If KV writes approach 800/day (80% of limit), consider reducing frequency or optimizing cache strategy.

## Rollback Plan

If issues arise:
1. Revert cron trigger to `*/10 * * * *` in wrangler.toml
2. Deploy: `wrangler deploy --config worker-news-processor/wrangler.toml`
3. Monitor for 24 hours to confirm stability

## Future Optimization

When article volume increases:
- Consider conditional cache updates (only when significant changes)
- Implement smart cache invalidation
- Add cache-control headers for longer KV TTL
- Use R2 for large blobs if storage becomes an issue
