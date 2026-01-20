import { config, validateConfig } from './config';
import { telegramBot } from './bot/telegram-bot';
import { sniperEngine } from './services/sniper-engine';
import { logger } from './utils/logger';

// ==========================================
// MAIN APPLICATION
// ==========================================
async function main(): Promise<void> {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║     FC26 ULTIMATE SNIPER BOT v1.0.0       ║
  ║         Professional Trading Bot           ║
  ╚═══════════════════════════════════════════╝
  `);

  try {
    // Validate configuration
    logger.info('Validating configuration...');
    validateConfig();
    logger.info('✅ Configuration valid');

    // Initialize services
    logger.info('Initializing services...');
    
    // Start Telegram bot
    logger.info('Starting Telegram bot...');
    await telegramBot.start();
    logger.info('✅ Telegram bot started');

    // Setup graceful shutdown
    setupGracefulShutdown();

    logger.info('🚀 FC26 Ultimate Sniper Bot is running!');
    logger.info(`Environment: ${config.logging.nodeEnv}`);

  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);

    try {
      // Stop all sniper sessions
      const sessions = sniperEngine.getAllSessions();
      for (const session of sessions) {
        await sniperEngine.stopSession(session.accountId);
      }
      logger.info('✅ All sniper sessions stopped');

      logger.info('👋 Goodbye!');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
}

// ==========================================
// START
// ==========================================
main();
