# 💰 Crypto Profit Calculator

A beautiful, real-time cryptocurrency profit calculator with live Bitcoin price fetching and animated results. Calculate your potential profits or losses from Bitcoin investments with support for multiple currencies.

![Bitcoin Calculator](https://img.shields.io/badge/Bitcoin-Calculator-orange?style=flat-square&logo=bitcoin)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

## ✨ Features

- **Real-time Price Fetching**: Automatically fetches current Bitcoin prices from CoinGecko API
- **Multi-Currency Support**: Calculate profits in 16+ different currencies (USD, EUR, GBP, JPY, and more)
- **Transaction Fee Calculation**: Accounts for both buy and sell fees
- **Animated Results**: Smooth, eye-catching animations when displaying calculation results
- **Responsive Design**: Works perfectly on desktop, tablet, and mobile devices
- **Edge Caching**: Uses Cloudflare Workers for fast, cached API responses
- **Clean UI**: Built with Tailwind CSS for a modern, professional look

## 🚀 Demo

Visit the live calculator at: [https://tbog.github.io/Crypto-calculator/](https://tbog.github.io/Crypto-calculator/)

## 📊 Supported Currencies

- USD - US Dollar
- EUR - Euro
- GBP - British Pound
- JPY - Japanese Yen
- CNY - Chinese Yuan
- AUD - Australian Dollar
- CAD - Canadian Dollar
- CHF - Swiss Franc
- INR - Indian Rupee
- BRL - Brazilian Real
- RUB - Russian Ruble
- RON - Romanian Leu
- KRW - South Korean Won
- MXN - Mexican Peso
- SGD - Singapore Dollar
- HKD - Hong Kong Dollar

## 🛠️ Usage

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

## 💻 Local Development

To run this project locally:

```bash
# Clone the repository
git clone https://github.com/TBog/Crypto-calculator.git
cd Crypto-calculator

# Serve the files using any local server
# Option 1: Python
python3 -m http.server 8000

# Option 2: Node.js
npx http-server -p 8000

# Open your browser
# Navigate to http://localhost:8000
```

## 🔧 Technical Details

- **Frontend**: Pure HTML, CSS (Tailwind CSS via CDN), and JavaScript
- **API**: CoinGecko API for real-time Bitcoin prices
- **Caching**: Cloudflare Workers for API proxy and edge caching
- **Hosting**: GitHub Pages (static hosting)
- **No Build Process**: Runs directly in the browser, no compilation needed

## 🌐 Cloudflare Worker Setup

This project includes a Cloudflare Worker for API caching and CORS handling. See the [worker/README.md](worker/README.md) for detailed deployment instructions.

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/TBog/Crypto-calculator/issues).

## 👤 Author

**TBog**

- GitHub: [@TBog](https://github.com/TBog)

## 🙏 Acknowledgments

- Bitcoin price data provided by [CoinGecko API](https://www.coingecko.com/)
- UI styled with [Tailwind CSS](https://tailwindcss.com/)
- Hosted on [GitHub Pages](https://pages.github.com/)

---

**Note**: This calculator is for educational and informational purposes only. Always do your own research before making investment decisions. Cryptocurrency investments carry risk.
