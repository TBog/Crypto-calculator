#!/bin/bash

# Script to run D1 database migrations
# Usage: ./run-migrations.sh [development|production]

set -e

ENVIRONMENT=${1:-development}

cd "$(dirname "$0")/worker-news-processor"

echo "Running migrations for: $ENVIRONMENT"
echo "========================================"

if [ "$ENVIRONMENT" = "production" ]; then
  ENV_FLAG="--env production"
else
  ENV_FLAG=""
fi

# Run each migration file in order
for migration in ../migrations/*.sql; do
  if [ -f "$migration" ]; then
    echo ""
    echo "Running migration: $(basename $migration)"
    echo "----------------------------------------"
    
    # Run migration, continue on error (in case it's already applied)
    if wrangler d1 execute crypto-news-db --file="$migration" $ENV_FLAG --yes; then
      echo "✅ Migration applied successfully"
    else
      echo "⚠️  Migration may have already been applied or failed"
      echo "   Check the error above to determine if this is expected"
    fi
  fi
done

echo ""
echo "========================================"
echo "✅ Migration process completed"
echo ""
echo "Verifying schema..."
wrangler d1 execute crypto-news-db \
  --command "PRAGMA table_info(articles);" \
  $ENV_FLAG \
  --json
