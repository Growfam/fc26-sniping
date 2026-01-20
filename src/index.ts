/**
 * FC26 Sniper Bot - Entry Point
 */

import { config, validateConfig } from './config';
import { TelegramBot } from './bot/telegram-bot';
import { logger } from './utils/logger';

async function main() {
  try {
    logger.info('🚀 Starting FC26 Sniper Bot v2.0...');
    
    // Validate configuration
    validateConfig();
    logger.info('✅ Configuration validated');

    // Initialize Telegram bot
    const bot = new TelegramBot();
    await bot.launch();
    
    logger.info('✅ Bot launched successfully!');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received. Shutting down...`);
      bot.stop(signal);
      process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

main();
