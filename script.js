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
    
    // Close banner button handler - allows users to dismiss without action
    document.getElementById('closeBanner').addEventListener('click', function() {
        hideConsentBanner();
    });
    
    // Share data button handler
    document.getElementById('shareData').addEventListener('click', function() {
        handleShare();
    });
    
    // Download data button handler
    document.getElementById('downloadData').addEventListener('click', function() {
        handleDownload();
    });
    
    // Import data button handler
    document.getElementById('importData').addEventListener('click', function() {
        handleImport();
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

// Chart configuration
const CHART_CONFIG = {
    DUPLICATE_TIMESTAMP_TOLERANCE: 60000 // ms - 1 minute tolerance for duplicate detection
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

// Auto-refresh configuration
const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
let autoRefreshTimer = null;
let autoRefreshEnabled = false;
let isRefreshing = false; // Flag to prevent concurrent refreshes

// Register Chart.js zoom plugin
if (typeof Chart !== 'undefined' && typeof ChartZoom !== 'undefined') {
    Chart.register(ChartZoom);
} else if (typeof Chart !== 'undefined') {
    console.warn('ChartZoom plugin not loaded - zoom functionality will not be available');
}

/**
 * Check response headers for currency conversion and display warnings
 * @param {Response} response - Fetch API response
 */
function handleDataAttribution(response) {
    const attributionDiv = document.getElementById('dataAttribution');
    const exchangeRateAttr = document.getElementById('exchangeRateAttribution');
    const conversionWarning = document.getElementById('conversionWarning');
    
    // Always show the attribution section
    attributionDiv.style.display = 'block';
    
    // Check if currency conversion was performed
    const currencyConverted = response.headers.get('X-Currency-Converted');
    const conversionWarningText = response.headers.get('X-Conversion-Warning');
    
    if (currencyConverted) {
        // Show exchange rate attribution
        exchangeRateAttr.style.display = 'block';
        
        // Show conversion warning if present
        if (conversionWarningText) {
            conversionWarning.style.display = 'block';
        } else {
            conversionWarning.style.display = 'none';
        }
    } else {
        // Hide exchange rate attribution and warning if no conversion
        exchangeRateAttr.style.display = 'none';
        conversionWarning.style.display = 'none';
    }
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
        
        // Handle data attribution from response headers
        handleDataAttribution(response);
        
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
        
        // Handle data attribution from response headers
        handleDataAttribution(response);
        
        const data = await response.json();
        
        // Extract cache metadata from response headers
        const cacheStatus = response.headers.get('X-Cache-Status');
        const cacheControl = response.headers.get('Cache-Control');
        
        // Parse max-age from Cache-Control header if available
        let maxAge = null;
        if (cacheControl) {
            const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
            if (maxAgeMatch) {
                maxAge = parseInt(maxAgeMatch[1], 10);
            }
        }
        
        const result = {
            data,
            cacheMetadata: {
                status: cacheStatus,
                maxAge: maxAge,
                fetchTime: Date.now()
            }
        };
        
        // Cache the result
        priceCache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
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
            
            // No cache metadata for public API
            const result = {
                data,
                cacheMetadata: {
                    status: 'public-api',
                    maxAge: null,
                    fetchTime: Date.now()
                }
            };
            
            // Cache the result
            priceCache.set(cacheKey, { data: result, timestamp: Date.now() });
            return result;
        } catch (publicError) {
            console.error('Both worker and public API failed:', publicError);
            return null;
        }
    }
}

/**
 * Add a single price point to the existing chart
 * Only adds if the price point is unique (based on timestamp) and newer than existing data
 * @param {number} price - The price to add
 * @param {number} timestamp - The timestamp for the price point (defaults to current time if not provided)
 */
function addPricePointToChart(price, timestamp = Date.now()) {
    // Validate price parameter
    if (typeof price !== 'number' || isNaN(price) || price <= 0) {
        console.warn('Invalid price value, cannot add to chart:', price);
        return;
    }
    
    if (!priceChart || !priceChart.data || !priceChart.data.datasets || !priceChart.data.datasets[0]) {
        console.warn('Chart not initialized, cannot add price point');
        return;
    }

    const dataset = priceChart.data.datasets[0];
    const labels = priceChart.data.labels;
    
    // Convert timestamp to Date object for consistency
    const newDate = new Date(timestamp);
    const newTime = newDate.getTime();
    
    // Check if this timestamp already exists (avoid duplicates)
    // Compare timestamps by converting to time value (milliseconds since epoch)
    const existingIndex = labels.findIndex(label => {
        const labelTime = new Date(label).getTime();
        // Consider timestamps within tolerance as duplicates
        return Math.abs(labelTime - newTime) < CHART_CONFIG.DUPLICATE_TIMESTAMP_TOLERANCE;
    });
    
    if (existingIndex !== -1) {
        // Timestamp already exists, update the existing value instead of adding
        dataset.data[existingIndex] = price;
        console.log('Updated existing price point at index', existingIndex);
    } else {
        // Check if new timestamp is newer than the last data point
        if (labels.length > 0) {
            const lastTimestamp = new Date(labels[labels.length - 1]).getTime();
            
            if (newTime <= lastTimestamp) {
                console.warn('New price point is not newer than existing data, skipping');
                return;
            }
        }
        
        // Add the new data point at the end
        labels.push(newDate);
        dataset.data.push(price);
        console.log('Added new price point to chart:', { timestamp: newDate, price });
    }
    
    // Update the chart
    priceChart.update('none'); // 'none' mode disables animations for smoother updates
}

// Initialize or update the price chart
async function initPriceChart(currency = 'usd') {
    const currencyLower = currency.toLowerCase();
    const result = await fetchBTCChartData(currencyLower);
    
    if (!result || !result.data || !result.data.prices) {
        console.error('Failed to fetch chart data');
        return;
    }
    
    const chartData = result.data;
    
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
                            // Use context[0].parsed.x which contains the raw timestamp value
                            // This ensures proper date formatting regardless of the label format
                            const date = new Date(context[0].parsed.x);
                            // Use user's locale and timezone for date formatting
                            return date.toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                timeZoneName: 'short'
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
                            // Format numbers with K/M/B suffixes for mobile screens
                            // Check viewport width on each render to handle device rotation
                            const isMobile = window.innerWidth <= 768;
                            
                            if (isMobile) {
                                // For mobile, use compact notation with K/M/B suffixes
                                let suffix = '';
                                let displayValue = value;
                                
                                if (Math.abs(value) >= 1000000000) {
                                    displayValue = value / 1000000000;
                                    suffix = 'B';
                                } else if (Math.abs(value) >= 1000000) {
                                    displayValue = value / 1000000;
                                    suffix = 'M';
                                } else if (Math.abs(value) >= 1000) {
                                    displayValue = value / 1000;
                                    suffix = 'K';
                                }
                                
                                // Use conditional formatting to omit multi-char currency codes
                                const minDecimals = suffix ? 0 : 0;
                                const maxDecimals = suffix ? 1 : 0;
                                const formatted = formatCurrencyConditionally(
                                    displayValue, 
                                    'en-US', 
                                    currency.toUpperCase(),
                                    minDecimals,
                                    maxDecimals
                                );
                                return formatted + suffix;
                            } else {
                                // For desktop, show full number with conditional formatting
                                return formatCurrencyConditionally(value, 'en-US', currency.toUpperCase(), 0, 0);
                            }
                        }
                    }
                }
            }
        }
    });
    
    // Double-click event listener is now registered once in initEventListeners
}

// ========== AUTO-REFRESH MANAGEMENT ==========

/**
 * Update the last update timestamp display
 * @param {Object} cacheMetadata - Optional cache metadata from backend
 */
function updateLastUpdateTime(cacheMetadata = null) {
    const lastUpdateElement = document.getElementById('lastUpdateTime');
    if (lastUpdateElement) {
        const now = new Date();
        const timeString = now.toLocaleTimeString(undefined, { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
        
        let displayText = `Last updated: ${timeString}`;
        
        // Add cache information if available
        if (cacheMetadata) {
            const { status, maxAge, fetchTime } = cacheMetadata;
            
            if (status === 'HIT' && maxAge && fetchTime) {
                // Calculate when the data was originally cached
                // For cache HIT, the data could be anywhere from 0 to maxAge seconds old
                // We show this as a helpful indicator
                const cacheAgeSeconds = Math.floor((Date.now() - fetchTime) / 1000);
                const remainingSeconds = Math.max(0, maxAge - cacheAgeSeconds);
                const remainingMinutes = Math.floor(remainingSeconds / 60);
                
                displayText += ` (cached, expires in ${remainingMinutes}m)`;
            } else if (status === 'MISS' && maxAge) {
                // Fresh data from backend
                const expiresMinutes = Math.floor(maxAge / 60);
                displayText += ` (fresh data, cache ${expiresMinutes}m)`;
            } else if (status === 'public-api') {
                displayText += ` (direct API)`;
            }
        }
        
        lastUpdateElement.textContent = displayText;
    }
}

/**
 * Refresh chart and sell price
 * Uses chart data to get the most recent price, which is more efficient
 * as it avoids a separate API call and ensures price/chart synchronization
 */
async function refreshChartAndPrice() {
    // Prevent concurrent refreshes
    if (isRefreshing) {
        console.log('Refresh already in progress, skipping...');
        return;
    }
    
    isRefreshing = true;
    
    try {
        const currencyElement = document.getElementById('currency');
        const sellPriceElement = document.getElementById('sellPrice');
        
        if (!currencyElement || !sellPriceElement) {
            console.warn('Required elements not found for refresh');
            return;
        }
        
        const currency = currencyElement.value;
        
        // Fetch chart data (includes latest price points and cache metadata)
        const result = await fetchBTCChartData(currency);
        
        // Extract the most recent price from chart data
        if (result && result.data && result.data.prices && result.data.prices.length > 0) {
            const chartData = result.data;
            
            // Chart data format: [[timestamp, price], [timestamp, price], ...]
            // Get the last price point (most recent)
            const lastPricePoint = chartData.prices[chartData.prices.length - 1];
            const newPrice = lastPricePoint[1]; // [timestamp, price]
            const timestamp = lastPricePoint[0]; // timestamp
            
            // Update sell price field
            sellPriceElement.value = formatPrice(newPrice);
            
            // Add the new price point to the chart
            addPricePointToChart(newPrice, timestamp);
            
            // Update timestamp with cache metadata
            updateLastUpdateTime(result.cacheMetadata);
            
            // Recalculate if results are visible
            if (areResultsVisible()) {
                calculate();
            }
            
            // Update transactions table
            await renderTransactions();
        }
    } finally {
        isRefreshing = false;
    }
}

/**
 * Start auto-refresh timer
 */
function startAutoRefresh() {
    // Clear any existing timer
    stopAutoRefresh();
    
    // Start new timer with error handling wrapper
    autoRefreshTimer = setInterval(async () => {
        try {
            await refreshChartAndPrice();
        } catch (error) {
            console.error('Auto-refresh failed:', error);
            // Continue running timer even if one refresh fails
        }
    }, AUTO_REFRESH_INTERVAL);
    autoRefreshEnabled = true;
    
    console.log('Auto-refresh started (every 5 minutes)');
}

/**
 * Stop auto-refresh timer
 */
function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
    autoRefreshEnabled = false;
    
    console.log('Auto-refresh stopped');
}

/**
 * Toggle auto-refresh on/off
 */
function toggleAutoRefresh() {
    const toggleButton = document.getElementById('autoRefreshToggle');
    
    if (!toggleButton) {
        console.warn('Auto-refresh toggle button not found');
        return;
    }
    
    if (autoRefreshEnabled) {
        stopAutoRefresh();
        toggleButton.setAttribute('aria-checked', 'false');
        setCookie('crypto_calc_autoRefresh', 'false', 365);
    } else {
        startAutoRefresh();
        toggleButton.setAttribute('aria-checked', 'true');
        setCookie('crypto_calc_autoRefresh', 'true', 365);
    }
}

/**
 * Load auto-refresh preference from cookie
 */
function loadAutoRefreshPreference() {
    const savedPreference = getCookie('crypto_calc_autoRefresh');
    const toggleButton = document.getElementById('autoRefreshToggle');
    
    if (!toggleButton) {
        console.warn('Auto-refresh toggle button not found');
        return;
    }
    
    // Default to false if no preference saved
    if (savedPreference === 'true') {
        startAutoRefresh();
        toggleButton.setAttribute('aria-checked', 'true');
    } else {
        toggleButton.setAttribute('aria-checked', 'false');
    }
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

// ========== EXPORT/IMPORT FUNCTIONALITY ==========

/**
 * Get current values from DOM elements
 * @returns {object} Object with current form values
 */
function getValuesFromDOM() {
    const values = {};
    
    // Get form values from DOM
    const investmentEl = document.getElementById('investment');
    const buyPriceEl = document.getElementById('buyPrice');
    const feeEl = document.getElementById('fee');
    const currencyEl = document.getElementById('currency');
    
    if (investmentEl && investmentEl.value) {
        values.investment = investmentEl.value;
    }
    if (buyPriceEl && buyPriceEl.value) {
        values.buyPrice = buyPriceEl.value;
    }
    if (feeEl && feeEl.value) {
        values.fee = feeEl.value;
    }
    if (currencyEl && currencyEl.value) {
        values.currency = currencyEl.value;
    }
    
    // Get dark mode state from DOM (check if 'dark' class is present on html element)
    const isDarkMode = document.documentElement.classList.contains('dark');
    values.darkMode = isDarkMode.toString();
    
    // Get auto-refresh state from toggle button
    const autoRefreshToggle = document.getElementById('autoRefreshToggle');
    if (autoRefreshToggle) {
        const isEnabled = autoRefreshToggle.getAttribute('aria-checked') === 'true';
        values.autoRefresh = isEnabled.toString();
    }
    
    return values;
}

/**
 * Export all stored data (cookies and localStorage) as a base64-encoded string
 * If consent is not granted, reads current values from DOM instead
 * @returns {string} Base64-encoded JSON string containing all data
 */
function exportData() {
    try {
        const data = {
            version: 1, // For future compatibility
            timestamp: new Date().toISOString(),
            cookies: {},
            localStorage: {}
        };
        
        const consentGranted = hasConsent();
        
        if (consentGranted) {
            // Export cookies (all crypto_calc_* cookies except consent)
            const cookieNames = ['darkMode', 'autoRefresh', 'investment', 'buyPrice', 'fee', 'currency'];
            cookieNames.forEach(name => {
                const fullName = `crypto_calc_${name}`;
                const value = getCookie(fullName);
                if (value !== null) {
                    data.cookies[name] = value;
                }
            });
            
            // Export localStorage (consent and transactions)
            try {
                const consent = localStorage.getItem('crypto_calc_consent');
                if (consent) {
                    data.localStorage.consent = consent;
                }
                
                const transactions = localStorage.getItem('crypto_calc_transactions');
                if (transactions) {
                    data.localStorage.transactions = transactions;
                }
            } catch (e) {
                console.warn('Could not access localStorage for export:', e);
            }
        } else {
            // If consent not granted, read current values from DOM
            const domValues = getValuesFromDOM();
            Object.assign(data.cookies, domValues);
            
            // Note: transactions won't be available without consent
            // as they require localStorage
        }
        
        // Convert to JSON and then to base64
        const jsonString = JSON.stringify(data);
        // Use modern approach for UTF-8 encoding before base64
        const utf8Bytes = new TextEncoder().encode(jsonString);
        const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
        const base64String = btoa(binaryString);
        
        return base64String;
    } catch (e) {
        console.error('Failed to export data:', e);
        throw new Error('Failed to export data. Please try again.');
    }
}

/**
 * Import data from a base64-encoded string
 * @param {string} base64String - Base64-encoded JSON string containing data to import
 * @returns {boolean} True if import was successful
 */
function importData(base64String) {
    try {
        // Validate input
        if (!base64String || typeof base64String !== 'string') {
            throw new Error('Invalid import data');
        }
        
        // Decode base64 and parse JSON using modern approach
        const binaryString = atob(base64String.trim());
        const utf8Bytes = Uint8Array.from(binaryString, char => char.charCodeAt(0));
        const jsonString = new TextDecoder().decode(utf8Bytes);
        const data = JSON.parse(jsonString);
        
        // Validate data structure
        if (!data.version || !data.cookies || !data.localStorage) {
            throw new Error('Invalid data format');
        }
        
        // Import cookies
        Object.keys(data.cookies).forEach(name => {
            const fullName = `crypto_calc_${name}`;
            setCookie(fullName, data.cookies[name], 365);
        });
        
        // Import localStorage
        try {
            if (data.localStorage.consent) {
                localStorage.setItem('crypto_calc_consent', data.localStorage.consent);
            }
            
            if (data.localStorage.transactions) {
                localStorage.setItem('crypto_calc_transactions', data.localStorage.transactions);
            }
        } catch (e) {
            console.warn('Could not access localStorage for import:', e);
        }
        
        return true;
    } catch (e) {
        console.error('Failed to import data:', e);
        throw new Error('Failed to import data. Please check the format and try again.');
    }
}

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} True if copy was successful
 */
async function copyToClipboard(text) {
    try {
        // Modern clipboard API
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        
        return successful;
    } catch (e) {
        console.error('Failed to copy to clipboard:', e);
        return false;
    }
}

/**
 * Share text using Web Share API (mobile)
 * @param {string} text - Text to share
 * @returns {Promise<boolean>} True if share was successful
 */
async function shareText(text) {
    try {
        if (navigator.share) {
            await navigator.share({
                title: 'Crypto Calculator Data',
                text: text
            });
            return true;
        }
        return false;
    } catch (e) {
        // User cancelled or share failed
        console.log('Share cancelled or failed:', e);
        return false;
    }
}

/**
 * Download data as a file
 * @param {string} data - Data to download
 * @param {string} filename - Name of the file
 */
function downloadFile(data, filename) {
    try {
        // Create a blob from the data
        const blob = new Blob([data], { type: 'text/plain' });
        
        // Create a temporary URL for the blob
        const url = URL.createObjectURL(blob);
        
        // Create a temporary anchor element
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        
        // Append to document, click, and remove
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        // Release the URL
        URL.revokeObjectURL(url);
        
        return true;
    } catch (e) {
        console.error('Failed to download file:', e);
        return false;
    }
}

/**
 * Handle share button click - shares data via clipboard or Web Share API
 */
async function handleShare() {
    try {
        const exportedData = exportData();
        
        // Try to share using Web Share API first (works on mobile and some desktop browsers)
        if (navigator.share) {
            try {
                const shared = await shareText(exportedData);
                if (shared) {
                    alert('Data ready to share!');
                    return;
                }
                // If shareText returns false, fall through to clipboard
                console.log('Share not supported, trying clipboard');
            } catch (e) {
                // User cancelled or error occurred, fall through to clipboard
                console.log('Share cancelled or failed, trying clipboard:', e.message);
            }
        }
        
        // Fallback to copy to clipboard
        const copied = await copyToClipboard(exportedData);
        if (copied) {
            alert('Data copied to clipboard!\n\nYou can now paste it to save or share.');
        } else {
            // Last resort: show in a dialog for manual copy
            const message = 'Copy this data to save or share:\n\n' + exportedData;
            prompt(message, exportedData);
        }
    } catch (e) {
        alert(e.message || 'Failed to share data');
    }
}

/**
 * Handle download button click - downloads data as a file
 */
async function handleDownload() {
    try {
        const exportedData = exportData();
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `crypto-calculator-data-${timestamp}.txt`;
        
        // Try to download the file
        const downloaded = downloadFile(exportedData, filename);
        
        if (downloaded) {
            alert('Data downloaded successfully!\n\nFile: ' + filename);
        } else {
            // Fallback: try to copy to clipboard instead
            const copied = await copyToClipboard(exportedData);
            if (copied) {
                alert('Download not supported by your browser.\n\nData copied to clipboard instead!');
            } else {
                // Last resort: show in a dialog for manual copy
                const message = 'Copy this data to save:\n\n' + exportedData;
                prompt(message, exportedData);
            }
        }
    } catch (e) {
        alert(e.message || 'Failed to download data');
    }
}

/**
 * Handle export button click (legacy - kept for compatibility)
 */
async function handleExport() {
    try {
        const exportedData = exportData();
        
        // Export always returns a valid base64 string
        // No need to check length as it will always have at least the structure
        
        // Try to share using Web Share API first (works on mobile and some desktop browsers)
        if (navigator.share) {
            try {
                const shared = await shareText(exportedData);
                if (shared) {
                    alert('Data exported and ready to share!');
                    return;
                }
                // If shareText returns false, fall through to clipboard
                console.log('Share not supported, trying clipboard');
            } catch (e) {
                // User cancelled or error occurred, fall through to clipboard
                console.log('Share cancelled or failed, trying clipboard:', e.message);
            }
        }
        
        // Fallback to copy to clipboard
        const copied = await copyToClipboard(exportedData);
        if (copied) {
            alert('Data exported and copied to clipboard!\n\nYou can now paste it to save or share.');
        } else {
            // Last resort: show in a dialog for manual copy
            const message = 'Copy this data to save or share:\n\n' + exportedData;
            prompt(message, exportedData);
        }
    } catch (e) {
        alert(e.message || 'Failed to export data');
    }
}

/**
 * Handle import button click
 */
function handleImport() {
    // Check for consent first
    if (!hasConsent()) {
        alert('Please accept cookie consent first before importing data.');
        return;
    }
    
    const data = prompt('Paste your exported data here:');
    
    if (!data) {
        return; // User cancelled
    }
    
    try {
        const success = importData(data);
        if (success) {
            alert('Data imported successfully! The page will now reload to apply the changes.');
            window.location.reload();
        }
    } catch (e) {
        alert(e.message || 'Failed to import data');
    }
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
    // Use setCurrency to synchronize all three currency elements
    setCurrency(currency, false);

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

// Cache for currency formatters to improve performance
const formatterCache = new Map();
// Cache for currency symbol length check results
const symbolLengthCache = new Map();

/**
 * Get or create a cached formatter
 * @param {string} locale - The target locale
 * @param {string} currencyCode - The 3-letter currency code
 * @param {number} minFractionDigits - Minimum fraction digits
 * @param {number} maxFractionDigits - Maximum fraction digits
 * @param {boolean} isCurrency - Whether to create a currency formatter or number formatter
 * @returns {Intl.NumberFormat} The cached or new formatter
 */
function getOrCreateFormatter(locale, currencyCode, minFractionDigits, maxFractionDigits, isCurrency) {
    const key = `${locale}|${currencyCode}|${minFractionDigits}|${maxFractionDigits}|${isCurrency}`;
    
    if (!formatterCache.has(key)) {
        const options = {
            minimumFractionDigits: minFractionDigits,
            maximumFractionDigits: maxFractionDigits
        };
        
        if (isCurrency) {
            options.style = 'currency';
            options.currency = currencyCode;
            options.currencyDisplay = 'symbol';
        }
        
        formatterCache.set(key, new Intl.NumberFormat(locale, options));
    }
    
    return formatterCache.get(key);
}

/**
 * Check if currency symbol is multi-character (cached)
 * @param {string} locale - The target locale
 * @param {string} currencyCode - The 3-letter currency code
 * @returns {boolean} True if symbol is multi-character, false otherwise
 */
function isMultiCharSymbol(locale, currencyCode) {
    const key = `${locale}|${currencyCode}`;
    
    if (!symbolLengthCache.has(key)) {
        // Create a temporary formatter to check symbol length once
        const formatter = new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: currencyCode,
            currencyDisplay: 'symbol'
        });
        
        const parts = formatter.formatToParts(100);
        const currencyPart = parts.find(part => part.type === 'currency');
        const isMultiChar = currencyPart && currencyPart.value.length > 1;
        
        symbolLengthCache.set(key, isMultiChar);
    }
    
    return symbolLengthCache.get(key);
}

/**
 * Formats a number as currency, falling back to a plain number 
 * if the currency symbol is not a single character.
 * @param {number} value - The number to format.
 * @param {string} locale - The target locale (e.g., 'en-US', 'ro-RO').
 * @param {string} currencyCode - The 3-letter currency code (e.g., 'USD', 'RON').
 * @param {number} minFractionDigits - Minimum fraction digits (default: 2).
 * @param {number} maxFractionDigits - Maximum fraction digits (default: 2).
 * @returns {string} The formatted string.
 */
function formatCurrencyConditionally(value, locale, currencyCode, minFractionDigits = 2, maxFractionDigits = 2) {
    // Check if symbol is multi-character (cached result)
    if (isMultiCharSymbol(locale, currencyCode)) {
        // Fallback: Return only the number formatted according to the locale
        const numberFormatter = getOrCreateFormatter(locale, currencyCode, minFractionDigits, maxFractionDigits, false);
        return numberFormatter.format(value);
    } else {
        // Use standard currency formatting (includes the single-character symbol)
        const formatter = getOrCreateFormatter(locale, currencyCode, minFractionDigits, maxFractionDigits, true);
        return formatter.format(value);
    }
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
        return false; // Don't save to localStorage without consent
    }
    try {
        localStorage.setItem('crypto_calc_transactions', JSON.stringify(transactions));
        return true;
    } catch (e) {
        console.error('Failed to save transactions:', e);
        return false;
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
    
    // Calculate effective coins to sell accounting for sell fee
    // This represents the coins minus the portion that goes to fees
    const coinsToSellForProfit = coinsPurchased * feeMultiplier;
    
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
        
        // Check if break even amount is greater than coins purchased
        const isBreakEvenExceedingCoins = coinsToSellBreakEven > coinsPurchased;
        const breakEvenClass = isBreakEvenExceedingCoins ? 'text-orange-600 dark:text-orange-400' : '';
        
        // Calculate remaining coins after break even sell
        const remainingCoins = coinsPurchased - coinsToSellBreakEven;
        const breakEvenTooltip = `Remaining after sell: ${remainingCoins.toFixed(8)} coins`;
        
        const row = document.createElement('tr');
        row.className = 'border-b dark:border-gray-600';
        row.innerHTML = `
            <td class="py-2 px-2">${formatTransactionCurrency(tx.investment, tx.currency)}</td>
            <td class="py-2 px-2">${formatTransactionCurrency(tx.buyPrice, tx.currency)}</td>
            <td class="py-2 px-2">${coinsPurchased.toFixed(8)}</td>
            <td class="py-2 px-2 ${breakEvenClass}" title="${breakEvenTooltip}">${coinsToSellBreakEven.toFixed(8)}</td>
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
            // Add the new price point to the chart (partial update)
            addPricePointToChart(newPrice);
            // Update timestamp
            updateLastUpdateTime();
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
        const sellPriceElement = document.getElementById('sellPrice');
        
        // Fetch new chart data
        const result = await fetchBTCChartData(currency);
        
        // Update the chart
        await initPriceChart(currency);
        
        // Extract and update sell price from chart data
        if (result && result.data && result.data.prices && result.data.prices.length > 0 && sellPriceElement) {
            const lastPricePoint = result.data.prices[result.data.prices.length - 1];
            const newPrice = lastPricePoint[1];
            sellPriceElement.value = formatPrice(newPrice);
        }
        
        // Update timestamp with cache metadata
        if (result && result.cacheMetadata) {
            updateLastUpdateTime(result.cacheMetadata);
        } else {
            updateLastUpdateTime();
        }
    });

    // Auto-refresh toggle handler
    document.getElementById('autoRefreshToggle').addEventListener('click', function() {
        toggleAutoRefresh();
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
        const saved = saveTransactions(transactions);
        
        if (saved) {
            alert('Transaction saved successfully!');
            renderTransactions();
        } else {
            alert('Failed to save transaction. Your browser may have localStorage disabled or full. Please check your browser settings.');
        }
    });

    // Clear all transactions
    document.getElementById('clearAllTransactions').addEventListener('click', function() {
        if (confirm('Are you sure you want to delete all saved transactions?')) {
            const cleared = saveTransactions([]);
            if (cleared) {
                alert('All transactions cleared successfully!');
                renderTransactions();
            } else {
                alert('Failed to clear transactions. Your browser may have localStorage disabled. Please check your browser settings.');
            }
        }
    });

    // Initialize searchable currency dropdown
    initCurrencyDropdown();
}

/**
 * Set currency value and synchronize all currency-related DOM elements
 * This function ensures that currencySearch, currencyMobile, and currency (hidden input)
 * are all properly synchronized
 * @param {string} currencyCode - The 3-letter currency code (e.g., 'USD', 'EUR')
 * @param {boolean} triggerChange - Whether to trigger change event on hidden input (default: false)
 */
function setCurrency(currencyCode, triggerChange = false) {
    const searchInput = document.getElementById('currencySearch');
    const mobileSelect = document.getElementById('currencyMobile');
    const hiddenInput = document.getElementById('currency');
    const dropdown = document.getElementById('currencyDropdown');
    
    if (!hiddenInput) {
        console.warn('Currency hidden input not found');
        return;
    }
    
    // Update hidden input (the source of truth)
    hiddenInput.value = currencyCode;
    
    // Update mobile select
    if (mobileSelect) {
        mobileSelect.value = currencyCode;
    }
    
    // Update desktop search input and selected state
    if (searchInput && dropdown) {
        const options = dropdown.querySelectorAll('.currency-option');
        // Find matching option by iterating to avoid attribute injection
        const matchingOption = Array.from(options).find(opt => opt.getAttribute('data-value') === currencyCode);
        if (matchingOption) {
            searchInput.value = matchingOption.textContent;
            // Update selected state
            options.forEach(opt => opt.classList.remove('selected'));
            matchingOption.classList.add('selected');
        }
    }
    
    // Trigger change event if requested
    if (triggerChange) {
        const event = new Event('change', { bubbles: true });
        hiddenInput.dispatchEvent(event);
    }
}

/**
 * Initialize searchable currency dropdown functionality
 */
function initCurrencyDropdown() {
    const searchInput = document.getElementById('currencySearch');
    const dropdown = document.getElementById('currencyDropdown');
    const mobileSelect = document.getElementById('currencyMobile');
    const hiddenInput = document.getElementById('currency');
    const options = dropdown.querySelectorAll('.currency-option');

    // Function to sync desktop searchable input with current currency value
    function syncDesktopInput() {
        const currentValue = hiddenInput.value;
        // Use setCurrency without triggering change event (sync only)
        setCurrency(currentValue, false);
    }

    // Set initial display value for desktop
    syncDesktopInput();

    // Handle mobile select change
    mobileSelect.addEventListener('change', function() {
        // Use setCurrency to synchronize all elements and trigger change event
        setCurrency(this.value, true);
    });

    // Sync desktop input when viewport changes (e.g., switching to desktop mode)
    // Use matchMedia to detect when the media query changes
    // Using min-width: 769px to match CSS breakpoint (max-width: 768px)
    const mediaQuery = window.matchMedia('(min-width: 769px)');
    function handleViewportChange(e) {
        if (e.matches) {
            // Switched to desktop view, sync the input
            syncDesktopInput();
        }
    }
    // Modern browsers support addEventListener
    mediaQuery.addEventListener('change', handleViewportChange);

    // Show dropdown when input is focused (desktop only)
    searchInput.addEventListener('focus', function() {
        dropdown.classList.add('show');
        searchInput.select();
    });

    // Filter options based on search text (desktop only)
    searchInput.addEventListener('input', function() {
        const searchText = this.value.toLowerCase();
        
        options.forEach(option => {
            const text = option.textContent.toLowerCase();
            // Match anywhere in the text (currency code or name)
            if (text.includes(searchText)) {
                option.classList.remove('hidden');
            } else {
                option.classList.add('hidden');
            }
        });

        dropdown.classList.add('show');
    });

    // Handle option selection (desktop only)
    options.forEach(option => {
        option.addEventListener('click', function() {
            const value = this.getAttribute('data-value');

            // Use setCurrency to synchronize all elements and trigger change event
            setCurrency(value, true);

            // Hide dropdown
            dropdown.classList.remove('show');
        });
    });

    // Close dropdown when clicking outside (desktop only)
    document.addEventListener('click', function(e) {
        if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.remove('show');
            // Restore selected value if user clicked away
            const selectedOption = dropdown.querySelector('.currency-option.selected');
            if (selectedOption) {
                searchInput.value = selectedOption.textContent;
            }
            // Reset filter
            options.forEach(option => option.classList.remove('hidden'));
        }
    });

    // Handle keyboard navigation (desktop only)
    searchInput.addEventListener('keydown', function(e) {
        const visibleOptions = Array.from(options).filter(opt => !opt.classList.contains('hidden'));
        const currentIndex = visibleOptions.findIndex(opt => opt.classList.contains('selected'));

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!dropdown.classList.contains('show')) {
                dropdown.classList.add('show');
            } else if (currentIndex < visibleOptions.length - 1) {
                options.forEach(opt => opt.classList.remove('selected'));
                visibleOptions[currentIndex + 1].classList.add('selected');
                visibleOptions[currentIndex + 1].scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (currentIndex > 0) {
                options.forEach(opt => opt.classList.remove('selected'));
                visibleOptions[currentIndex - 1].classList.add('selected');
                visibleOptions[currentIndex - 1].scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const selectedOption = dropdown.querySelector('.currency-option.selected');
            if (selectedOption && !selectedOption.classList.contains('hidden')) {
                selectedOption.click();
            }
        } else if (e.key === 'Escape') {
            dropdown.classList.remove('show');
            const selectedOption = dropdown.querySelector('.currency-option.selected');
            if (selectedOption) {
                searchInput.value = selectedOption.textContent;
            }
            options.forEach(option => option.classList.remove('hidden'));
        }
    });
}

/**
 * Mobile detection is now handled via CSS media queries in index.html
 * This ensures proper behavior when users switch to desktop mode on mobile devices
 */

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
    // Update the last update timestamp
    updateLastUpdateTime();
    // Load auto-refresh preference
    loadAutoRefreshPreference();
    // Do not calculate on initial load - wait for user interaction
    await renderTransactions();
});
