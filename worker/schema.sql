-- D1 Database Schema for Bitcoin News Articles
-- This schema supports the article storage and processing workflow

-- Articles table: Stores all article data with processing status
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,                    -- Article ID (from news provider)
    title TEXT NOT NULL,                    -- Article title
    description TEXT,                       -- Article description/excerpt
    link TEXT,                              -- Article URL
    pubDate TEXT NOT NULL,                  -- Publication date (ISO 8601 format)
    source TEXT,                            -- News source name
    imageUrl TEXT,                          -- Article image URL
    
    -- Processing flags
    needsSentiment BOOLEAN DEFAULT 1,       -- True if sentiment analysis needed
    needsSummary BOOLEAN DEFAULT 1,         -- True if AI summary needed
    
    -- AI-generated content
    sentiment TEXT,                         -- Sentiment: positive, negative, neutral
    aiSummary TEXT,                         -- AI-generated summary
    
    -- Processing metadata
    contentTimeout INTEGER DEFAULT 0,       -- Content fetch retry count
    summaryError TEXT,                      -- Summary generation error (if any)
    queuedAt INTEGER,                       -- Timestamp when queued (milliseconds)
    processedAt INTEGER,                    -- Timestamp when fully processed (milliseconds)
    
    -- Timestamps
    createdAt INTEGER NOT NULL,             -- Record creation timestamp (milliseconds)
    updatedAt INTEGER NOT NULL              -- Record update timestamp (milliseconds)
);

-- Index on pubDate for efficient sorting (newest first)
CREATE INDEX IF NOT EXISTS idx_articles_pubDate ON articles(pubDate DESC);

-- Index on processing flags for finding pending articles
CREATE INDEX IF NOT EXISTS idx_articles_needsSentiment ON articles(needsSentiment) WHERE needsSentiment = 1;
CREATE INDEX IF NOT EXISTS idx_articles_needsSummary ON articles(needsSummary) WHERE needsSummary = 1;

-- Index on processedAt for finding fully processed articles
CREATE INDEX IF NOT EXISTS idx_articles_processedAt ON articles(processedAt) WHERE processedAt IS NOT NULL;

-- Index on sentiment for filtering
CREATE INDEX IF NOT EXISTS idx_articles_sentiment ON articles(sentiment);

-- Composite index for efficiently finding articles needing processing (newest first)
CREATE INDEX IF NOT EXISTS idx_articles_pending ON articles(pubDate DESC) 
    WHERE needsSentiment = 1 OR needsSummary = 1;

-- Processing checkpoint table: Stores the last processed article to enable resumable processing
CREATE TABLE IF NOT EXISTS processing_checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- Single row table (id always = 1)
    currentArticleId TEXT,                  -- Currently processing article ID
    lastProcessedAt INTEGER,                -- Last processing timestamp (milliseconds)
    articlesProcessedCount INTEGER DEFAULT 0 -- Total articles processed
);

-- Initialize checkpoint table with a single row
INSERT OR IGNORE INTO processing_checkpoint (id, lastProcessedAt, articlesProcessedCount)
VALUES (1, 0, 0);
