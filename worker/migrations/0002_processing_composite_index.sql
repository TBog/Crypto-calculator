-- Migration: Add composite index for getArticlesNeedingProcessing optimization
-- Created: 2026-08-25
-- Description: Replaces the broad pending index with a composite (contentTimeout, pubDate DESC)
--   partial index so the getArticlesNeedingProcessing UNION ALL query can satisfy
--   the full ORDER BY (contentTimeout=0 first, then newest pubDate) using index-only scans,
--   avoiding a full table scan that was reading hundreds of millions of rows per day.

-- Drop the old partial index that only covered pubDate and did not help with the
-- CASE WHEN contentTimeout > 0 ordering used by the processor query.
DROP INDEX IF EXISTS idx_articles_pending;

-- New composite index: articles that still need processing, ordered so that
-- non-timed-out rows (contentTimeout = 0) sort before timed-out rows, and within
-- each group newest pubDate comes first.  The UNION ALL rewrite in d1-utils.js
-- issues one query per flag value (needsSentiment, needsSummary) so D1 can use
-- this index for both branches without a merge-sort over the whole table.
CREATE INDEX IF NOT EXISTS idx_articles_processing
    ON articles (
        needsSentiment,
        CASE WHEN contentTimeout > 0 THEN 1 ELSE 0 END,
        pubDate DESC
    )
    WHERE needsSentiment = 1 OR needsSummary = 1;
