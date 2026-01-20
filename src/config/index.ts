import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean)
  },

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    serviceKey: process.env.SUPABASE_SERVICE_KEY!
  },

  // EA FC
  ea: {
    baseUrl: process.env.EA_BASE_URL || 'https://utas.mob.v1.fut.ea.com',
    webAppUrl: process.env.EA_WEB_APP_URL || 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app'
  },

  // Trading
  trading: {
    minSearchDelay: parseInt(process.env.MIN_SEARCH_DELAY || '2000'),
    maxSearchDelay: parseInt(process.env.MAX_SEARCH_DELAY || '4000'),
    maxPurchasesPerHour: parseInt(process.env.MAX_PURCHASES_PER_HOUR || '50'),
    minProfitMargin: parseFloat(process.env.MIN_PROFIT_MARGIN || '5'),
    maxRequestsPerHour: parseInt(process.env.MAX_REQUESTS_PER_HOUR || '400')
  },

  // Price Sources
  prices: {
    futbinEnabled: process.env.FUTBIN_ENABLED === 'true',
    futggEnabled: process.env.FUTGG_ENABLED === 'true',
    cacheTTL: parseInt(process.env.PRICE_CACHE_TTL || '300')
  },

  // Security
  security: {
    encryptionKey: process.env.ENCRYPTION_KEY!,
    jwtSecret: process.env.JWT_SECRET!
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    nodeEnv: process.env.NODE_ENV || 'development'
  }
};

// Валідація конфігурації
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
}
