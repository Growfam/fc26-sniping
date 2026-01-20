/**
 * FC26 Sniper Bot Configuration
 * Updated with Anti-Ban and Captcha settings
 */

import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // ==========================================
  // TELEGRAM
  // ==========================================
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean)
  },

  // ==========================================
  // SUPABASE
  // ==========================================
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    serviceKey: process.env.SUPABASE_SERVICE_KEY!
  },

  // ==========================================
  // EA FC
  // ==========================================
  ea: {
    baseUrl: process.env.EA_BASE_URL || 'https://utas.mob.v1.fut.ea.com',
    webAppUrl: process.env.EA_WEB_APP_URL || 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app'
  },

  // ==========================================
  // ANTI-BAN SETTINGS (CRITICAL!)
  // ==========================================
  antiBan: {
    // Delays (milliseconds) - based on MagicBuyer-UT recommendations
    searchDelay: {
      min: parseInt(process.env.SEARCH_DELAY_MIN || '7000'),   // 7 seconds
      max: parseInt(process.env.SEARCH_DELAY_MAX || '15000')   // 15 seconds
    },
    buyDelay: {
      min: parseInt(process.env.BUY_DELAY_MIN || '1000'),      // 1 second
      max: parseInt(process.env.BUY_DELAY_MAX || '3000')       // 3 seconds
    },
    actionDelay: {
      min: parseInt(process.env.ACTION_DELAY_MIN || '500'),    // 0.5 seconds
      max: parseInt(process.env.ACTION_DELAY_MAX || '1500')    // 1.5 seconds
    },

    // Limits - based on futapi/fut guidelines
    maxSearchesPerHour: parseInt(process.env.MAX_SEARCHES_PER_HOUR || '350'),
    maxPurchasesPerHour: parseInt(process.env.MAX_PURCHASES_PER_HOUR || '25'),
    maxRequestsPerHour: parseInt(process.env.MAX_REQUESTS_PER_HOUR || '400'),
    maxRequestsPerDay: parseInt(process.env.MAX_REQUESTS_PER_DAY || '5000'),

    // Session management
    sessionDurationMs: parseInt(process.env.SESSION_DURATION_MS || '5400000'),      // 1.5 hours
    pauseBetweenSessionsMs: parseInt(process.env.PAUSE_BETWEEN_SESSIONS_MS || '1800000'), // 30 minutes

    // Cycle pauses
    pauseAfterSearches: parseInt(process.env.PAUSE_AFTER_SEARCHES || '50'),
    cyclePauseDuration: {
      min: parseInt(process.env.CYCLE_PAUSE_MIN || '30000'),   // 30 seconds
      max: parseInt(process.env.CYCLE_PAUSE_MAX || '60000')    // 60 seconds
    },

    // Night mode
    nightModeEnabled: process.env.NIGHT_MODE_ENABLED !== 'false',
    nightModeStart: parseInt(process.env.NIGHT_MODE_START || '2'),  // 02:00
    nightModeEnd: parseInt(process.env.NIGHT_MODE_END || '8'),      // 08:00

    // Error handling
    stopOnErrorCodes: (process.env.STOP_ON_ERROR_CODES || '421,429,458,461,512')
      .split(',').map(c => parseInt(c.trim())).filter(Boolean),
    maxConsecutiveErrors: parseInt(process.env.MAX_CONSECUTIVE_ERRORS || '5'),

    // Risk thresholds (percentage of limit)
    riskThresholds: {
      low: parseInt(process.env.RISK_THRESHOLD_LOW || '30'),
      medium: parseInt(process.env.RISK_THRESHOLD_MEDIUM || '60'),
      high: parseInt(process.env.RISK_THRESHOLD_HIGH || '85')
    }
  },

  // ==========================================
  // CAPTCHA SETTINGS
  // ==========================================
  captcha: {
    // Provider: 'anticaptcha', '2captcha', or 'manual'
    provider: process.env.CAPTCHA_PROVIDER || 'manual',
    apiKey: process.env.CAPTCHA_API_KEY || '',
    timeout: parseInt(process.env.CAPTCHA_TIMEOUT || '120000'),          // 2 minutes
    pollingInterval: parseInt(process.env.CAPTCHA_POLLING_INTERVAL || '5000') // 5 seconds
  },

  // ==========================================
  // TRADING (LEGACY - still used by sniper-engine)
  // ==========================================
  trading: {
    // These are now overridden by antiBan settings for better control
    minSearchDelay: parseInt(process.env.MIN_SEARCH_DELAY || '7000'),
    maxSearchDelay: parseInt(process.env.MAX_SEARCH_DELAY || '15000'),
    maxPurchasesPerHour: parseInt(process.env.MAX_PURCHASES_PER_HOUR || '25'),
    minProfitMargin: parseFloat(process.env.MIN_PROFIT_MARGIN || '5'),
    maxRequestsPerHour: parseInt(process.env.MAX_REQUESTS_PER_HOUR || '400')
  },

  // ==========================================
  // PRICE SOURCES
  // ==========================================
  prices: {
    futbinEnabled: process.env.FUTBIN_ENABLED === 'true',
    futggEnabled: process.env.FUTGG_ENABLED === 'true',
    cacheTTL: parseInt(process.env.PRICE_CACHE_TTL || '300')
  },

  // ==========================================
  // SECURITY
  // ==========================================
  security: {
    encryptionKey: process.env.ENCRYPTION_KEY!,
    jwtSecret: process.env.JWT_SECRET || ''
  },

  // ==========================================
  // LOGGING
  // ==========================================
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    nodeEnv: process.env.NODE_ENV || 'development'
  }
};

// ==========================================
// VALIDATION
// ==========================================

export function validateConfig(): void {
  const required = [
    'TELEGRAM_BOT_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_KEY',
    'ENCRYPTION_KEY'
  ];

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate Anti-Ban settings
  if (config.antiBan.searchDelay.min < 5000) {
    console.warn('⚠️ WARNING: Search delay minimum is very low (<5s). Risk of ban is HIGH!');
  }

  if (config.antiBan.maxSearchesPerHour > 500) {
    console.warn('⚠️ WARNING: Max searches per hour is above recommended limit (500). Risk of ban is HIGH!');
  }

  if (config.antiBan.maxRequestsPerDay > 5000) {
    console.warn('⚠️ WARNING: Max requests per day is above recommended limit (5000). Risk of ban is HIGH!');
  }

  // Validate Captcha settings
  if (config.captcha.provider !== 'manual' && !config.captcha.apiKey) {
    console.warn('⚠️ WARNING: Captcha API key not set. Captchas will require manual solving.');
  }
}

// ==========================================
// ENVIRONMENT TEMPLATE
// ==========================================

export const ENV_TEMPLATE = `
# ==========================================
# FC26 SNIPER BOT CONFIGURATION
# Copy to .env and fill in your values
# ==========================================

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ADMIN_IDS=123456789,987654321

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_KEY=your_service_key

# Security
ENCRYPTION_KEY=your_32_char_encryption_key_here

# ==========================================
# ANTI-BAN SETTINGS (RECOMMENDED VALUES)
# ==========================================

# Delays (milliseconds) - DON'T GO LOWER!
SEARCH_DELAY_MIN=7000
SEARCH_DELAY_MAX=15000
BUY_DELAY_MIN=1000
BUY_DELAY_MAX=3000
ACTION_DELAY_MIN=500
ACTION_DELAY_MAX=1500

# Limits - DON'T GO HIGHER!
MAX_SEARCHES_PER_HOUR=350
MAX_PURCHASES_PER_HOUR=25
MAX_REQUESTS_PER_HOUR=400
MAX_REQUESTS_PER_DAY=5000

# Session management
SESSION_DURATION_MS=5400000
PAUSE_BETWEEN_SESSIONS_MS=1800000

# Cycle pauses
PAUSE_AFTER_SEARCHES=50
CYCLE_PAUSE_MIN=30000
CYCLE_PAUSE_MAX=60000

# Night mode (auto-stop)
NIGHT_MODE_ENABLED=true
NIGHT_MODE_START=2
NIGHT_MODE_END=8

# Error handling
STOP_ON_ERROR_CODES=421,429,458,461,512
MAX_CONSECUTIVE_ERRORS=5

# Risk thresholds (percentage)
RISK_THRESHOLD_LOW=30
RISK_THRESHOLD_MEDIUM=60
RISK_THRESHOLD_HIGH=85

# ==========================================
# CAPTCHA SETTINGS
# ==========================================

# Provider: 'anticaptcha', '2captcha', or 'manual'
CAPTCHA_PROVIDER=manual
CAPTCHA_API_KEY=
CAPTCHA_TIMEOUT=120000
CAPTCHA_POLLING_INTERVAL=5000

# ==========================================
# PRICE SOURCES
# ==========================================

FUTBIN_ENABLED=true
FUTGG_ENABLED=true
PRICE_CACHE_TTL=300

# ==========================================
# LOGGING
# ==========================================

LOG_LEVEL=info
NODE_ENV=production
`;
