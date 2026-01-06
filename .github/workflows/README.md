# GitHub Actions Workflows

This directory contains GitHub Actions workflows for automated deployment.

## Workflows

### 1. Deploy Main to GitHub Pages (`deploy-main.yml`)
Deploys the main static site to GitHub Pages root.
- **Trigger**: Push to `main` branch or manual dispatch
- **Target**: https://tbog.github.io/Crypto-calculator/
- **What it does**: Builds Tailwind CSS and deploys static files to gh-pages branch

### 2. Deploy PR Preview (`pr-preview.yml`)
Creates preview environments for pull requests.
- **Trigger**: PR opened/updated/closed
- **Target**: https://tbog.github.io/Crypto-calculator/pr-preview/pr-{number}/
- **What it does**: Builds and deploys PR-specific previews

### 3. Deploy Cloudflare Workers - Development (`deploy-workers.yml`)
Deploys Cloudflare Workers to the development environment.
- **Trigger**: Push to `main` branch (when `worker/**` changes) or manual dispatch
- **Environment**: Development (default)
- **Workers deployed**:
  - `worker-api`: Main API worker (crypto-cache)
  - `worker-news-updater`: News updater cron job (runs hourly)
  - `worker-news-processor`: News processor cron job (runs every 3 minutes)

### 4. Deploy Cloudflare Workers - Production (`deploy-workers-production.yml`)
Deploys Cloudflare Workers to the production environment.
- **Trigger**: Push to `production` branch (when `worker/**` changes) or manual dispatch
- **Environment**: Production (uses `--env production` flag)
- **Workers deployed**:
  - `worker-api`: Main API worker (crypto-cache) - production environment
  - `worker-news-updater`: News updater cron job - production environment
  - `worker-news-processor`: News processor cron job - production environment

### 5. Deploy D1 Database Schema - Development (`deploy-d1-schema.yml`)
Deploys the Cloudflare D1 database schema to development.
- **Trigger**: Push to `main` branch (when `worker/schema.sql` changes) or manual dispatch
- **Environment**: Development (default)
- **What it does**:
  - Deploys schema from `worker/schema.sql` to development D1 database
  - Runs migrations from `worker/migrations/*.sql`
  - Initializes the `processing_checkpoint` table
  - Verifies the deployment by querying the database
- **Manual options**: 
  - `development` - Deploy to development database (default)
  - `production` - Deploy to production database

### 6. Deploy D1 Database Schema - Production (`deploy-d1-schema-production.yml`)
Deploys the Cloudflare D1 database schema to production.
- **Trigger**: Push to `production` branch (when `worker/schema.sql` changes) or manual dispatch
- **Environment**: Production (uses `--env production` flag)
- **What it does**:
  - Deploys schema from `worker/schema.sql` to production D1 database
  - Runs migrations from `worker/migrations/*.sql`
  - Verifies the deployment by querying the database

## Cloudflare Workers Deployment

### Deployment Environments

The repository supports two separate deployment environments:

**Development Environment:**
- **Branch**: `main`
- **Workflows**: `deploy-workers.yml`, `deploy-d1-schema.yml`
- **Trigger**: Automatic on push to `main` branch
- **Usage**: Uses default configuration from wrangler.toml files
- **Purpose**: Development and testing environment

**Production Environment:**
- **Branch**: `production`
- **Workflows**: `deploy-workers-production.yml`, `deploy-d1-schema-production.yml`
- **Trigger**: Automatic on push to `production` branch
- **Usage**: Uses `[env.production]` configuration from wrangler.toml files with `--env production` flag
- **Purpose**: Live production environment

### Prerequisites

Before the `deploy-workers.yml` workflow can run, you need to configure the following secrets in your GitHub repository:

1. **CLOUDFLARE_API_TOKEN**
   - Go to Cloudflare Dashboard → My Profile → API Tokens
   - Create a token with:
     - "Edit Cloudflare Workers" permissions (for `deploy-workers.yml`)
     - "Edit D1 Databases" permissions (required for D1 schema deployment and `wrangler d1 execute`, e.g. `deploy-d1-schema.yml`)
   - Add this as a repository secret

2. **CLOUDFLARE_ACCOUNT_ID**
   - Found in your Cloudflare Dashboard URL or in the Workers overview
   - Add this as a repository secret

### D1 Database Setup

The D1 database must be created before deploying workers. Follow these steps:

1. **Create the D1 database** (one-time setup):
   ```bash
   # Development database
   wrangler d1 create crypto-news-db
   
   # Production database (optional, use a separate name)
   wrangler d1 create crypto-news-db-prod
   ```

2. **Update database IDs** in the following files:
   - `worker/worker-news-updater/wrangler.toml`
   - `worker/worker-news-processor/wrangler.toml`

3. **Deploy the schema** using one of these methods:
   
   **Option A: Automatic (Recommended)**
   - Push changes to `main` branch - the schema will deploy automatically
   
   **Option B: Manual via GitHub Actions**
   - Go to Actions → "Deploy D1 Database Schema"
   - Click "Run workflow"
   - Select environment (development/production/both)
   - Click "Run workflow"
   
   **Option C: Local via Wrangler**
   ```bash
   cd worker
   wrangler d1 execute crypto-news-db --file=schema.sql
   ```

4. **Verify the deployment**:
   ```bash
   wrangler d1 execute crypto-news-db --command "SELECT name FROM sqlite_master WHERE type='table'"
   ```

See `worker/D1_SETUP_GUIDE.md` for detailed instructions.

### How It Works

The workflow uses a matrix strategy to deploy all three workers in parallel:

```yaml
strategy:
  matrix:
    worker: [worker-api, worker-news-updater, worker-news-processor]
```

For each worker:
1. Checks out the code
2. Runs `wrangler deploy --config {worker}/wrangler.toml` from the `worker/` directory
3. This allows all workers to access the `shared/` folder with common code

### Shared Code

All workers import from `../shared/news-providers.js` which contains:
- News provider interface (NewsData.io and APITube)
- Provider factory and configuration
- Article normalization logic

The deployment process ensures the shared folder is available to all workers.

### Manual Deployment

You can manually trigger deployments for either environment:

**Development Deployment:**
1. Go to Actions tab in GitHub
2. Select "Deploy Cloudflare Workers (Development)"
3. Click "Run workflow"
4. Select the `main` branch

**Production Deployment:**
1. Go to Actions tab in GitHub
2. Select "Deploy Cloudflare Workers (Production)"
3. Click "Run workflow"
4. Select the `production` branch

### Deploying to Production

To deploy changes to production:

```bash
# First, ensure changes are tested and merged to main
git checkout main
git pull origin main

# Switch to production branch and merge from main
git checkout production
git merge main

# Push to trigger production deployment
git push origin production
```

Alternatively, if you don't have a local production branch:
```bash
# From main branch
git checkout main
git pull origin main
git push origin main:production
```

### Local Deployment

For local deployment, use the npm scripts from the `worker/` directory:

```bash
cd worker

# Deploy all workers
npm run deploy

# Deploy individual workers
npm run deploy:api
npm run deploy:updater
npm run deploy:processor
```

### Troubleshooting

**Error: "Missing API Token"**
- Ensure `CLOUDFLARE_API_TOKEN` secret is set in repository settings
- Verify the token has correct permissions

**Error: "Missing Account ID"**
- Ensure `CLOUDFLARE_ACCOUNT_ID` secret is set in repository settings

**Error: "Module not found: ../shared/news-providers.js"**
- Check that `workingDirectory` in the workflow is set to `worker`
- Verify the import paths in worker files use `../shared/`

**Deployment succeeds but workers don't update**
- Check Cloudflare Dashboard to verify the deployment timestamp
- Ensure you're testing the correct environment (production vs preview)
- Clear Cloudflare cache if needed

### Monitoring Deployments

After deployment:
1. Check the Actions tab for deployment status
2. View deployment logs in Cloudflare Dashboard → Workers & Pages
3. Test the workers using their deployed URLs
4. Monitor worker logs: `wrangler tail --config worker-{name}/wrangler.toml`

## Repository Secrets

Required secrets for all workflows:
- `GITHUB_TOKEN` (automatically provided)
- `CLOUDFLARE_API_TOKEN` (manual setup required)
- `CLOUDFLARE_ACCOUNT_ID` (manual setup required)

To add secrets:
1. Go to repository Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add the secret name and value
