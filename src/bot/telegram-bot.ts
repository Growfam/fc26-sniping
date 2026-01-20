/**
 * FC26 Telegram Bot v2.0
 * Only email/password authentication (no SID)
 */

import { Telegraf, Context, Markup } from 'telegraf';
import { config } from '../config';
import { db, User, EAAccount, SniperFilter } from '../database';
import { EAAPI, EAAPIFactory } from '../services/ea-api';
import { eaAuthManager, EACredentials } from '../services/ea-auth';
import { antiBanService, RiskLevel } from '../services/anti-ban';
import { logger } from '../utils/logger';

// ==========================================
// TYPES
// ==========================================

interface BotContext extends Context {
  user?: User;
}

interface UserState {
  step: string;
  data: any;
}

// ==========================================
// TELEGRAM BOT CLASS
// ==========================================

export class TelegramBot {
  private bot: Telegraf<BotContext>;
  private userStates: Map<number, UserState> = new Map();
  private pending2FA: Map<number, string> = new Map(); // telegramId -> tempId

  constructor() {
    this.bot = new Telegraf<BotContext>(config.telegram.botToken);
    this.setupMiddleware();
    this.setupCommands();
    this.setupCallbacks();
    this.setupMessageHandler();
  }

  // ==========================================
  // MIDDLEWARE
  // ==========================================

  private setupMiddleware(): void {
    // Auth middleware
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return;
      
      const startTime = Date.now();
      
      try {
        ctx.user = await db.getOrCreateUser(ctx.from.id, ctx.from.username || null);
        await next();
      } catch (error) {
        logger.error('Middleware error:', error);
      }

      const duration = Date.now() - startTime;
      logger.info(`[${ctx.from.id}] ${ctx.updateType} - ${duration}ms`);
    });
  }

  // ==========================================
  // COMMANDS
  // ==========================================

  private setupCommands(): void {
    this.bot.command('start', (ctx) => this.showWelcome(ctx));
    this.bot.command('help', (ctx) => this.showHelp(ctx));
    this.bot.command('accounts', (ctx) => this.showAccounts(ctx));
    this.bot.command('add_account', (ctx) => this.startAddAccount(ctx));
    this.bot.command('filters', (ctx) => this.showFilters(ctx));
    this.bot.command('add_filter', (ctx) => this.startAddFilter(ctx));
    this.bot.command('status', (ctx) => this.showStatus(ctx));
    this.bot.command('risk', (ctx) => this.showRisk(ctx));
    this.bot.command('settings', (ctx) => this.showSettings(ctx));
    this.bot.command('2fa', (ctx) => this.handle2FACommand(ctx));
    this.bot.command('cancel', (ctx) => this.cancelAction(ctx));
  }

  // ==========================================
  // CALLBACKS
  // ==========================================

  private setupCallbacks(): void {
    // Platform selection
    this.bot.action(/^platform_(.+)$/, (ctx) => this.handlePlatformSelect(ctx));
    
    // Account actions
    this.bot.action(/^account_(.+)$/, (ctx) => this.handleAccountAction(ctx));
    this.bot.action(/^refresh_(.+)$/, (ctx) => this.handleRefreshSession(ctx));
    this.bot.action(/^delete_acc_(.+)$/, (ctx) => this.handleDeleteAccount(ctx));
    
    // Filter actions
    this.bot.action(/^filter_(.+)$/, (ctx) => this.handleFilterAction(ctx));
    this.bot.action(/^toggle_filter_(.+)$/, (ctx) => this.handleToggleFilter(ctx));
    this.bot.action(/^delete_filter_(.+)$/, (ctx) => this.handleDeleteFilter(ctx));
    
    // Navigation
    this.bot.action('back_to_accounts', (ctx) => this.showAccounts(ctx));
    this.bot.action('back_to_filters', (ctx) => this.showFilters(ctx));
    this.bot.action('add_account', (ctx) => this.startAddAccount(ctx));
    this.bot.action('add_filter', (ctx) => this.startAddFilter(ctx));
  }

  // ==========================================
  // MESSAGE HANDLER
  // ==========================================

  private setupMessageHandler(): void {
    this.bot.on('text', async (ctx) => {
      const state = this.userStates.get(ctx.from.id);
      if (!state) return;

      const text = ctx.message.text.trim();

      switch (state.step) {
        case 'email':
          await this.handleEmailInput(ctx, text);
          break;
        case 'password':
          await this.handlePasswordInput(ctx, text);
          break;
        case 'filter_name':
          await this.handleFilterName(ctx, text);
          break;
        case 'filter_max_buy':
          await this.handleFilterMaxBuy(ctx, text);
          break;
        case 'filter_sell_price':
          await this.handleFilterSellPrice(ctx, text);
          break;
      }
    });
  }

  // ==========================================
  // WELCOME & HELP
  // ==========================================

  private async showWelcome(ctx: BotContext): Promise<void> {
    await ctx.reply(
      `👋 *Вітаю у FC26 Sniper Bot v2.0!*\n\n` +
      `🔐 *Авторизація:* Email + Password + 2FA\n` +
      `🛡️ *Anti-Ban:* Захист від блокування\n` +
      `⚡ *Швидкість:* 7-15 сек між запитами\n\n` +
      `*Почати роботу:*\n` +
      `1️⃣ /add_account - додати EA акаунт\n` +
      `2️⃣ /add_filter - створити фільтр\n` +
      `3️⃣ Запустити снайпер\n\n` +
      `📖 /help - всі команди`,
      { parse_mode: 'Markdown' }
    );
  }

  private async showHelp(ctx: BotContext): Promise<void> {
    await ctx.reply(
      `📖 *Команди бота:*\n\n` +
      `👤 *Акаунти:*\n` +
      `/accounts - список акаунтів\n` +
      `/add_account - додати акаунт\n\n` +
      `🎯 *Фільтри:*\n` +
      `/filters - список фільтрів\n` +
      `/add_filter - додати фільтр\n\n` +
      `📊 *Статус:*\n` +
      `/status - статус бота\n` +
      `/risk - рівні ризику\n` +
      `/settings - налаштування Anti-Ban\n\n` +
      `🔐 *Авторизація:*\n` +
      `/2fa <код> - ввести 2FA код\n\n` +
      `❌ /cancel - скасувати дію`,
      { parse_mode: 'Markdown' }
    );
  }

  // ==========================================
  // ACCOUNTS
  // ==========================================

  private async showAccounts(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);

    if (accounts.length === 0) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Додати акаунт', 'add_account')]
      ]);

      await ctx.reply(
        '📭 У вас немає акаунтів.\n\nДодайте перший акаунт для початку роботи.',
        keyboard
      );
      return;
    }

    let text = '👤 *Ваші акаунти:*\n\n';
    const buttons: any[] = [];

    for (const acc of accounts) {
      const riskInfo = antiBanService.getStats(acc.id);
      const riskEmoji = this.getRiskEmoji(riskInfo?.riskLevel || RiskLevel.LOW);
      
      text += `${riskEmoji} *${acc.email}*\n`;
      text += `├ Платформа: ${acc.platform.toUpperCase()}\n`;
      text += `├ Монети: ${acc.coins.toLocaleString()}\n`;
      text += `└ Сесія: ${acc.session_id ? '✅' : '❌'}\n\n`;

      buttons.push([Markup.button.callback(`📧 ${acc.email}`, `account_${acc.id}`)]);
    }

    buttons.push([Markup.button.callback('➕ Додати акаунт', 'add_account')]);

    if ('editMessageText' in ctx) {
      await (ctx as any).editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    }
  }

  private async handleAccountAction(ctx: any): Promise<void> {
    const accountId = ctx.match[1];
    const account = await db.getEAAccountById(accountId);
    
    if (!account) {
      await ctx.answerCbQuery('Акаунт не знайдено');
      return;
    }

    const riskInfo = antiBanService.getStats(accountId);
    const riskEmoji = this.getRiskEmoji(riskInfo?.riskLevel || RiskLevel.LOW);

    const text = `👤 *${account.email}*\n\n` +
      `🎮 Платформа: ${account.platform.toUpperCase()}\n` +
      `💰 Монети: ${account.coins.toLocaleString()}\n` +
      `🔑 Сесія: ${account.session_id ? '✅ Активна' : '❌ Немає'}\n` +
      `${riskEmoji} Ризик: ${riskInfo?.riskLevel || 'Невідомо'}\n`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Оновити сесію', `refresh_${accountId}`)],
      [Markup.button.callback('🗑 Видалити', `delete_acc_${accountId}`)],
      [Markup.button.callback('« Назад', 'back_to_accounts')]
    ]);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  }

  // ==========================================
  // ADD ACCOUNT FLOW
  // ==========================================

  private async startAddAccount(ctx: BotContext): Promise<void> {
    this.userStates.set(ctx.from!.id, {
      step: 'email',
      data: {}
    });

    await ctx.reply(
      '📧 *Додавання акаунта*\n\n' +
      'Введіть email вашого EA акаунта:',
      { parse_mode: 'Markdown' }
    );
  }

  private async handleEmailInput(ctx: BotContext, email: string): Promise<void> {
    if (!email.includes('@')) {
      await ctx.reply('❌ Невірний формат email. Спробуйте ще раз:');
      return;
    }

    const state = this.userStates.get(ctx.from!.id)!;
    state.data.email = email;
    state.step = 'platform';

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🎮 PlayStation', 'platform_ps'),
        Markup.button.callback('🎮 Xbox', 'platform_xbox')
      ],
      [Markup.button.callback('💻 PC', 'platform_pc')]
    ]);

    await ctx.reply('🎮 Виберіть платформу:', keyboard);
  }

  private async handlePlatformSelect(ctx: any): Promise<void> {
    const platform = ctx.match[1] as 'ps' | 'xbox' | 'pc';
    const state = this.userStates.get(ctx.from!.id);

    if (!state || state.step !== 'platform') {
      await ctx.answerCbQuery('Сесія застаріла. Почніть заново /add_account');
      return;
    }

    state.data.platform = platform;
    state.step = 'password';

    await ctx.answerCbQuery();
    await ctx.reply(
      '🔐 Введіть пароль від EA акаунта:\n\n' +
      '⚠️ Пароль використовується тільки для авторизації і НЕ зберігається.',
      { parse_mode: 'Markdown' }
    );
  }

  private async handlePasswordInput(ctx: BotContext, password: string): Promise<void> {
    const state = this.userStates.get(ctx.from!.id);
    if (!state || state.step !== 'password') return;

    // Delete password message for security
    try {
      await ctx.deleteMessage();
    } catch {}

    const { email, platform } = state.data;
    const tempId = `temp_${ctx.from!.id}_${Date.now()}`;

    await ctx.reply('⏳ Авторизація в EA...');

    const credentials: EACredentials = { email, password, platform };
    
    try {
      const result = await eaAuthManager.loginWithCredentials(tempId, credentials);

      if (result.requires2FA) {
        this.pending2FA.set(ctx.from!.id, tempId);
        state.step = '2fa';
        
        await ctx.reply(
          '🔐 *Потрібен 2FA код*\n\n' +
          'EA надіслав код на вашу пошту/телефон.\n\n' +
          'Введіть команду:\n' +
          '`/2fa XXXXXX`\n\n' +
          '(де XXXXXX - ваш код)',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (!result.success) {
        this.userStates.delete(ctx.from!.id);
        await ctx.reply(`❌ Помилка: ${result.error}`);
        return;
      }

      // Success - save account
      await this.saveAccount(ctx, result);

    } catch (error: any) {
      logger.error('Login error:', error);
      this.userStates.delete(ctx.from!.id);
      await ctx.reply(`❌ Помилка авторизації: ${error.message}`);
    }
  }

  private async handle2FACommand(ctx: BotContext): Promise<void> {
    const text = ctx.message?.text || '';
    const code = text.replace('/2fa', '').trim();

    if (!code) {
      await ctx.reply('❌ Введіть код: `/2fa 123456`', { parse_mode: 'Markdown' });
      return;
    }

    const tempId = this.pending2FA.get(ctx.from!.id);
    if (!tempId) {
      await ctx.reply('❌ Немає активного запиту на 2FA. Почніть заново /add_account');
      return;
    }

    await ctx.reply('⏳ Перевірка коду...');

    const submitted = eaAuthManager.submit2FACode(tempId, code);
    if (!submitted) {
      await ctx.reply('❌ Не вдалося відправити код. Спробуйте заново /add_account');
      this.pending2FA.delete(ctx.from!.id);
      this.userStates.delete(ctx.from!.id);
      return;
    }

    // Wait for result (login will continue in background)
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check if account was created
    const state = this.userStates.get(ctx.from!.id);
    if (state?.step === 'completed') {
      // Success was handled by saveAccount
      return;
    }

    // If still waiting, inform user
    await ctx.reply(
      '⏳ Авторизація продовжується...\n\n' +
      'Якщо через 30 секунд не буде відповіді - спробуйте заново.'
    );
  }

  private async saveAccount(ctx: BotContext, result: any): Promise<void> {
    const state = this.userStates.get(ctx.from!.id);
    if (!state) return;

    const { email, platform } = state.data;
    const cookies = result.cookies || { sid: result.session?.sid, platform };

    try {
      const account = await db.addEAAccount(
        ctx.user!.id,
        email,
        platform,
        cookies
      );

      if (!account) {
        await ctx.reply('❌ Помилка збереження акаунту');
        return;
      }

      // Update coins
      if (result.session?.sid) {
        const auth = eaAuthManager.getAuth(account.id);
        const credits = await auth.getCredits(result.session.sid, platform);
        await db.updateEAAccountSession(account.id, { 
          session_id: result.session.sid,
          coins: credits 
        });
      }

      state.step = 'completed';
      this.userStates.delete(ctx.from!.id);
      this.pending2FA.delete(ctx.from!.id);

      await ctx.reply(
        `✅ *Акаунт додано!*\n\n` +
        `📧 Email: ${email}\n` +
        `🎮 Платформа: ${platform.toUpperCase()}\n` +
        `🔑 Сесія: ✅\n\n` +
        `Наступний крок: /add_filter`,
        { parse_mode: 'Markdown' }
      );

    } catch (error: any) {
      logger.error('Save account error:', error);
      await ctx.reply(`❌ Помилка: ${error.message}`);
    }
  }

  // ==========================================
  // REFRESH SESSION
  // ==========================================

  private async handleRefreshSession(ctx: any): Promise<void> {
    const accountId = ctx.match[1];
    
    await ctx.answerCbQuery();
    await ctx.reply(
      '🔄 *Оновлення сесії*\n\n' +
      'Для оновлення потрібно повторно авторизуватися.\n' +
      'Використайте /add_account з тим же email.',
      { parse_mode: 'Markdown' }
    );
  }

  // ==========================================
  // DELETE ACCOUNT
  // ==========================================

  private async handleDeleteAccount(ctx: any): Promise<void> {
    const accountId = ctx.match[1];
    
    await db.deleteEAAccount(accountId);
    await ctx.answerCbQuery('✅ Акаунт видалено');
    await this.showAccounts(ctx);
  }

  // ==========================================
  // FILTERS
  // ==========================================

  private async showFilters(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const filters = await db.getFiltersByUser(ctx.user.id);

    if (filters.length === 0) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Додати фільтр', 'add_filter')]
      ]);

      await ctx.reply(
        '📭 У вас немає фільтрів.\n\nСтворіть перший фільтр для снайпінгу.',
        keyboard
      );
      return;
    }

    let text = '🎯 *Ваші фільтри:*\n\n';
    const buttons: any[] = [];

    for (const filter of filters) {
      const status = filter.is_active ? '🟢' : '⚪';
      text += `${status} *${filter.name}*\n`;
      text += `├ Max: ${filter.max_buy.toLocaleString()}\n`;
      text += `└ Sell: ${filter.sell_price?.toLocaleString() || 'Не вказано'}\n\n`;

      buttons.push([Markup.button.callback(`🎯 ${filter.name}`, `filter_${filter.id}`)]);
    }

    buttons.push([Markup.button.callback('➕ Додати фільтр', 'add_filter')]);

    if ('editMessageText' in ctx) {
      await (ctx as any).editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    }
  }

  private async handleFilterAction(ctx: any): Promise<void> {
    const filterId = ctx.match[1];
    const filter = await db.getFilterById(filterId);
    
    if (!filter) {
      await ctx.answerCbQuery('Фільтр не знайдено');
      return;
    }

    const status = filter.is_active ? '🟢 Активний' : '⚪ Неактивний';

    const text = `🎯 *${filter.name}*\n\n` +
      `📊 Статус: ${status}\n` +
      `💰 Max Buy: ${filter.max_buy.toLocaleString()}\n` +
      `💵 Sell: ${filter.sell_price?.toLocaleString() || 'Не вказано'}\n`;

    const toggleText = filter.is_active ? '⏸ Вимкнути' : '▶️ Увімкнути';
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(toggleText, `toggle_filter_${filterId}`)],
      [Markup.button.callback('🗑 Видалити', `delete_filter_${filterId}`)],
      [Markup.button.callback('« Назад', 'back_to_filters')]
    ]);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  }

  private async handleToggleFilter(ctx: any): Promise<void> {
    const filterId = ctx.match[1];
    const filter = await db.getFilterById(filterId);
    
    if (!filter) {
      await ctx.answerCbQuery('Фільтр не знайдено');
      return;
    }

    await db.toggleFilter(filterId, !filter.is_active);
    await ctx.answerCbQuery(filter.is_active ? 'Фільтр вимкнено' : 'Фільтр увімкнено');
    
    // Refresh view
    ctx.match[1] = filterId;
    await this.handleFilterAction(ctx);
  }

  private async handleDeleteFilter(ctx: any): Promise<void> {
    const filterId = ctx.match[1];
    
    await db.deleteFilter(filterId);
    await ctx.answerCbQuery('✅ Фільтр видалено');
    await this.showFilters(ctx);
  }

  // ==========================================
  // ADD FILTER FLOW
  // ==========================================

  private async startAddFilter(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);
    
    if (accounts.length === 0) {
      await ctx.reply('❌ Спочатку додайте акаунт: /add_account');
      return;
    }

    this.userStates.set(ctx.from!.id, {
      step: 'filter_name',
      data: { ea_account_id: accounts[0].id }
    });

    await ctx.reply(
      '🎯 *Створення фільтра*\n\n' +
      'Введіть назву фільтра (наприклад: "Mbappe cheap"):',
      { parse_mode: 'Markdown' }
    );
  }

  private async handleFilterName(ctx: BotContext, name: string): Promise<void> {
    const state = this.userStates.get(ctx.from!.id)!;
    state.data.name = name;
    state.step = 'filter_max_buy';

    await ctx.reply(
      '💰 Введіть максимальну ціну покупки (Buy Now):\n\n' +
      'Наприклад: 10000'
    );
  }

  private async handleFilterMaxBuy(ctx: BotContext, text: string): Promise<void> {
    const maxBuy = parseInt(text.replace(/[^0-9]/g, ''));
    
    if (isNaN(maxBuy) || maxBuy < 150) {
      await ctx.reply('❌ Введіть коректну суму (мінімум 150):');
      return;
    }

    const state = this.userStates.get(ctx.from!.id)!;
    state.data.max_buy = maxBuy;
    state.step = 'filter_sell_price';

    await ctx.reply(
      '💵 Введіть ціну продажу (або "skip" щоб пропустити):\n\n' +
      'Наприклад: 15000'
    );
  }

  private async handleFilterSellPrice(ctx: BotContext, text: string): Promise<void> {
    const state = this.userStates.get(ctx.from!.id)!;
    
    if (text.toLowerCase() !== 'skip') {
      const sellPrice = parseInt(text.replace(/[^0-9]/g, ''));
      if (!isNaN(sellPrice) && sellPrice > 0) {
        state.data.sell_price = sellPrice;
      }
    }

    // Create filter
    const filter = await db.addFilter({
      user_id: ctx.user!.id,
      ea_account_id: state.data.ea_account_id,
      name: state.data.name,
      player_id: null,
      min_buy: null,
      max_buy: state.data.max_buy,
      sell_price: state.data.sell_price || null,
      position: null,
      quality: null,
      rarity: null,
      nation: null,
      league: null,
      club: null,
      is_active: true
    });

    this.userStates.delete(ctx.from!.id);

    if (filter) {
      await ctx.reply(
        `✅ *Фільтр створено!*\n\n` +
        `📝 Назва: ${filter.name}\n` +
        `💰 Max Buy: ${filter.max_buy.toLocaleString()}\n` +
        `💵 Sell: ${filter.sell_price?.toLocaleString() || 'Не вказано'}\n\n` +
        `/filters - переглянути всі фільтри`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply('❌ Помилка створення фільтра');
    }
  }

  // ==========================================
  // STATUS & RISK
  // ==========================================

  private async showStatus(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);
    const filters = await db.getFiltersByUser(ctx.user.id);

    let text = '📊 *Статус бота*\n\n';
    text += `👤 Акаунтів: ${accounts.length}\n`;
    text += `🎯 Фільтрів: ${filters.length}\n`;
    text += `✅ Активних: ${filters.filter(f => f.is_active).length}\n\n`;

    if (accounts.length > 0) {
      text += '*Акаунти:*\n';
      for (const acc of accounts) {
        const emoji = acc.session_id ? '🟢' : '🔴';
        text += `${emoji} ${acc.email}\n`;
      }
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  }

  private async showRisk(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);

    if (accounts.length === 0) {
      await ctx.reply('📭 Немає акаунтів для відображення ризику.');
      return;
    }

    let text = '⚠️ *Рівні ризику*\n\n';

    for (const acc of accounts) {
      const stats = antiBanService.getStats(acc.id);
      const riskEmoji = this.getRiskEmoji(stats?.riskLevel || RiskLevel.LOW);
      const riskPercent = stats?.riskPercent || 0;

      text += `*${acc.email}*\n`;
      text += `├ ${riskEmoji} Ризик: ${riskPercent.toFixed(1)}%\n`;
      text += `├ Запитів: ${stats?.requestsThisHour || 0}/400\n`;
      text += `├ Пошуків: ${stats?.searchesThisHour || 0}/350\n`;
      text += `├ Покупок: ${stats?.purchasesThisHour || 0}/25\n`;
      text += `└ Помилок: ${stats?.errorsThisHour || 0}\n\n`;
    }

    text += '🟢 0-30% - Безпечно\n';
    text += '🟡 30-60% - Обережно\n';
    text += '🟠 60-85% - Небезпечно\n';
    text += '🔴 85-100% - КРИТИЧНО';

    await ctx.reply(text, { parse_mode: 'Markdown' });
  }

  private async showSettings(ctx: BotContext): Promise<void> {
    const cfg = config.antiBan;
    
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
      `*Нічний режим:* ${cfg.nightModeEnabled ? '✅' : '❌'}\n` +
      `└ ${cfg.nightModeStart}:00 - ${cfg.nightModeEnd}:00`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  }

  // ==========================================
  // CANCEL
  // ==========================================

  private async cancelAction(ctx: BotContext): Promise<void> {
    this.userStates.delete(ctx.from!.id);
    this.pending2FA.delete(ctx.from!.id);
    await ctx.reply('✅ Дію скасовано.');
  }

  // ==========================================
  // HELPERS
  // ==========================================

  private getRiskEmoji(level: RiskLevel): string {
    switch (level) {
      case RiskLevel.LOW: return '🟢';
      case RiskLevel.MEDIUM: return '🟡';
      case RiskLevel.HIGH: return '🟠';
      case RiskLevel.CRITICAL: return '🔴';
      default: return '⚪';
    }
  }

  // ==========================================
  // LAUNCH
  // ==========================================

  async launch(): Promise<void> {
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Почати роботу' },
      { command: 'accounts', description: 'Керування акаунтами' },
      { command: 'add_account', description: 'Додати акаунт' },
      { command: 'filters', description: 'Керування фільтрами' },
      { command: 'add_filter', description: 'Додати фільтр' },
      { command: 'status', description: 'Статус бота' },
      { command: 'risk', description: 'Рівні ризику' },
      { command: 'settings', description: 'Налаштування' },
      { command: '2fa', description: 'Ввести 2FA код' },
      { command: 'help', description: 'Допомога' },
      { command: 'cancel', description: 'Скасувати' }
    ]);

    await this.bot.launch();
    logger.info('🤖 Telegram bot v2.0 started');
  }

  stop(signal?: string): void {
    this.bot.stop(signal);
  }
}
