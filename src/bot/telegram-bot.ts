/**
 * FC26 Telegram Bot - Updated Version
 * 
 * New features:
 * - Full email/password authentication with 2FA
 * - Anti-Ban monitoring and controls
 * - Captcha handling
 * - Risk level display
 */

import { Telegraf, Context, Markup } from 'telegraf';
import { config } from '../config';
import { db, User, EAAccount, SniperFilter } from '../database';
import { sniperEngine, SniperSession } from '../services/sniper-engine';
import { priceService } from '../services/price-service';
import { EAAPI, EAAPIFactory } from '../services/ea-api';
import { eaAuthManager, EASession, AuthCookies } from '../services/ea-auth';
import { antiBanService, RiskLevel } from '../services/anti-ban';
import { captchaSolver, eaCaptchaHandler } from '../services/captcha-solver';
import { logger } from '../utils/logger';

// ==========================================
// CONTEXT EXTENSION
// ==========================================

interface BotContext extends Context {
  user?: User;
}

// ==========================================
// TELEGRAM BOT
// ==========================================

export class TelegramBot {
  private bot: Telegraf<BotContext>;
  private userStates: Map<number, { step: string; data: any }> = new Map();
  private pending2FACodes: Map<number, (code: string) => void> = new Map();

  constructor() {
    this.bot = new Telegraf<BotContext>(config.telegram.botToken);
    this.setupMiddleware();
    this.setupCommands();
    this.setupCallbacks();
    this.setupSniperEvents();
    this.setupAntiBanEvents();
    this.setupCaptchaEvents();
  }

  // ==========================================
  // MIDDLEWARE
  // ==========================================

  private setupMiddleware(): void {
    // Auth middleware
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return;

      try {
        ctx.user = await db.getOrCreateUser(ctx.from.id, ctx.from.username || null);
        await next();
      } catch (error) {
        logger.error('Auth middleware error:', error);
      }
    });

    // Logging middleware
    this.bot.use(async (ctx, next) => {
      const start = Date.now();
      await next();
      const ms = Date.now() - start;
      logger.info(`[${ctx.from?.id}] ${ctx.updateType} - ${ms}ms`);
    });
  }

  // ==========================================
  // COMMANDS
  // ==========================================

  private setupCommands(): void {
    // /start
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        `🎮 *FC26 Ultimate Sniper Bot v2.0*\n\n` +
        `Привіт, ${ctx.from?.first_name}! 👋\n\n` +
        `Цей бот допоможе тобі автоматично торгувати на ринку FC 26.\n\n` +
        `🆕 *Що нового:*\n` +
        `• Повна авторизація через email/password\n` +
        `• Автоматичний Anti-Ban захист\n` +
        `• Моніторинг ризику в реальному часі\n` +
        `• Підтримка капчі\n\n` +
        `📋 *Основні команди:*\n` +
        `/accounts - Керування EA акаунтами\n` +
        `/filters - Керування фільтрами\n` +
        `/start_sniper - Запустити снайпер\n` +
        `/stop_sniper - Зупинити снайпер\n` +
        `/status - Статус бота та Anti-Ban\n` +
        `/risk - Поточний рівень ризику\n` +
        `/settings - Налаштування Anti-Ban\n` +
        `/help - Допомога\n\n` +
        `🚀 Почнемо з додавання EA акаунту!`,
        { parse_mode: 'Markdown', ...this.getMainKeyboard() }
      );
    });

    // /accounts
    this.bot.command('accounts', async (ctx) => {
      await this.showAccounts(ctx);
    });

    // /add_account - NEW with full auth
    this.bot.command('add_account', async (ctx) => {
      await this.startAddAccount(ctx);
    });

    // /login - Login with email/password
    this.bot.command('login', async (ctx) => {
      await this.startFullLogin(ctx);
    });

    // /filters
    this.bot.command('filters', async (ctx) => {
      await this.showFilters(ctx);
    });

    // /start_sniper
    this.bot.command('start_sniper', async (ctx) => {
      await this.startSniper(ctx);
    });

    // /stop_sniper
    this.bot.command('stop_sniper', async (ctx) => {
      await this.stopSniper(ctx);
    });

    // /status - Updated with Anti-Ban info
    this.bot.command('status', async (ctx) => {
      await this.showStatus(ctx);
    });

    // /risk - NEW: Show risk levels
    this.bot.command('risk', async (ctx) => {
      await this.showRiskLevels(ctx);
    });

    // /settings - NEW: Anti-Ban settings
    this.bot.command('settings', async (ctx) => {
      await this.showSettings(ctx);
    });

    // /stats
    this.bot.command('stats', async (ctx) => {
      await this.showStats(ctx);
    });

    // /prices
    this.bot.command('prices', async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1).join(' ');
      if (!args) {
        await ctx.reply('❓ Введіть імʼя гравця: `/prices Mbappe`', { parse_mode: 'Markdown' });
        return;
      }
      await this.searchPrices(ctx, args);
    });

    // /help
    this.bot.command('help', async (ctx) => {
      await this.showHelp(ctx);
    });

    // /2fa - Submit 2FA code
    this.bot.command('2fa', async (ctx) => {
      const code = ctx.message.text.split(' ')[1];
      if (!code) {
        await ctx.reply('❓ Введіть 2FA код: `/2fa 123456`', { parse_mode: 'Markdown' });
        return;
      }
      await this.handle2FACode(ctx, code);
    });

    // /captcha - Submit captcha solution
    this.bot.command('captcha', async (ctx) => {
      const solution = ctx.message.text.split(' ').slice(1).join(' ');
      if (!solution) {
        await ctx.reply('❓ Введіть рішення капчі: `/captcha solution`', { parse_mode: 'Markdown' });
        return;
      }
      const success = captchaSolver.submitManualSolution(solution);
      await ctx.reply(success ? '✅ Капча відправлена!' : '❌ Немає активної капчі');
    });

    // Keyboard button handlers
    this.bot.hears('📱 Акаунти', async (ctx) => await this.showAccounts(ctx));
    this.bot.hears('🎯 Фільтри', async (ctx) => await this.showFilters(ctx));
    this.bot.hears('▶️ Старт', async (ctx) => await this.startSniper(ctx));
    this.bot.hears('⏹ Стоп', async (ctx) => await this.stopSniper(ctx));
    this.bot.hears('📊 Статус', async (ctx) => await this.showStatus(ctx));
    this.bot.hears('⚠️ Ризик', async (ctx) => await this.showRiskLevels(ctx));

    // Handle text messages for states
    this.bot.on('text', async (ctx) => {
      const state = this.userStates.get(ctx.from.id);
      if (state) {
        await this.handleState(ctx, state);
      }
    });
  }

  // ==========================================
  // CALLBACKS
  // ==========================================

  private setupCallbacks(): void {
    // Account selection
    this.bot.action(/^account_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const accountId = ctx.match[1];
      await this.showAccountDetails(ctx, accountId);
    });

    // Delete account
    this.bot.action(/^delete_account_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('✅ Акаунт видалено');
      const accountId = ctx.match[1];
      await db.deleteEAAccount(accountId);
      await this.showAccounts(ctx);
    });

    // Refresh session (new login)
    this.bot.action(/^refresh_session_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const accountId = ctx.match[1];
      await this.startRefreshSession(ctx, accountId);
    });

    // Update cookies (legacy)
    this.bot.action(/^update_cookies_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const accountId = ctx.match[1];
      this.userStates.set(ctx.from!.id, {
        step: 'update_cookies',
        data: { accountId }
      });
      await ctx.reply('🍪 Надішліть X-UT-SID:');
    });

    // Start/Stop sniper for account
    this.bot.action(/^start_sniper_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('🚀 Запуск...');
      const accountId = ctx.match[1];
      await this.startSniperForAccount(ctx, accountId);
    });

    this.bot.action(/^stop_sniper_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('⏹ Зупинка...');
      const accountId = ctx.match[1];
      await sniperEngine.stopSession(accountId);
      await this.showStatus(ctx);
    });

    // Filter callbacks
    this.bot.action(/^filter_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const filterId = ctx.match[1];
      await this.showFilterDetails(ctx, filterId);
    });

    this.bot.action(/^toggle_filter_(.+)_(.+)$/, async (ctx) => {
      const filterId = ctx.match[1];
      const newState = ctx.match[2] === 'on';
      await db.toggleFilter(filterId, newState);
      await ctx.answerCbQuery(newState ? '✅ Увімкнено' : '⏸ Вимкнено');
      await this.showFilters(ctx);
    });

    this.bot.action(/^delete_filter_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('✅ Видалено');
      const filterId = ctx.match[1];
      await db.deleteFilter(filterId);
      await this.showFilters(ctx);
    });

    // Platform selection
    this.bot.action(/^platform_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const platform = ctx.match[1] as 'ps' | 'xbox' | 'pc';
      const state = this.userStates.get(ctx.from!.id);
      
      if (state?.step === 'add_account_platform') {
        state.data.platform = platform;
        state.step = 'add_account_auth_method';

        await ctx.reply(
          '🔐 *Виберіть метод авторизації:*\n\n' +
          '1️⃣ *Повна авторизація* - email + пароль + 2FA\n' +
          '   ✅ Найбезпечніший варіант\n' +
          '   ✅ Автоматичне оновлення сесії\n\n' +
          '2️⃣ *Через SID* - тільки X-UT-SID\n' +
          '   ⚠️ Потребує ручного оновлення\n' +
          '   ⚠️ Сесія діє ~1 годину',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔐 Повна авторизація', 'auth_method_full')],
              [Markup.button.callback('🔑 Через SID', 'auth_method_sid')]
            ])
          }
        );
      }
    });

    // Auth method selection
    this.bot.action('auth_method_full', async (ctx) => {
      await ctx.answerCbQuery();
      const state = this.userStates.get(ctx.from!.id);
      if (state) {
        state.step = 'full_auth_email';
        await ctx.reply('📧 Введіть email вашого EA акаунту:');
      }
    });

    this.bot.action('auth_method_sid', async (ctx) => {
      await ctx.answerCbQuery();
      const state = this.userStates.get(ctx.from!.id);
      if (state) {
        state.step = 'add_account_cookies';
        await this.sendSIDInstructions(ctx);
      }
    });

    // Add account/filter buttons
    this.bot.action('add_account', async (ctx) => {
      await ctx.answerCbQuery();
      await this.startAddAccount(ctx);
    });

    this.bot.action('add_filter', async (ctx) => {
      await ctx.answerCbQuery();
      await this.startAddFilter(ctx);
    });

    // Account selection for filter
    this.bot.action(/^select_account_for_filter_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const accountId = ctx.match[1];
      const state = this.userStates.get(ctx.from!.id);
      if (state) {
        state.data.accountId = accountId;
        state.step = 'add_filter_name';
        await ctx.reply('📝 Введіть назву фільтра:');
      }
    });

    // Navigation
    this.bot.action('accounts', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showAccounts(ctx);
    });

    this.bot.action('filters', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showFilters(ctx);
    });

    this.bot.action('status', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showStatus(ctx);
    });

    // Anti-Ban settings
    this.bot.action('settings_antiban', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showAntiBanSettings(ctx);
    });

    this.bot.action('toggle_night_mode', async (ctx) => {
      await ctx.answerCbQuery();
      // Toggle night mode
      const currentConfig = antiBanService.getConfig();
      antiBanService.updateConfig({
        nightModeEnabled: !currentConfig.nightModeEnabled
      });
      await this.showAntiBanSettings(ctx);
    });
  }

  // ==========================================
  // SNIPER EVENTS
  // ==========================================

  private setupSniperEvents(): void {
    sniperEngine.on('item_purchased', async (data) => {
      const { accountId, item, buyPrice, sellPrice } = data;
      
      const accounts = await this.getAccountsByAccountId(accountId);
      if (!accounts.length) return;

      const user = await db.getUserByTelegramId(accounts[0].user_id as any);
      if (!user) return;

      const riskPercent = antiBanService.getRiskPercentage(accountId);
      const riskEmoji = riskPercent < 30 ? '🟢' : riskPercent < 60 ? '🟡' : '🔴';

      await this.bot.telegram.sendMessage(
        user.telegram_id,
        `✅ *Куплено!*\n\n` +
        `👤 ${EAAPI.getPlayerName(item)}\n` +
        `💰 Ціна: ${buyPrice.toLocaleString()} монет\n` +
        `🏷️ Продаж: ${sellPrice?.toLocaleString() || 'Auto'} монет\n\n` +
        `${riskEmoji} Ризик: ${riskPercent.toFixed(1)}%`,
        { parse_mode: 'Markdown' }
      );
    });

    sniperEngine.on('item_sold', async (data) => {
      const { accountId, item, sellPrice } = data;
      
      const accounts = await this.getAccountsByAccountId(accountId);
      if (!accounts.length) return;

      const user = await db.getUserByTelegramId(accounts[0].user_id as any);
      if (!user) return;

      await this.bot.telegram.sendMessage(
        user.telegram_id,
        `💰 *Продано!*\n\n` +
        `👤 ${EAAPI.getPlayerName(item)}\n` +
        `💵 Ціна: ${sellPrice.toLocaleString()} монет`,
        { parse_mode: 'Markdown' }
      );
    });

    sniperEngine.on('session_expired', async (data) => {
      const { accountId } = data;
      
      const accounts = await this.getAccountsByAccountId(accountId);
      if (!accounts.length) return;

      const user = await db.getUserByTelegramId(accounts[0].user_id as any);
      if (!user) return;

      await this.bot.telegram.sendMessage(
        user.telegram_id,
        `⚠️ *Сесія закінчилась!*\n\n` +
        `Потрібно оновити авторизацію.\n` +
        `Використайте /accounts → Оновити сесію`,
        { parse_mode: 'Markdown' }
      );
    });
  }

  // ==========================================
  // ANTI-BAN EVENTS
  // ==========================================

  private setupAntiBanEvents(): void {
    antiBanService.on('stats_updated', async (stats) => {
      // Check if approaching limits
      const riskPercent = antiBanService.getRiskPercentage(stats.accountId);
      
      if (riskPercent >= 80 && stats.currentRiskLevel !== RiskLevel.HIGH) {
        const accounts = await this.getAccountsByAccountId(stats.accountId);
        if (!accounts.length) return;

        const user = await db.getUserByTelegramId(accounts[0].user_id as any);
        if (!user) return;

        await this.bot.telegram.sendMessage(
          user.telegram_id,
          `🔴 *УВАГА: Високий ризик бану!*\n\n` +
          `Ризик: ${riskPercent.toFixed(1)}%\n` +
          `Рекомендуємо зупинити снайпер!`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    antiBanService.on('critical_error', async ({ accountId, errorCode }) => {
      const accounts = await this.getAccountsByAccountId(accountId);
      if (!accounts.length) return;

      const user = await db.getUserByTelegramId(accounts[0].user_id as any);
      if (!user) return;

      await this.bot.telegram.sendMessage(
        user.telegram_id,
        `🚨 *КРИТИЧНА ПОМИЛКА!*\n\n` +
        `Код: ${errorCode}\n` +
        `Снайпер автоматично зупинено.\n\n` +
        `Можливі причини:\n` +
        `• 429 - Занадто багато запитів\n` +
        `• 458 - Трансферний ринок заблоковано\n` +
        `• 512 - Ринок тимчасово недоступний`,
        { parse_mode: 'Markdown' }
      );
    });

    antiBanService.on('global_pause', async ({ durationMs }) => {
      // Notify all active users about pause
      const sessions = sniperEngine.getAllSessions();
      for (const session of sessions) {
        const accounts = await this.getAccountsByAccountId(session.accountId);
        if (!accounts.length) continue;

        const user = await db.getUserByTelegramId(accounts[0].user_id as any);
        if (!user) continue;

        await this.bot.telegram.sendMessage(
          user.telegram_id,
          `⏸ *Автоматична пауза*\n\n` +
          `Тривалість: ${Math.floor(durationMs / 60000)} хв\n` +
          `Причина: Досягнуто лімітів Anti-Ban`,
          { parse_mode: 'Markdown' }
        );
      }
    });
  }

  // ==========================================
  // CAPTCHA EVENTS
  // ==========================================

  private setupCaptchaEvents(): void {
    captchaSolver.on('manual_captcha_required', async ({ type, websiteURL }) => {
      // Notify all active users
      const sessions = sniperEngine.getAllSessions();
      for (const session of sessions) {
        const accounts = await this.getAccountsByAccountId(session.accountId);
        if (!accounts.length) continue;

        const user = await db.getUserByTelegramId(accounts[0].user_id as any);
        if (!user) continue;

        await this.bot.telegram.sendMessage(
          user.telegram_id,
          `🔐 *Потрібна капча!*\n\n` +
          `Тип: ${type}\n` +
          `URL: ${websiteURL}\n\n` +
          `Відкрийте Web App та пройдіть перевірку,\n` +
          `або введіть рішення: /captcha <solution>`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    captchaSolver.on('captcha_solved', async () => {
      // Notify users
      const sessions = sniperEngine.getAllSessions();
      for (const session of sessions) {
        const accounts = await this.getAccountsByAccountId(session.accountId);
        if (!accounts.length) continue;

        const user = await db.getUserByTelegramId(accounts[0].user_id as any);
        if (!user) continue;

        await this.bot.telegram.sendMessage(
          user.telegram_id,
          `✅ Капча розв'язана! Снайпер продовжує роботу.`,
          { parse_mode: 'Markdown' }
        );
      }
    });
  }

  // ==========================================
  // HANDLERS
  // ==========================================

  private async showAccounts(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);

    if (accounts.length === 0) {
      await ctx.reply(
        '📭 У вас немає EA акаунтів.\n\nДодайте перший акаунт:',
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Додати акаунт', 'add_account')]
        ])
      );
      return;
    }

    const buttons = accounts.map(acc => {
      const session = sniperEngine.getSession(acc.id);
      const statusIcon = session?.status === 'running' ? '🟢' : '⚪';
      return [
        Markup.button.callback(
          `${statusIcon} ${acc.platform.toUpperCase()} | ${acc.email} | ${acc.coins.toLocaleString()}💰`,
          `account_${acc.id}`
        )
      ];
    });

    buttons.push([Markup.button.callback('➕ Додати акаунт', 'add_account')]);

    await ctx.reply(
      `📱 *Ваші EA акаунти:*`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  }

  private async showAccountDetails(ctx: BotContext, accountId: string): Promise<void> {
    const accountData = await db.getEAAccountWithCookies(accountId);
    if (!accountData) {
      await ctx.reply('❌ Акаунт не знайдено');
      return;
    }

    const { account } = accountData;
    const session = sniperEngine.getSession(accountId);
    const riskPercent = antiBanService.getRiskPercentage(accountId);

    let statusText = '⏹ Зупинено';
    if (session) {
      switch (session.status) {
        case 'running': statusText = '🟢 Працює'; break;
        case 'paused': statusText = '⏸ Пауза'; break;
        case 'error': statusText = '🔴 Помилка'; break;
      }
    }

    const riskEmoji = riskPercent < 30 ? '🟢' : riskPercent < 60 ? '🟡' : '🔴';

    await ctx.editMessageText(
      `📱 *Акаунт: ${account.email}*\n\n` +
      `🎮 Платформа: ${account.platform.toUpperCase()}\n` +
      `💰 Монети: ${account.coins.toLocaleString()}\n` +
      `📊 Статус: ${statusText}\n` +
      `${riskEmoji} Ризик: ${riskPercent.toFixed(1)}%\n` +
      `🕐 Останній вхід: ${account.last_login ? new Date(account.last_login).toLocaleString('uk-UA') : 'Ніколи'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            session?.status === 'running'
              ? Markup.button.callback('⏹ Зупинити', `stop_sniper_${accountId}`)
              : Markup.button.callback('▶️ Запустити', `start_sniper_${accountId}`)
          ],
          [Markup.button.callback('🔄 Оновити сесію', `refresh_session_${accountId}`)],
          [Markup.button.callback('🔑 Оновити SID', `update_cookies_${accountId}`)],
          [Markup.button.callback('🗑 Видалити', `delete_account_${accountId}`)],
          [Markup.button.callback('« Назад', 'accounts')]
        ])
      }
    );
  }

  private async startAddAccount(ctx: BotContext): Promise<void> {
    this.userStates.set(ctx.from!.id, {
      step: 'add_account_email',
      data: {}
    });

    await ctx.reply('📧 Введіть email EA акаунту:');
  }

  private async startRefreshSession(ctx: BotContext, accountId: string): Promise<void> {
    const accountData = await db.getEAAccountWithCookies(accountId);
    if (!accountData) {
      await ctx.reply('❌ Акаунт не знайдено');
      return;
    }

    this.userStates.set(ctx.from!.id, {
      step: 'refresh_auth_password',
      data: { 
        accountId,
        email: accountData.account.email,
        platform: accountData.account.platform
      }
    });

    await ctx.reply(
      `🔐 *Оновлення сесії*\n\n` +
      `Email: ${accountData.account.email}\n\n` +
      `Введіть пароль від EA акаунту:`,
      { parse_mode: 'Markdown' }
    );
  }

  private async sendSIDInstructions(ctx: Context): Promise<void> {
    await ctx.reply(
      '🔑 *Як отримати X-UT-SID:*\n\n' +
      '1. Відкрийте EA FC Web App\n' +
      '2. Увійдіть в акаунт\n' +
      '3. Перейдіть на ТРАНСФЕРНИЙ РИНОК\n' +
      '4. Зробіть будь-який пошук\n' +
      '5. Натисніть F12 (DevTools)\n' +
      '6. Вкладка Network\n' +
      '7. Знайдіть запит до fut.ea.com\n' +
      '8. Скопіюйте X-UT-SID з Headers\n\n' +
      'SID виглядає так:\n' +
      '`f1888c19-c261-4e8c-b49e-1e202c4a872f`\n\n' +
      '📤 Надішліть X-UT-SID:',
      { parse_mode: 'Markdown' }
    );
  }

  private async showStatus(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);
    
    let statusText = '📊 *Статус бота*\n\n';

    for (const acc of accounts) {
      const session = sniperEngine.getSession(acc.id);
      const antiBanStatus = antiBanService.getStatus(acc.id);
      
      statusText += `*${acc.email}*\n`;
      
      if (session) {
        const statusIcon = {
          'running': '🟢',
          'paused': '⏸',
          'stopped': '⏹',
          'error': '🔴'
        }[session.status];

        statusText += `├ Статус: ${statusIcon} ${session.status}\n`;
        statusText += `├ Пошуків: ${session.stats.searches}\n`;
        statusText += `├ Покупок: ${session.stats.purchases}\n`;
        statusText += `├ Прибуток: ${session.stats.profit.toLocaleString()}💰\n`;
        statusText += `└ Anti-Ban:\n${antiBanStatus.split('\n').map(l => '  ' + l).join('\n')}\n\n`;
      } else {
        statusText += `└ Статус: ⏹ Не запущено\n\n`;
      }
    }

    await ctx.reply(statusText, { parse_mode: 'Markdown' });
  }

  private async showRiskLevels(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);
    
    let text = '⚠️ *Рівні ризику*\n\n';

    for (const acc of accounts) {
      const riskPercent = antiBanService.getRiskPercentage(acc.id);
      const session = antiBanService.getSession(acc.id);

      const riskEmoji = riskPercent < 30 ? '🟢' : riskPercent < 60 ? '🟡' : riskPercent < 85 ? '🟠' : '🔴';
      const riskLevel = riskPercent < 30 ? 'Низький' : riskPercent < 60 ? 'Середній' : riskPercent < 85 ? 'Високий' : 'КРИТИЧНИЙ';

      text += `*${acc.email}*\n`;
      text += `├ ${riskEmoji} Ризик: ${riskPercent.toFixed(1)}% (${riskLevel})\n`;
      
      if (session) {
        text += `├ Запитів: ${session.requestsThisHour}/${config.antiBan.maxRequestsPerHour}\n`;
        text += `├ Пошуків: ${session.searchesThisHour}/${config.antiBan.maxSearchesPerHour}\n`;
        text += `├ Покупок: ${session.purchasesThisHour}/${config.antiBan.maxPurchasesPerHour}\n`;
        text += `└ Помилок: ${session.errorsThisHour}\n`;
      } else {
        text += `└ Сесія не активна\n`;
      }
      
      text += '\n';
    }

    text += `*Рівні:*\n`;
    text += `🟢 0-30% - Безпечно\n`;
    text += `🟡 30-60% - Обережно\n`;
    text += `🟠 60-85% - Небезпечно\n`;
    text += `🔴 85-100% - КРИТИЧНО`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  }

  private async showSettings(ctx: BotContext): Promise<void> {
    await this.showAntiBanSettings(ctx);
  }

  private async showAntiBanSettings(ctx: BotContext): Promise<void> {
    const cfg = antiBanService.getConfig();

    const nightModeStatus = cfg.nightModeEnabled ? '✅' : '❌';

    const text = `⚙️ *Налаштування Anti-Ban*\n\n` +
      `*Затримки:*\n` +
      `├ Пошук: ${cfg.searchDelay.min/1000}-${cfg.searchDelay.max/1000}с\n` +
      `├ Покупка: ${cfg.buyDelay.min/1000}-${cfg.buyDelay.max/1000}с\n` +
      `└ Дії: ${cfg.actionDelay.min/1000}-${cfg.actionDelay.max/1000}с\n\n` +
      `*Ліміти:*\n` +
      `├ Пошуків/год: ${cfg.maxSearchesPerHour}\n` +
      `├ Покупок/год: ${cfg.maxPurchasesPerHour}\n` +
      `├ Запитів/год: ${cfg.maxRequestsPerHour}\n` +
      `└ Запитів/день: ${cfg.maxRequestsPerDay}\n\n` +
      `*Сесії:*\n` +
      `├ Тривалість: ${cfg.sessionDurationMs/60000} хв\n` +
      `├ Пауза між: ${cfg.pauseBetweenSessionsMs/60000} хв\n` +
      `└ Пауза після ${cfg.pauseAfterSearches} пошуків\n\n` +
      `*Нічний режим:* ${nightModeStatus}\n` +
      `└ ${cfg.nightModeStart}:00 - ${cfg.nightModeEnd}:00`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(
        cfg.nightModeEnabled ? '🌙 Вимкнути нічний режим' : '🌙 Увімкнути нічний режим',
        'toggle_night_mode'
      )]
    ]);

    if ('editMessageText' in ctx) {
      await (ctx as any).editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  }

  private async showHelp(ctx: BotContext): Promise<void> {
    await ctx.reply(
      `📖 *Допомога FC26 Sniper Bot v2.0*\n\n` +
      `*Як почати:*\n` +
      `1️⃣ Додайте EA акаунт /add_account\n` +
      `2️⃣ Виберіть метод авторизації\n` +
      `3️⃣ Створіть фільтр /filters\n` +
      `4️⃣ Запустіть снайпер /start_sniper\n\n` +
      `*Методи авторизації:*\n` +
      `🔐 *Повна* - email + пароль + 2FA код\n` +
      `   Автоматично оновлює сесію\n` +
      `🔑 *SID* - тільки X-UT-SID токен\n` +
      `   Потребує ручного оновлення\n\n` +
      `*Anti-Ban система:*\n` +
      `• Автоматичні затримки між запитами\n` +
      `• Ліміти на пошуки/покупки\n` +
      `• Нічний режим (02:00-08:00)\n` +
      `• Моніторинг ризику в реальному часі\n\n` +
      `*Команди:*\n` +
      `/accounts - Акаунти\n` +
      `/filters - Фільтри\n` +
      `/status - Статус та Anti-Ban\n` +
      `/risk - Рівні ризику\n` +
      `/settings - Налаштування\n` +
      `/2fa <код> - Ввести 2FA код\n` +
      `/captcha <рішення> - Ввести капчу\n\n` +
      `⚠️ *Увага:* Використовуйте на свій ризик!`,
      { parse_mode: 'Markdown' }
    );
  }

  private async startFullLogin(ctx: BotContext): Promise<void> {
    this.userStates.set(ctx.from!.id, {
      step: 'full_login_email',
      data: {}
    });

    await ctx.reply('📧 Введіть email EA акаунту:');
  }

  private async handle2FACode(ctx: BotContext, code: string): Promise<void> {
    const callback = this.pending2FACodes.get(ctx.from!.id);
    
    if (callback) {
      callback(code);
      this.pending2FACodes.delete(ctx.from!.id);
      await ctx.reply('✅ 2FA код відправлено!');
    } else {
      await ctx.reply('❌ Немає активного запиту на 2FA код');
    }
  }

  // ... (решта методів залишається без змін)

  private async showFilters(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const filters = await db.getFiltersByUser(ctx.user.id);

    if (filters.length === 0) {
      await ctx.reply(
        '📭 У вас немає фільтрів.\n\nСтворіть перший фільтр:',
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Додати фільтр', 'add_filter')]
        ])
      );
      return;
    }

    const buttons = filters.map(f => [
      Markup.button.callback(
        `${f.is_active ? '🟢' : '⏸'} ${f.name} | Max: ${f.max_buy.toLocaleString()}`,
        `filter_${f.id}`
      )
    ]);

    buttons.push([Markup.button.callback('➕ Додати фільтр', 'add_filter')]);

    await ctx.reply(
      `🎯 *Ваші фільтри:*`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  }

  private async showFilterDetails(ctx: BotContext, filterId: string): Promise<void> {
    const filters = await db.getFiltersByUser(ctx.user!.id);
    const filter = filters.find(f => f.id === filterId);

    if (!filter) {
      await ctx.reply('❌ Фільтр не знайдено');
      return;
    }

    await ctx.editMessageText(
      `🎯 *Фільтр: ${filter.name}*\n\n` +
      `📊 Статус: ${filter.is_active ? '🟢 Активний' : '⏸ Вимкнено'}\n` +
      `💰 Max Buy: ${filter.max_buy.toLocaleString()}\n` +
      `💵 Sell Price: ${filter.sell_price?.toLocaleString() || 'Auto'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            filter.is_active
              ? Markup.button.callback('⏸ Вимкнути', `toggle_filter_${filterId}_off`)
              : Markup.button.callback('▶️ Увімкнути', `toggle_filter_${filterId}_on`)
          ],
          [Markup.button.callback('🗑 Видалити', `delete_filter_${filterId}`)],
          [Markup.button.callback('« Назад', 'filters')]
        ])
      }
    );
  }

  private async startAddFilter(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);
    if (accounts.length === 0) {
      await ctx.reply('❌ Спочатку додайте EA акаунт');
      return;
    }

    this.userStates.set(ctx.from!.id, {
      step: 'add_filter_account',
      data: { accounts }
    });

    const buttons = accounts.map(acc => [
      Markup.button.callback(
        `${acc.platform.toUpperCase()} | ${acc.email}`,
        `select_account_for_filter_${acc.id}`
      )
    ]);

    await ctx.reply(
      '🎯 *Новий фільтр*\n\nОберіть акаунт:',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  }

  private async startSniper(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);
    if (accounts.length === 0) {
      await ctx.reply('❌ Спочатку додайте EA акаунт');
      return;
    }

    const buttons = accounts.map(acc => {
      const session = sniperEngine.getSession(acc.id);
      const status = session?.status === 'running' ? '🟢' : '⏹';
      const risk = antiBanService.getRiskPercentage(acc.id);
      const riskEmoji = risk < 30 ? '🟢' : risk < 60 ? '🟡' : '🔴';
      
      return [
        Markup.button.callback(
          `${status} ${acc.platform.toUpperCase()} | ${acc.email} ${riskEmoji}`,
          `start_sniper_${acc.id}`
        )
      ];
    });

    await ctx.reply(
      '🚀 *Запуск снайпера*\n\nОберіть акаунт:',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  }

  private async startSniperForAccount(ctx: BotContext, accountId: string): Promise<void> {
    if (!ctx.user) return;

    const success = await sniperEngine.startSession(accountId, ctx.user.id);

    if (success) {
      await ctx.reply('✅ Снайпер запущено!');
    } else {
      await ctx.reply('❌ Помилка запуску. Перевірте сесію.');
    }
  }

  private async stopSniper(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);
    const activeSessions = accounts.filter(acc => sniperEngine.getSession(acc.id));

    if (activeSessions.length === 0) {
      await ctx.reply('ℹ️ Немає активних сесій');
      return;
    }

    for (const acc of activeSessions) {
      await sniperEngine.stopSession(acc.id);
    }

    await ctx.reply('⏹ Всі снайпери зупинено');
  }

  private async showStats(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const history = await db.getStatsHistory(ctx.user.id, 7);
    
    if (history.length === 0) {
      await ctx.reply('📊 Поки немає статистики');
      return;
    }

    let statsText = '📈 *Статистика за 7 днів*\n\n';
    let totalProfit = 0;

    for (const stat of history) {
      statsText += `📅 ${stat.date}\n`;
      statsText += `├ Покупок: ${stat.purchases}\n`;
      statsText += `├ Продажів: ${stat.sales}\n`;
      statsText += `└ Прибуток: ${stat.profit.toLocaleString()}💰\n\n`;
      totalProfit += stat.profit;
    }

    statsText += `*Всього прибуток:* ${totalProfit.toLocaleString()}💰`;

    await ctx.reply(statsText, { parse_mode: 'Markdown' });
  }

  private async searchPrices(ctx: BotContext, query: string): Promise<void> {
    await ctx.reply('🔍 Шукаю...');

    const players = await priceService.searchPlayer(query);

    if (players.length === 0) {
      await ctx.reply('❌ Гравців не знайдено');
      return;
    }

    const topPlayers = players.slice(0, 5);
    let resultText = `🔍 *Результати для "${query}":*\n\n`;

    for (const player of topPlayers) {
      const price = await priceService.getPrice(player.id, 'ps');
      
      resultText += `*${player.name}* (${player.rating})\n`;
      resultText += `├ ID: ${player.id}\n`;
      resultText += `└ Ціна: ${price.lowestBin?.toLocaleString() || 'N/A'}💰\n\n`;
    }

    await ctx.reply(resultText, { parse_mode: 'Markdown' });
  }

  // ==========================================
  // STATE HANDLERS
  // ==========================================

  private async handleState(ctx: BotContext, state: { step: string; data: any }): Promise<void> {
    const text = (ctx.message as any).text;

    switch (state.step) {
      case 'add_account_email':
        state.data.email = text;
        state.step = 'add_account_platform';
        await ctx.reply(
          '🎮 Оберіть платформу:',
          Markup.inlineKeyboard([
            [Markup.button.callback('PlayStation', 'platform_ps')],
            [Markup.button.callback('Xbox', 'platform_xbox')],
            [Markup.button.callback('PC', 'platform_pc')]
          ])
        );
        break;

      case 'full_auth_email':
        state.data.email = text;
        state.step = 'full_auth_password';
        await ctx.reply('🔑 Введіть пароль:');
        break;

      case 'full_auth_password':
        state.data.password = text;
        await ctx.reply('⏳ Авторизація...');
        await this.performFullAuth(ctx, state.data);
        break;

      case 'refresh_auth_password':
        state.data.password = text;
        await ctx.reply('⏳ Оновлення сесії...');
        await this.performFullAuth(ctx, state.data);
        break;

      case 'add_account_cookies':
        await this.handleSIDInput(ctx, text, state.data);
        break;

      case 'update_cookies':
        await this.handleSIDInput(ctx, text, state.data);
        break;

      case 'add_filter_name':
        state.data.name = text;
        state.step = 'add_filter_max_buy';
        await ctx.reply('💰 Введіть максимальну ціну покупки:');
        break;

      case 'add_filter_max_buy':
        const maxBuy = parseInt(text.replace(/\s/g, ''));
        if (isNaN(maxBuy) || maxBuy <= 0) {
          await ctx.reply('❌ Введіть коректне число:');
          return;
        }
        state.data.maxBuy = maxBuy;
        state.step = 'add_filter_sell_price';
        await ctx.reply('💵 Введіть ціну продажу (або "auto"):');
        break;

      case 'add_filter_sell_price':
        const sellPrice = text.toLowerCase() === 'auto' ? null : parseInt(text.replace(/\s/g, ''));
        if (sellPrice !== null && (isNaN(sellPrice) || sellPrice <= 0)) {
          await ctx.reply('❌ Введіть коректне число або "auto":');
          return;
        }

        try {
          await db.addFilter({
            user_id: ctx.user!.id,
            ea_account_id: state.data.accountId,
            name: state.data.name,
            player_id: null,
            min_buy: null,
            max_buy: state.data.maxBuy,
            sell_price: sellPrice,
            position: null,
            quality: null,
            rarity: null,
            nation: null,
            league: null,
            club: null,
            is_active: true
          });

          this.userStates.delete(ctx.from!.id);
          await ctx.reply(
            `✅ Фільтр створено!\n\n` +
            `📝 Назва: ${state.data.name}\n` +
            `💰 Max Buy: ${state.data.maxBuy.toLocaleString()}\n` +
            `💵 Sell: ${sellPrice?.toLocaleString() || 'Auto'}\n\n` +
            `Запустіть снайпер: /start_sniper`
          );
        } catch (error) {
          await ctx.reply('❌ Помилка створення фільтра');
          logger.error('Filter creation error:', error);
        }
        break;

      default:
        this.userStates.delete(ctx.from!.id);
    }
  }

  private async performFullAuth(ctx: BotContext, data: any): Promise<void> {
    const { email, password, platform, accountId } = data;

    try {
      // Create 2FA code provider
      const get2FACode = (): Promise<string | null> => {
        return new Promise((resolve) => {
          this.pending2FACodes.set(ctx.from!.id, resolve);
          ctx.reply(
            '🔐 *Потрібен 2FA код!*\n\n' +
            'Введіть код з email або SMS:\n' +
            '`/2fa 123456`',
            { parse_mode: 'Markdown' }
          );

          // Timeout after 5 minutes
          setTimeout(() => {
            if (this.pending2FACodes.has(ctx.from!.id)) {
              this.pending2FACodes.delete(ctx.from!.id);
              resolve(null);
            }
          }, 300000);
        });
      };

      const result = await eaAuthManager.login(
        accountId || 'new',
        { email, password, platform },
        get2FACode
      );

      if (result.success && result.session) {
        // Save or update account
        if (accountId) {
          await db.updateEAAccountSession(accountId, {
            cookies: result.cookies,
            session_id: result.session.sid
          });
        } else {
          await db.addEAAccount(
            ctx.user!.id,
            email,
            platform,
            result.cookies!
          );
        }

        this.userStates.delete(ctx.from!.id);
        await ctx.reply(
          `✅ Авторизація успішна!\n\n` +
          `📧 Email: ${email}\n` +
          `🎮 Платформа: ${platform.toUpperCase()}\n` +
          `🔑 SID: ${result.session.sid.substring(0, 8)}...\n\n` +
          `Наступний крок: /filters`
        );
      } else {
        await ctx.reply(`❌ Помилка авторизації: ${result.error}`);
      }
    } catch (error: any) {
      logger.error('Full auth error:', error);
      await ctx.reply(`❌ Помилка: ${error.message}`);
    }
  }

  private async handleSIDInput(ctx: BotContext, text: string, data: any): Promise<void> {
    let sid = text.trim();

    // Try to extract SID from JSON if provided
    if (text.includes('{')) {
      try {
        const parsed = JSON.parse(text);
        sid = parsed.sid || parsed['X-UT-SID'] || text;
      } catch (e) {
        // Not JSON, use as-is
      }
    }

    // Validate SID format
    const sidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!sidRegex.test(sid)) {
      await ctx.reply(
        '❌ Невірний формат SID!\n\n' +
        'SID має виглядати так:\n' +
        '`f1888c19-c261-4e8c-b49e-1e202c4a872f`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await ctx.reply('⏳ Перевіряю SID...');

    const cookies = { sid };

    try {
      if (data.accountId) {
        // Update existing account
        await db.updateEAAccountSession(data.accountId, { cookies });
        EAAPIFactory.removeInstance(data.accountId);

        const api = await EAAPIFactory.getInstance(data.accountId);
        if (api) {
          const credits = await api.getCredits();
          await db.updateEAAccountSession(data.accountId, { coins: credits.credits });
          
          this.userStates.delete(ctx.from!.id);
          await ctx.reply(
            `✅ SID оновлено!\n\n` +
            `💰 Баланс: ${credits.credits.toLocaleString()} монет`
          );
        } else {
          await ctx.reply('⚠️ SID збережено, але перевірка не вдалась');
        }
      } else {
        // New account
        const account = await db.addEAAccount(
          ctx.user!.id,
          data.email,
          data.platform,
          cookies
        );

        const api = await EAAPIFactory.getInstance(account.id);
        if (api) {
          const credits = await api.getCredits();
          await db.updateEAAccountSession(account.id, { coins: credits.credits });
          
          this.userStates.delete(ctx.from!.id);
          await ctx.reply(
            `✅ Акаунт додано!\n\n` +
            `📧 Email: ${data.email}\n` +
            `🎮 Платформа: ${data.platform.toUpperCase()}\n` +
            `💰 Баланс: ${credits.credits.toLocaleString()} монет\n\n` +
            `Наступний крок: /add_filter`
          );
        } else {
          this.userStates.delete(ctx.from!.id);
          await ctx.reply(
            `⚠️ Акаунт додано, але SID не вдалося перевірити.\n` +
            `Можливо SID застарів.`
          );
        }
      }
    } catch (error) {
      logger.error('SID handling error:', error);
      await ctx.reply('❌ Помилка перевірки SID');
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================

  private getMainKeyboard() {
    return Markup.keyboard([
      ['📱 Акаунти', '🎯 Фільтри'],
      ['▶️ Старт', '⏹ Стоп'],
      ['📊 Статус', '⚠️ Ризик']
    ]).resize();
  }

  private async getAccountsByAccountId(accountId: string): Promise<EAAccount[]> {
    const { data } = await (db as any)['client']
      .from('ea_accounts')
      .select('*')
      .eq('id', accountId);
    return data || [];
  }

  // ==========================================
  // START BOT
  // ==========================================

  async start(): Promise<void> {
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Почати роботу' },
      { command: 'accounts', description: 'Керування акаунтами' },
      { command: 'filters', description: 'Керування фільтрами' },
      { command: 'start_sniper', description: 'Запустити снайпер' },
      { command: 'stop_sniper', description: 'Зупинити снайпер' },
      { command: 'status', description: 'Статус бота' },
      { command: 'risk', description: 'Рівні ризику' },
      { command: 'settings', description: 'Налаштування Anti-Ban' },
      { command: 'stats', description: 'Статистика' },
      { command: 'prices', description: 'Перевірити ціни' },
      { command: '2fa', description: 'Ввести 2FA код' },
      { command: 'help', description: 'Допомога' }
    ]);

    await this.bot.launch();
    logger.info('🤖 Telegram bot v2.0 started');

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

export const telegramBot = new TelegramBot();
