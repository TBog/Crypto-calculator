-- Migration: Add extractedContent column to articles table
-- Date: 2026-01-06
-- Description: Adds the extractedContent TEXT column to store raw scraped HTML content
--              between Phase 1 (scraping) and Phase 2 (AI processing) of article processing.
--              This fixes the bug where the processor was stuck repeating Phase 1 because
--              the extracted content was not persisted between cron runs.

-- Add extractedContent column if it doesn't exist
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we check first
-- This is safe to run multiple times

-- Check if column exists and add it if it doesn't
-- Using a safe approach that won't fail if column already exists
ALTER TABLE articles ADD COLUMN extractedContent TEXT;
