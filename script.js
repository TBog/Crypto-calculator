// ========== COOKIE CONSENT MANAGEMENT ==========

// Check if user has given consent
function hasConsent() {
    // Use a non-personal technical cookie to store consent status
    // This is allowed under GDPR as it's strictly necessary for consent management
    try {
        return localStorage.getItem('crypto_calc_consent') === 'granted';
    } catch (e) {
        return false;
    }
}

// Grant consent
function grantConsent() {
    try {
        localStorage.setItem('crypto_calc_consent', 'granted');
    } catch (e) {
        console.error('Failed to save consent:', e);
    }
}

// Revoke consent and clear all stored data
function revokeConsent() {
    try {
        // Clear all cookies
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i];
            const eqPos = cookie.indexOf('=');
            const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
            document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
        }
        
        // Clear all localStorage except consent status
        const consentStatus = localStorage.getItem('crypto_calc_consent');
        localStorage.clear();
        localStorage.setItem('crypto_calc_consent', 'denied');
    } catch (e) {
        console.error('Failed to revoke consent:', e);
    }
}

// Show cookie consent banner
function showConsentBanner() {
    const banner = document.getElementById('cookieConsent');
    if (banner) {
        // Small delay to ensure smooth animation
        setTimeout(() => {
            banner.classList.add('show');
        }, 100);
    }
}

// Hide cookie consent banner
function hideConsentBanner() {
    const banner = document.getElementById('cookieConsent');
    if (banner) {
        banner.classList.remove('show');
    }
}

// Initialize consent banner and handlers
function initConsent() {
    // Check if consent decision has been made
    const consentStatus = localStorage.getItem('crypto_calc_consent');
    
    if (!consentStatus) {
        // No decision made yet, show banner
        showConsentBanner();
    }
    
    // Accept button handler
    document.getElementById('cookieAccept').addEventListener('click', function() {
        grantConsent();
        hideConsentBanner();
        // Reload to apply saved preferences
        window.location.reload();
    });
    
    // Decline button handler
    document.getElementById('cookieDecline').addEventListener('click', function() {
        revokeConsent();
        hideConsentBanner();
    });
    
    // Cookie settings button handler - allows users to change their mind
    document.getElementById('cookieSettings').addEventListener('click', function() {
        showConsentBanner();
    });
}

// Dark mode management
function initDarkMode() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    const sunIcon = document.getElementById('sunIcon');
    const moonIcon = document.getElementById('moonIcon');
    const html = document.documentElement;
    
    // Check for saved dark mode preference, default to light mode
    const savedDarkMode = getCookie('crypto_calc_darkMode');
    const isDarkMode = savedDarkMode === 'true';
    
    // Apply dark mode if saved
    if (isDarkMode) {
        html.classList.add('dark');
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
    }
    
    // Toggle dark mode
    darkModeToggle.addEventListener('click', async function() {
        const isDark = html.classList.toggle('dark');
        setCookie('crypto_calc_darkMode', isDark.toString(), 365);
        
        // Toggle icons
        if (isDark) {
            sunIcon.classList.remove('hidden');
            moonIcon.classList.add('hidden');
        } else {
            sunIcon.classList.add('hidden');
            moonIcon.classList.remove('hidden');
        }
        
        // Refresh chart to update colors
        const currency = document.getElementById('currency').value;
        await initPriceChart(currency);
    });
}

// Animation configuration
const ANIMATION_CONFIG = {
    DIGIT_FLIP_DURATION: 400, // ms - matches CSS animation duration
    DIGIT_STAGGER_DELAY: 30,  // ms - delay between each digit
    RESULTS_SLIDE_DURATION: 500 // ms - results container slide-down
};

// Worker API configuration
const WORKER_BASE_URL = 'https://crypto-cache.tbog.workers.dev';

// Crypto currencies (for worker validation, not used in frontend selector)
const CRYPTO_CURRENCIES = ['btc', 'eth', 'ltc', 'bch', 'bnb', 'eos', 'xrp', 'xlm', 'link', 'dot', 'yfi', 'sol', 'bits', 'sats'];
// Commodity currencies (for worker validation, not used in frontend selector)
const COMMODITY_CURRENCIES = ['xdr', 'xag', 'xau'];

// Default values
const defaults = {
    investment: 50000,
    buyPrice: 480000,
    sellPrice: null, // Will be fetched from API
    sellPriceFallback: 485000, // Fallback only if API fails (approximate USD value)
    fee: 0.01
};

// State to track if results have been shown
let resultsShown = false;

// API cache with timestamp
const priceCache = new Map();
const CACHE_DURATION = 60000; // 60 seconds cache

// Chart instance
let priceChart = null;

// Register Chart.js zoom plugin
if (typeof Chart !== 'undefined' && typeof ChartZoom !== 'undefined') {
    Chart.register(ChartZoom);
} else if (typeof Chart !== 'undefined') {
    console.warn('ChartZoom plugin not loaded - zoom functionality will not be available');
}

// Fetch current BTC price from CoinGecko API via Cloudflare Worker proxy with fallback
async function fetchBTCPrice(currency = 'usd') {
    const currencyLower = currency.toLowerCase();
    
    // Check cache first
    const cacheKey = currencyLower;
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.price;
    }
    
    // Try worker first
    try {
        const workerUrl = `${WORKER_BASE_URL}/api/v3/simple/price?ids=bitcoin&vs_currencies=${currencyLower}`;
        const response = await fetch(workerUrl);
        
        if (!response.ok) {
            throw new Error(`Worker responded with status ${response.status}`);
        }
        
        const data = await response.json();
        const price = data.bitcoin[currencyLower];
        
        // Cache the result
        priceCache.set(cacheKey, { price, timestamp: Date.now() });
        return price;
    } catch (workerError) {
        console.warn('Worker API failed, falling back to public API:', workerError);
        
        // Fallback to public CoinGecko API
        try {
            const publicUrl = `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${currencyLower}`;
            const response = await fetch(publicUrl);
            
            if (!response.ok) {
                throw new Error(`Public API responded with status ${response.status}`);
            }
            
            const data = await response.json();
            const price = data.bitcoin[currencyLower];
            
            // Cache the result
            priceCache.set(cacheKey, { price, timestamp: Date.now() });
            return price;
        } catch (publicError) {
            console.error('Both worker and public API failed:', publicError);
            // Return null to allow downstream code to decide fallback behavior
            // User can still manually enter a sell price if API is unavailable
            return null;
        }
    }
}

// Fetch Bitcoin price chart data (last 24 hours, hourly)
async function fetchBTCChartData(currency = 'usd') {
    const currencyLower = currency.toLowerCase();
    
    // Check cache first
    const cacheKey = `chart_${currencyLower}`;
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }
    
    // Try worker first
    try {
        const workerUrl = `${WORKER_BASE_URL}/api/v3/coins/bitcoin/market_chart?vs_currency=${currencyLower}&days=1`;
        const response = await fetch(workerUrl);
        
        if (!response.ok) {
            throw new Error(`Worker responded with status ${response.status}`);
        }
        
        const data = await response.json();
        
        // Cache the result
        priceCache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    } catch (workerError) {
        console.warn('Worker API failed, falling back to public API:', workerError);
        
        // Fallback to public CoinGecko API
        try {
            const publicUrl = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=${currencyLower}&days=1`;
            const response = await fetch(publicUrl);
            
            if (!response.ok) {
                throw new Error(`Public API responded with status ${response.status}`);
            }
            
            const data = await response.json();
            
            // Cache the result
            priceCache.set(cacheKey, { data, timestamp: Date.now() });
            return data;
        } catch (publicError) {
            console.error('Both worker and public API failed:', publicError);
            return null;
        }
    }
}

// Initialize or update the price chart
async function initPriceChart(currency = 'usd') {
    const currencyLower = currency.toLowerCase();
    const chartData = await fetchBTCChartData(currencyLower);
    
    if (!chartData || !chartData.prices) {
        console.error('Failed to fetch chart data');
        return;
    }
    
    // Extract timestamps and prices
    const timestamps = chartData.prices.map(point => new Date(point[0]));
    const prices = chartData.prices.map(point => point[1]);
    
    const ctx = document.getElementById('priceChart').getContext('2d');
    
    // Check if we're in dark mode
    const isDarkMode = document.documentElement.classList.contains('dark');
    
    // Define colors based on theme
    const gridColor = isDarkMode ? 'rgba(75, 85, 99, 0.3)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? 'rgba(229, 231, 235, 0.8)' : 'rgba(0, 0, 0, 0.8)';
    const lineColor = isDarkMode ? 'rgba(59, 130, 246, 1)' : 'rgba(37, 99, 235, 1)';
    const gradientStart = isDarkMode ? 'rgba(59, 130, 246, 0.3)' : 'rgba(37, 99, 235, 0.3)';
    const gradientEnd = isDarkMode ? 'rgba(59, 130, 246, 0)' : 'rgba(37, 99, 235, 0)';
    
    // Create gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
    gradient.addColorStop(0, gradientStart);
    gradient.addColorStop(1, gradientEnd);
    
    // Destroy existing chart if it exists
    if (priceChart) {
        priceChart.destroy();
    }
    
    // Create new chart
    priceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: timestamps,
            datasets: [{
                label: `Bitcoin Price (${currency.toUpperCase()})`,
                data: prices,
                borderColor: lineColor,
                backgroundColor: gradient,
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: lineColor,
                pointHoverBorderColor: isDarkMode ? '#fff' : '#000',
                pointHoverBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: textColor,
                        font: {
                            size: 14,
                            weight: 'bold'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: isDarkMode ? 'rgba(31, 41, 55, 0.9)' : 'rgba(255, 255, 255, 0.9)',
                    titleColor: textColor,
                    bodyColor: textColor,
                    borderColor: gridColor,
                    borderWidth: 1,
                    displayColors: false,
                    callbacks: {
                        title: function(context) {
                            const date = new Date(context[0].label);
                            return date.toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                        },
                        label: function(context) {
                            return new Intl.NumberFormat('en-US', {
                                style: 'currency',
                                currency: currency.toUpperCase(),
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2
                            }).format(context.parsed.y);
                        }
                    }
                },
                zoom: {
                    zoom: {
                        wheel: {
                            enabled: true,
                            speed: 0.1
                        },
                        pinch: {
                            enabled: true
                        },
                        mode: 'x'
                    },
                    pan: {
                        enabled: true,
                        mode: 'x'
                    },
                    limits: {
                        x: {min: 'original', max: 'original'}
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'hour',
                        displayFormats: {
                            hour: 'HH:mm'
                        }
                    },
                    grid: {
                        color: gridColor,
                        drawBorder: false
                    },
                    ticks: {
                        color: textColor,
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 12
                    }
                },
                y: {
                    grid: {
                        color: gridColor,
                        drawBorder: false
                    },
                    ticks: {
                        color: textColor,
                        callback: function(value) {
                            return new Intl.NumberFormat('en-US', {
                                style: 'currency',
                                currency: currency.toUpperCase(),
                                minimumFractionDigits: 0,
                                maximumFractionDigits: 0
                            }).format(value);
                        }
                    }
                }
            }
        }
    });
    
    // Double-click event listener is now registered once in initEventListeners
}

// Cookie helper functions
function setCookie(name, value, days = 90) {
    if (!hasConsent()) {
        return; // Don't set cookie without consent
    }
    const expires = new Date();
    expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + expires.toUTCString() + ';path=/';
}

function getCookie(name) {
    if (!hasConsent()) {
        return null; // Don't read cookies without consent
    }
    const nameEQ = name + '=';
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
    }
    return null;
}

// Detect user's currency based on locale
function detectUserCurrency() {
    try {
        // Try to detect currency from user's locale
        const userLocale = navigator.language || navigator.userLanguage || 'en-US';
        
        // Common currency mappings based on locale
        const localeToCurrency = {
            'en-US': 'USD', 'en-GB': 'GBP', 'en-AU': 'AUD', 'en-CA': 'CAD',
            'de': 'EUR', 'de-DE': 'EUR', 'fr': 'EUR', 'fr-FR': 'EUR', 
            'es': 'EUR', 'es-ES': 'EUR', 'it': 'EUR', 'it-IT': 'EUR',
            'pt-BR': 'BRL', 'ja': 'JPY', 'ja-JP': 'JPY',
            'zh-CN': 'CNY', 'ko': 'KRW', 'ko-KR': 'KRW',
            'en-IN': 'INR', 'hi': 'INR', 'ru': 'RUB', 'ru-RU': 'RUB',
            'ro': 'RON', 'ro-RO': 'RON',
            'es-MX': 'MXN', 'en-SG': 'SGD', 'zh-HK': 'HKD', 'en-HK': 'HKD'
        };
        
        // Try exact match first, then language part
        let detectedCurrency = localeToCurrency[userLocale];
        if (!detectedCurrency) {
            const lang = userLocale.split('-')[0];
            detectedCurrency = localeToCurrency[lang];
        }
        
        return detectedCurrency || 'USD';
    } catch (e) {
        return 'USD';
    }
}

// Save form values to cookies (excluding sell price)
function saveFormValues() {
    setCookie('crypto_calc_investment', document.getElementById('investment').value);
    setCookie('crypto_calc_buyPrice', document.getElementById('buyPrice').value);
    // Sell price is not saved - always fetched from API
    setCookie('crypto_calc_fee', document.getElementById('fee').value);
    setCookie('crypto_calc_currency', document.getElementById('currency').value);
}

// Load form values from cookies
async function loadFormValues() {
    const savedInvestment = getCookie('crypto_calc_investment');
    const savedBuyPrice = getCookie('crypto_calc_buyPrice');
    // Sell price is not saved in cookies - always fetch from API
    const savedFee = getCookie('crypto_calc_fee');
    const savedCurrency = getCookie('crypto_calc_currency');

    // Set currency first: try cookie, then detect, then default to USD
    const currency = savedCurrency ?? detectUserCurrency();
    document.getElementById('currency').value = currency;

    // Fetch current BTC price for the selected currency
    const sellPriceValue = await fetchBTCPrice(currency);

    // Set values from cookies or defaults
    document.getElementById('investment').value = savedInvestment ?? defaults.investment;
    document.getElementById('buyPrice').value = savedBuyPrice ?? defaults.buyPrice;
    // Use fetched price, or fallback to approximate value for initial load only
    document.getElementById('sellPrice').value = formatPrice(sellPriceValue ?? defaults.sellPriceFallback);
    document.getElementById('fee').value = savedFee ?? defaults.fee;
}

// Set default values
function setDefaults() {
    document.getElementById('investment').value = defaults.investment;
    document.getElementById('buyPrice').value = defaults.buyPrice;
    document.getElementById('sellPrice').value = formatPrice(defaults.sellPriceFallback);
    document.getElementById('fee').value = defaults.fee;
}

// Format number as currency
function formatCurrency(num) {
    const currency = document.getElementById('currency').value || 'USD';
    // Use 'en-US' locale for consistent formatting across all users
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(num);
}

// Format price to 2 decimal places
function formatPrice(price) {
    // Return as-is for null/undefined, input fields handle these gracefully
    if (price === null || price === undefined) {
        return price;
    }
    // Convert to number and check if valid
    const num = Number(price);
    if (Number.isNaN(num)) {
        return price;
    }
    return parseFloat(num.toFixed(2));
}

// Animate element when value changes
function animateElement(element) {
    element.classList.remove('animate-digit');
    // Force reflow to restart animation
    void element.offsetWidth;
    element.classList.add('animate-digit');
}

// Animate individual characters/digits with staggered effect
function animateDigits(element, newValue) {
    const oldValue = element.textContent;
    if (oldValue === newValue) return;

    // Wrap each character in a span for individual animation
    const chars = newValue.split('');
    element.innerHTML = chars.map((char, index) => {
        const delayMs = index * ANIMATION_CONFIG.DIGIT_STAGGER_DELAY;
        return `<span class="digit-flip" style="animation-delay: ${delayMs}ms">${char}</span>`;
    }).join('');

    // Remove animation classes after animation completes
    const totalDuration = ANIMATION_CONFIG.DIGIT_FLIP_DURATION + (chars.length * ANIMATION_CONFIG.DIGIT_STAGGER_DELAY);
    setTimeout(() => {
        element.textContent = newValue;
    }, totalDuration);
}

// Update element with animation
function updateWithAnimation(elementId, value) {
    const element = document.getElementById(elementId);
    if (resultsShown) {
        animateDigits(element, value);
    } else {
        element.textContent = value;
    }
}

// Check if results are currently visible
function areResultsVisible() {
    const resultsElement = document.getElementById('results');
    return resultsElement && resultsElement.classList.contains('show');
}

// Calculate profit
function calculate() {
    const investment = parseFloat(document.getElementById('investment').value);
    const buyPrice = parseFloat(document.getElementById('buyPrice').value);
    const sellPrice = parseFloat(document.getElementById('sellPrice').value);
    const feePercent = parseFloat(document.getElementById('fee').value);

    // Validate inputs
    if (isNaN(investment) || isNaN(buyPrice) || isNaN(sellPrice) || isNaN(feePercent)) {
        alert('Please enter valid numbers for all fields');
        return;
    }

    if (investment <= 0) {
        alert('Investment amount must be greater than zero');
        return;
    }

    if (buyPrice <= 0) {
        alert('Buy price must be greater than zero');
        return;
    }

    if (sellPrice <= 0) {
        alert('Sell price must be greater than zero');
        return;
    }

    if (feePercent < 0 || feePercent > 100) {
        alert('Fee percentage must be between 0 and 100');
        return;
    }

    // Calculate buy fee (applied to investment amount)
    const buyFee = investment * (feePercent / 100);
    const amountAfterBuyFee = investment - buyFee;
    
    // Calculate coins purchased with amount after buy fee
    const coinsPurchased = amountAfterBuyFee / buyPrice;
    
    // Calculate gross sale amount
    const grossSaleAmount = coinsPurchased * sellPrice;
    
    // Calculate sell fee (applied to gross sale amount)
    const sellFee = grossSaleAmount * (feePercent / 100);
    
    // Calculate net sale amount
    const netSaleAmount = grossSaleAmount - sellFee;
    
    // Calculate net profit/loss
    const netProfit = netSaleAmount - investment;
    
    // Calculate total fees
    const totalFees = buyFee + sellFee;

    // Display results with animation
    updateWithAnimation('coinsPurchased', coinsPurchased.toFixed(8));
    updateWithAnimation('buyFee', formatCurrency(buyFee));
    updateWithAnimation('grossSale', formatCurrency(grossSaleAmount));
    updateWithAnimation('sellFee', formatCurrency(sellFee));
    updateWithAnimation('netSale', formatCurrency(netSaleAmount));
    updateWithAnimation('totalFees', formatCurrency(totalFees));
    
    const netProfitElement = document.getElementById('netProfit');
    updateWithAnimation('netProfit', formatCurrency(netProfit));
    
    // Color code profit/loss
    if (netProfit > 0) {
        netProfitElement.className = 'text-2xl font-bold text-green-600';
    } else if (netProfit < 0) {
        netProfitElement.className = 'text-2xl font-bold text-red-600';
    } else {
        netProfitElement.className = 'text-2xl font-bold text-gray-600';
    }

    // Show results with smooth animation
    const resultsDiv = document.getElementById('results');
    resultsDiv.classList.add('show');
    resultsShown = true;
}

// ========== TRANSACTIONS MANAGEMENT ==========

// Load transactions from localStorage
function loadTransactions() {
    if (!hasConsent()) {
        return []; // Don't access localStorage without consent
    }
    try {
        const saved = localStorage.getItem('crypto_calc_transactions');
        return saved ? JSON.parse(saved) : [];
    } catch (e) {
        console.error('Failed to load transactions:', e);
        return [];
    }
}

// Save transactions to localStorage
function saveTransactions(transactions) {
    if (!hasConsent()) {
        return; // Don't save to localStorage without consent
    }
    try {
        localStorage.setItem('crypto_calc_transactions', JSON.stringify(transactions));
    } catch (e) {
        console.error('Failed to save transactions:', e);
    }
}

// Calculate current profit for a transaction
function calculateTransactionProfit(transaction, currentPrice) {
    const buyFee = transaction.investment * (transaction.fee / 100);
    const amountAfterBuyFee = transaction.investment - buyFee;
    const coinsPurchased = amountAfterBuyFee / transaction.buyPrice;
    const grossSaleAmount = coinsPurchased * currentPrice;
    const sellFee = grossSaleAmount * (transaction.fee / 100);
    const netSaleAmount = grossSaleAmount - sellFee;
    const netProfit = netSaleAmount - transaction.investment;
    
    // Calculate coins to sell to recover the initial investment amount (accounting for sell fee)
    // Formula: investment = coinsToSell * currentPrice * (1 - fee/100)
    // Therefore: coinsToSell = investment / (currentPrice * (1 - fee/100))
    const feeMultiplier = 1 - transaction.fee / 100;
    const coinsToSellBreakEven = feeMultiplier > 0 && currentPrice > 0
        ? transaction.investment / (currentPrice * feeMultiplier)
        : 0;
    
    // The coins to sell for the displayed profit is all coins purchased
    // The value shown accounts for the sell fee since profit is calculated with fee
    const coinsToSellForProfit = coinsPurchased;
    
    return {
        coinsPurchased,
        netProfit,
        coinsToSellBreakEven,
        coinsToSellForProfit
    };
}

// Format currency with transaction's currency
function formatTransactionCurrency(num, currency) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(num);
}

// Render transactions table
async function renderTransactions() {
    const transactions = loadTransactions();
    const tbody = document.getElementById('transactionsTableBody');
    const section = document.getElementById('transactionsSection');
    
    if (transactions.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    tbody.innerHTML = '';
    
    // Get unique currencies to minimize API calls
    const uniqueCurrencies = [...new Set(transactions.map(tx => tx.currency))];
    
    // Fetch prices for all unique currencies in parallel
    const pricePromises = uniqueCurrencies.map(currency => 
        fetchBTCPrice(currency).then(price => ({ currency, price }))
    );
    const prices = await Promise.all(pricePromises);
    const priceMap = new Map(prices.map(({ currency, price }) => [currency, price]));
    
    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const currentPrice = priceMap.get(tx.currency);
        const sellPrice = currentPrice !== null ? currentPrice : tx.buyPrice;
        const { coinsPurchased, netProfit, coinsToSellBreakEven, coinsToSellForProfit } = calculateTransactionProfit(tx, sellPrice);
        
        const profitClass = netProfit > 0 ? 'text-green-600 dark:text-green-400' : 
                           netProfit < 0 ? 'text-red-600 dark:text-red-400' : 
                           'text-gray-600 dark:text-gray-400';
        
        const row = document.createElement('tr');
        row.className = 'border-b dark:border-gray-600';
        row.innerHTML = `
            <td class="py-2 px-2">${formatTransactionCurrency(tx.investment, tx.currency)}</td>
            <td class="py-2 px-2">${formatTransactionCurrency(tx.buyPrice, tx.currency)}</td>
            <td class="py-2 px-2">${coinsPurchased.toFixed(8)}</td>
            <td class="py-2 px-2">${coinsToSellBreakEven.toFixed(8)}</td>
            <td class="py-2 px-2">${coinsToSellForProfit.toFixed(8)}</td>
            <td class="py-2 px-2 font-semibold ${profitClass}">${formatTransactionCurrency(netProfit, tx.currency)}</td>
            <td class="py-2 px-2">
                <button 
                    data-index="${i}"
                    class="delete-transaction px-3 py-1 bg-red-500 text-white text-xs rounded hover:bg-red-600 transition"
                >
                    Delete
                </button>
            </td>
        `;
        tbody.appendChild(row);
    }
    
    // Add event listeners to delete buttons
    document.querySelectorAll('.delete-transaction').forEach(button => {
        button.addEventListener('click', function() {
            const index = parseInt(this.getAttribute('data-index'));
            deleteTransaction(index);
        });
    });
}

// Delete a transaction
function deleteTransaction(index) {
    const transactions = loadTransactions();
    transactions.splice(index, 1);
    saveTransactions(transactions);
    renderTransactions();
}

// Initialize event listeners
function initEventListeners() {
    // Handle form submission
    document.getElementById('calcForm').addEventListener('submit', function(e) {
        e.preventDefault();
        saveFormValues();
        calculate();
    });

    // Save values when currency changes and recalculate
    document.getElementById('currency').addEventListener('change', async function() {
        saveFormValues();
        // Fetch new BTC price for the selected currency
        const currency = document.getElementById('currency').value;
        const newPrice = await fetchBTCPrice(currency);
        if (newPrice !== null) {
            document.getElementById('sellPrice').value = formatPrice(newPrice);
        }
        // Update the chart with new currency
        await initPriceChart(currency);
        // Only recalculate if results are visible
        if (areResultsVisible()) {
            calculate();
        }
    });

    // Refresh button handler
    document.getElementById('refreshPrice').addEventListener('click', async function() {
        const currency = document.getElementById('currency').value;
        const newPrice = await fetchBTCPrice(currency);
        if (newPrice !== null) {
            document.getElementById('sellPrice').value = formatPrice(newPrice);
        }
        // Recalculate if results are visible
        if (areResultsVisible()) {
            calculate();
        }
        // Wait a bit for the price to update
        await new Promise(resolve => setTimeout(resolve, 500));
        renderTransactions();
    });

    // Refresh chart button handler
    document.getElementById('refreshChart').addEventListener('click', async function() {
        const currency = document.getElementById('currency').value;
        await initPriceChart(currency);
    });

    // Save values and recalculate when inputs change
    ['investment', 'buyPrice', 'sellPrice', 'fee'].forEach(function(id) {
        const element = document.getElementById(id);
        element.addEventListener('change', function() {
            saveFormValues();
            // Recalculate if results are visible
            if (areResultsVisible()) {
                calculate();
            }
        });
        // Also trigger on input event for real-time updates
        element.addEventListener('input', function() {
            // Only recalculate if results are visible
            if (areResultsVisible()) {
                calculate();
            }
        });
    });

    // Save current transaction
    document.getElementById('saveTransaction').addEventListener('click', function() {
        // Check for consent first
        if (!hasConsent()) {
            alert('Please accept cookie consent to save transactions. Your data will be stored locally on your device.');
            showConsentBanner();
            return;
        }
        
        const investment = parseFloat(document.getElementById('investment').value);
        const buyPrice = parseFloat(document.getElementById('buyPrice').value);
        const fee = parseFloat(document.getElementById('fee').value);
        const currency = document.getElementById('currency').value;

        // Validate inputs
        if (isNaN(investment) || isNaN(buyPrice) || isNaN(fee)) {
            alert('Please enter valid numbers for all fields');
            return;
        }

        if (investment <= 0 || buyPrice <= 0) {
            alert('Investment amount and buy price must be greater than zero');
            return;
        }

        if (fee < 0 || fee > 100) {
            alert('Fee percentage must be between 0 and 100');
            return;
        }

        const transaction = {
            investment,
            buyPrice,
            fee,
            currency,
            timestamp: Date.now()
        };

        const transactions = loadTransactions();
        transactions.push(transaction);
        saveTransactions(transactions);
        renderTransactions();
    });

    // Clear all transactions
    document.getElementById('clearAllTransactions').addEventListener('click', function() {
        if (confirm('Are you sure you want to delete all saved transactions?')) {
            saveTransactions([]);
            renderTransactions();
        }
    });
}

// Run on page load
window.addEventListener('load', async function() {
    // Initialize consent system first (before any data storage)
    initConsent();
    
    initDarkMode();
    initEventListeners();
    await loadFormValues();
    // Initialize the price chart with the selected currency
    const currency = document.getElementById('currency').value;
    await initPriceChart(currency);
    // Do not calculate on initial load - wait for user interaction
    await renderTransactions();
});
