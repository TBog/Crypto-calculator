# Processor Frequency Optimization with D1

## Current Deployed Configuration
- **Frequency**: Every 3 minutes (480 runs/day) ✅ DEPLOYED
- **Articles per run**: 1 (MAX_ARTICLES_PER_RUN)
- **D1 writes per run**: ~1 (UPDATE per processing phase)
- **KV writes per run**: ~0.33 (only when article fully processed)

## Current Daily Usage (Assuming 25 articles/hour)
- **D1 writes**: 480 UPDATE operations = ~480 writes/day (0.5% of limit)
- **KV writes**: ~160 writes/day (completed articles only)
- **Total KV**: ~880/day including updater (88% of limit)

## Why Every 3 Minutes?

### Free Tier CPU Constraint
- **CPU Time Limit**: 10ms per worker invocation on free tier
- **HTML Rewriter**: CPU-intensive content extraction
- **Solution**: Process 1 article per run to stay under 10ms limit

### Frequency Trade-off
- **Smaller batches** (1 article) require **more frequent runs** to maintain throughput
- **Every 3 minutes** = 480 runs/day = 480 articles/day capacity
- **Average latency**: 3 minutes (vs 10 min before migration)

## Alternative Options Considered

### Option 1: Every 5 Minutes (288 runs/day) - SLOWER
- **D1 writes**: ~288 writes/day (0.3% of limit)
- **KV writes**: ~96 completed/day
- **Benefit**: Lower resource usage
- **Drawback**: Slower processing (5 min avg vs 3 min)
- **Capacity**: 288 articles/day (may not handle peak loads)

### Option 2: Every 2 Minutes (720 runs/day) - RISKY
- **D1 writes**: ~720 writes/day (0.7% of limit)
- **KV writes**: ~240 completed/day
- **Benefit**: Even faster processing (2 min avg)
- **Risk**: Higher KV usage (1,080/day total with updater - over limit!)

### Option 3: Every 3 Minutes (480 runs/day) - ✅ DEPLOYED
- **D1 writes**: ~480 writes/day (0.5% of limit)
- **KV writes**: ~160 completed/day
- **Total KV**: ~880/day with updater (88% of limit)
- **Benefit**: Good balance of speed and resource usage
- **Safety**: Stays within free tier with small buffer

## Deployed Configuration: Every 3 Minutes

**Rationale:**
1. **Within Limits**: Total KV usage (880/day) stays under 1,000/day limit
2. **Fast Processing**: 3.3x faster than original 10-minute frequency
3. **CPU Safe**: Batch size of 1 prevents timeout on free tier's 10ms limit
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
