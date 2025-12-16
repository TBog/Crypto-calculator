# 💰 Crypto Profit Calculator

A beautiful, real-time cryptocurrency profit calculator with live Bitcoin price fetching and animated results. Calculate your potential profits or losses from Bitcoin investments with support for multiple currencies.

![Bitcoin Calculator](https://img.shields.io/badge/Bitcoin-Calculator-orange?style=flat-square&logo=bitcoin)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

## ✨ Features

### Core Calculator Features
- **Real-time Price Fetching**: Automatically fetches current Bitcoin prices from CoinGecko API
- **Multi-Currency Support**: Calculate profits in 160+ different currencies from around the world
- **Transparent Data Attribution**: Clear attribution for all data sources (CoinGecko, ExchangeRate-API, NewsData.io)
- **Exchange Rate Warnings**: Automatic notifications when approximate exchange rates are used
- **Transaction Fee Calculation**: Accounts for both buy and sell fees
- **Animated Results**: Smooth, eye-catching animations when displaying calculation results

### Advanced Features
- **Historical Price Chart**: Interactive 24-hour Bitcoin price chart with zoom and pan capabilities
  - Built with Chart.js
  - Mouse wheel or pinch to zoom
  - Click and drag to pan
  - Double-click to reset view
- **AI-Powered Market Analysis**: Get intelligent market summaries powered by Cloudflare Workers AI
  - Multiple time periods: 24 hours, 7 days, 30 days, 90 days
  - Natural language analysis of price trends and movements
  - Cached for optimal performance
- **Bitcoin News Feed**: Real-time Bitcoin news with AI sentiment analysis
  - Hourly updates via scheduled Cloudflare Worker
  - AI-powered sentiment classification (positive, negative, neutral)
  - Filter by sentiment and customize articles per page
  - Smart pagination with early-exit optimization
- **Transaction Management**: Save and track your Bitcoin transactions
  - Save transaction details (investment, buy price, coins)
  - View current profit/loss for saved transactions
  - Calculate break-even sell prices
  - Export and import transaction history
- **Data Portability**: Full control over your data
  - Share your data as a code
  - Download data as a file
  - Import data from code or file
  - GDPR-compliant data management

### User Experience
- **Dark Mode**: Toggle between light and dark themes with smooth transitions
- **Auto-Refresh**: Automatic updates every 5 minutes for price, chart, and news
- **Responsive Design**: Works perfectly on desktop, tablet, and mobile devices
- **Clean UI**: Built with Tailwind CSS for a modern, professional look
- **GDPR Compliant**: Cookie consent management for data storage
- **Edge Caching**: Uses Cloudflare Workers for fast, cached API responses

## 🚀 Demo

Visit the live calculator at: [https://tbog.github.io/Crypto-calculator/](https://tbog.github.io/Crypto-calculator/)

## 📊 Supported Currencies

The calculator supports **160+ currencies** from around the world, including:

**Major Currencies:**
- USD - US Dollar
- EUR - Euro
- GBP - British Pound
- JPY - Japanese Yen
- CNY - Chinese Yuan
- AUD - Australian Dollar
- CAD - Canadian Dollar
- CHF - Swiss Franc

**And many more currencies** from all continents, automatically fetched from [ExchangeRate-API](https://www.exchangerate-api.com/). The currency list is dynamically loaded, so you always have access to the latest supported currencies.

**Note:** When a currency is not natively supported by CoinGecko, the calculator uses ExchangeRate-API to convert prices from USD. You'll see a notification indicating that exchange rates are approximate.

## 🛠️ Usage

### Basic Calculation
1. **Enter Investment Amount**: The total amount you plan to invest
2. **Enter Buy Price**: The price at which you're buying Bitcoin
3. **Enter Sell Price**: The price at which you plan to sell (or click refresh to get current price)
4. **Set Fee Percentage**: Transaction fee (typically 0.01% to 1%)
5. **Select Currency**: Choose your preferred currency
6. **Click Calculate**: View your detailed profit/loss breakdown

The calculator will show you:
- Number of coins purchased
- Buy and sell fees
- Gross and net sale amounts
- Total fees paid
- **Net profit or loss** (highlighted in green for profit, red for loss)

### Advanced Features Usage

**Save Transactions**: Click "Save Transaction" to store your calculation for future reference. Saved transactions show:
- Current profit/loss based on latest Bitcoin price
- Break-even sell price
- Option to manage individual transactions

**View Price History**: The chart automatically displays 24-hour Bitcoin price trends. Use mouse wheel to zoom, drag to pan, and double-click to reset.

**Get AI Analysis**: Click "✨ Get AI Summary" to receive an intelligent analysis of Bitcoin price trends. Choose different time periods (24h, 7d, 30d, 90d) for varied insights.

**Browse News**: The news feed provides the latest Bitcoin articles with sentiment indicators. Filter by positive, negative, or neutral sentiment, and adjust articles per page.

**Enable Auto-Refresh**: Toggle the auto-refresh switch to automatically update price, chart, and news every 5 minutes.

**Dark Mode**: Click the theme toggle button (sun/moon icon) to switch between light and dark modes.

**Export/Import Data**: Use the Share, Download, or Import buttons in the cookie consent banner to manage your saved data.

## 💻 Local Development

To run this project locally:

```bash
# Clone the repository
git clone https://github.com/TBog/Crypto-calculator.git
cd Crypto-calculator

# Install dependencies
npm install

# Build the CSS (production - minified)
npm run build:css

# Or build for development (unminified, easier to debug)
npm run dev:css

# Or watch for changes and rebuild automatically
npm run watch:css

# Serve the files using any local server
# Option 1: Python
python3 -m http.server 8000

# Option 2: Node.js
npx http-server -p 8000

# Open your browser
# Navigate to http://localhost:8000
```

## 🔧 Technical Details

- **Frontend**: Pure HTML, CSS (Tailwind CSS), and JavaScript
- **Styling**: Tailwind CSS v3 with PostCSS and Autoprefixer
- **Build Tool**: Tailwind CLI for CSS generation
- **Charting**: Chart.js v4 with plugins:
  - chartjs-adapter-date-fns for time scales
  - chartjs-plugin-zoom for interactive zoom/pan
  - Hammer.js for touch gestures
- **Price Data**: CoinGecko API for real-time Bitcoin prices
- **Exchange Rates**: ExchangeRate-API for currency conversions
- **News Data**: NewsData.io API for Bitcoin news articles
- **AI Processing**: Cloudflare Workers AI (Llama 3.1 8B Instruct) for:
  - Market trend analysis
  - News sentiment classification
- **Markdown Rendering**: Custom markdown parser for AI summaries
- **Caching**: Cloudflare Workers for API proxy and edge caching
- **Storage**: Browser localStorage for user preferences and transaction history
- **Hosting**: GitHub Pages (static hosting)
- **Build Process**: Automated CSS building via GitHub Actions

### Data Sources & Attribution

The calculator transparently credits all data sources:

1. **Bitcoin Prices**: Provided by [CoinGecko API](https://www.coingecko.com/)
   - Real-time cryptocurrency market data
   - Historical price charts
   - Native support for major fiat currencies

2. **Exchange Rates**: Provided by [ExchangeRate-API](https://www.exchangerate-api.com/)
   - Used for currencies not natively supported by CoinGecko
   - Automatic conversion from USD to target currency
   - Updated hourly with caching for performance

3. **Bitcoin News**: Provided by [NewsData.io](https://newsdata.io/)
   - Real-time Bitcoin news aggregation
   - Multiple trusted sources
   - Hourly updates via scheduled worker

4. **AI Analysis**: Powered by [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
   - Market trend summaries
   - Sentiment analysis for news articles
   - Edge-native processing

When currency conversion is performed, the calculator displays:
- Clear attribution to both data sources
- A warning that exchange rates are approximate
- Headers indicating the conversion rate used

## 🌐 Cloudflare Worker Setup

This project includes Cloudflare Workers for API caching, CORS handling, AI-powered analysis, and news aggregation. The worker provides:

### Main Features
- **API Proxy & Caching**: Efficient caching of CoinGecko API responses
- **Currency Conversion**: Automatic conversion for 160+ currencies not natively supported by CoinGecko
- **AI Market Analysis**: Natural language summaries of Bitcoin price trends (24h, 7d, 30d, 90d)
- **Bitcoin News Feed**: Scheduled worker with AI sentiment analysis
  - Hourly updates via cron job
  - Early-exit pagination for efficiency
  - Sentiment classification (positive, negative, neutral)
  - Maintains up to 500 articles
- **Origin Validation**: Secure access control
- **CORS Support**: Proper headers for cross-origin requests

### Deployment

For detailed deployment instructions, see:
- [worker/README.md](worker/README.md) - General worker deployment guide
- [worker/DEPLOYMENT_GUIDE.md](worker/DEPLOYMENT_GUIDE.md) - Complete step-by-step setup for both workers

**Quick Overview:**
1. Install Wrangler CLI: `npm install -g wrangler`
2. Login to Cloudflare: `wrangler login`
3. Deploy workers from the `worker/` directory
4. Set required secrets:
   - `COINGECKO_KEY` (optional, for higher rate limits)
   - `NEWSDATA_API_KEY` (required for news feed)
5. Create and bind KV namespace for news caching
6. Set up scheduled cron job for news updates

### Testing

The worker includes a comprehensive test suite:
```bash
cd worker
npm install
npm test
```

See [worker/TEST_README.md](worker/TEST_README.md) for detailed testing documentation.

## 🔍 PR Preview Deployments

This repository supports automatic preview deployments for pull requests! When you open a PR, a preview of your changes will be automatically deployed and accessible at:

```
https://tbog.github.io/Crypto-calculator/pr-preview/pr-<number>/
```

Where `<number>` is your PR number. The preview will be:
- **Automatically created** when you open a PR
- **Updated** whenever you push new commits
- **Removed** when the PR is closed or merged

This allows reviewers to test your changes in a live environment before merging.

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/TBog/Crypto-calculator/issues).

## 👤 Author

**TBog**

- GitHub: [@TBog](https://github.com/TBog)

## 🙏 Acknowledgments

- Bitcoin price data provided by [CoinGecko API](https://www.coingecko.com/)
- Exchange rate data provided by [ExchangeRate-API](https://www.exchangerate-api.com/)
- Bitcoin news provided by [NewsData.io](https://newsdata.io/)
- AI analysis powered by [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
- Charts rendered with [Chart.js](https://www.chartjs.org/)
- UI styled with [Tailwind CSS](https://tailwindcss.com/)
- Hosted on [GitHub Pages](https://pages.github.com/)

---

**Note**: This calculator is for educational and informational purposes only. Always do your own research before making investment decisions. Cryptocurrency investments carry risk.
