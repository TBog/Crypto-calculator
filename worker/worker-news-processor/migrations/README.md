# D1 Database Migrations

This directory contains D1 database migration files for the crypto-news-processor worker.

## Migration System

Wrangler's D1 migration system tracks which migrations have been applied to your database using an internal migrations table. This allows for incremental schema updates without manual tracking.

## Directory Structure

```
migrations/
├── 0001_initial_schema.sql    # Initial database schema
└── ...                         # Future migration files
```

## Migration Naming Convention

Migration files should follow this pattern:
- `NNNN_description.sql` (e.g., `0001_initial_schema.sql`, `0002_add_index.sql`)
- NNNN is a zero-padded sequential number
- description is a brief snake_case description

## Creating New Migrations

To create a new migration:

```bash
cd worker/worker-news-processor
wrangler d1 migrations create crypto-news-db "description_of_change"
```

This will create a new migration file in the `migrations/` directory.

## Applying Migrations

### Development Environment
```bash
cd worker/worker-news-processor
wrangler d1 migrations apply crypto-news-db
```

### Production Environment
```bash
cd worker/worker-news-processor
wrangler d1 migrations apply crypto-news-db --env production
```

### CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/deploy-d1-schema.yml`) automatically applies migrations when:
- A push is made to the `main` branch
- The workflow is manually triggered via `workflow_dispatch`

## Migration Best Practices

1. **Use IF NOT EXISTS**: Always use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` to ensure migrations are idempotent
2. **Test Locally First**: Test migrations locally before committing
3. **Incremental Changes**: Keep migrations small and focused on a single change
4. **No Rollbacks**: D1 migrations are forward-only; plan accordingly
5. **Data Migrations**: Be careful with data migrations; test thoroughly

## Transitioning from schema.sql to Migrations

The project is transitioning from using `schema.sql` with `d1 execute` to using the migration system:

1. **Current State**: The `schema.sql` file in the parent directory is currently used for initial database setup
2. **Initial Migration**: `0001_initial_schema.sql` mirrors the current schema for tracking purposes
3. **Future Changes**: All future schema changes should be made as new migration files
4. **CI/CD**: The workflow has been updated to support both methods during the transition

## Verifying Migrations

To check which migrations have been applied:

```bash
cd worker/worker-news-processor
wrangler d1 execute crypto-news-db --command "SELECT * FROM d1_migrations"
```

## Resources

- [Wrangler D1 Migrations Documentation](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Setup Guide](../D1_SETUP_GUIDE.md)
