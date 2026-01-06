# D1 Database Migrations

This directory contains SQL migration files for the D1 database schema changes.

## Migration Files

Migrations are numbered sequentially and should be run in order:

- `0001_add_extractedContent_column.sql` - Adds the `extractedContent` column to the `articles` table

## Running Migrations

### Development Environment

To run migrations manually in development:

```bash
cd worker/worker-news-processor
wrangler d1 execute crypto-news-db --file=../migrations/0001_add_extractedContent_column.sql --yes
```

### Production Environment

To run migrations in production:

```bash
cd worker/worker-news-processor
wrangler d1 execute crypto-news-db --file=../migrations/0001_add_extractedContent_column.sql --env production --yes
```

### Automated Deployment

Migrations are automatically run when:
1. The migration file is modified
2. The deploy-d1-schema workflow is triggered manually via workflow_dispatch

## Creating New Migrations

When adding new migrations:

1. Create a new file with sequential numbering: `XXXX_description.sql`
2. Add descriptive comments explaining the migration
3. Use idempotent operations where possible (e.g., checking for existence before creating)
4. Test the migration locally first
5. Update this README with the new migration

## Notes

- SQLite (used by D1) doesn't support `IF NOT EXISTS` for `ALTER TABLE ADD COLUMN`
- If a migration fails because the column already exists, it's safe - the schema is already up to date
- Always test migrations in development before running in production
- Migrations should be additive and backwards compatible when possible
