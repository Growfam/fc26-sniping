import { Telegraf, Context, Markup } from 'telegraf';
import { config } from '../config';
import { db, User, EAAccount, SniperFilter } from '../database';
import { sniperEngine, SniperSession } from '../services/sniper-engine';
import { priceService } from '../services/price-service';
import { EAAPI, EAAPIFactory } from '../services/ea-api';
import { logger } from '../utils/logger';

// ==========================================
// CONTEXT EXTENSION
// ==========================================
interface BotContext extends Context {
  user?: User;
}


// ==========================================
// BOT INSTANCE
// ==========================================
export class TelegramBot {
  private bot: Telegraf<BotContext>;
  private userStates: Map<number, { step: string; data: any }> = new Map();

  constructor() {
    this.bot = new Telegraf<BotContext>(config.telegram.botToken);
    this.setupMiddleware();
    this.setupCommands();
    this.setupCallbacks();
    this.setupSniperEvents();
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
        
        // State is managed via userStates Map

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
        `🎮 *FC26 Ultimate Sniper Bot*\n\n` +
        `Привіт, ${ctx.from?.first_name}! 👋\n\n` +
        `Цей бот допоможе тобі автоматично торгувати на ринку FC 26.\n\n` +
        `📋 *Основні команди:*\n` +
        `/accounts - Керування EA акаунтами\n` +
        `/filters - Керування фільтрами\n` +
        `/start_sniper - Запустити снайпер\n` +
        `/stop_sniper - Зупинити снайпер\n` +
        `/status - Статус бота\n` +
        `/stats - Статистика\n` +
        `/prices - Перевірити ціни\n` +
        `/help - Допомога\n\n` +
        `🚀 Почнемо з додавання EA акаунту!`,
        { parse_mode: 'Markdown', ...this.getMainKeyboard() }
      );
    });

    // /accounts
    this.bot.command('accounts', async (ctx) => {
      await this.showAccounts(ctx);
    });

    // /add_account
    this.bot.command('add_account', async (ctx) => {
      await this.startAddAccount(ctx);
    });

    // /filters
    this.bot.command('filters', async (ctx) => {
      await this.showFilters(ctx);
    });

    // /add_filter
    this.bot.command('add_filter', async (ctx) => {
      await this.startAddFilter(ctx);
    });

    // /start_sniper
    this.bot.command('start_sniper', async (ctx) => {
      await this.startSniper(ctx);
    });

    // /stop_sniper
    this.bot.command('stop_sniper', async (ctx) => {
      await this.stopSniper(ctx);
    });

    // /status
    this.bot.command('status', async (ctx) => {
      await this.showStatus(ctx);
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
      await ctx.reply(
        `📖 Допомога\n\n` +
        `Як почати:\n` +
        `1️⃣ Додайте EA акаунт через /add_account\n` +
        `2️⃣ Створіть фільтр через /add_filter\n` +
        `3️⃣ Запустіть снайпер через /start_sniper\n\n` +
        `Як отримати cookies:\n` +
        `1. Відкрийте Web App EA FC\n` +
        `2. Натисніть F12 - Network\n` +
        `3. Оновіть сторінку\n` +
        `4. Знайдіть запит до fut.ea.com\n` +
        `5. Скопіюйте cookies з Headers\n\n` +
        `Типи фільтрів:\n` +
        `- По гравцю - вкажіть конкретного гравця\n` +
        `- По критеріям - ліга, клуб, нація\n\n` +
        `⚠️ Увага: Використовуйте на свій ризик!`
      );
    });

    // Handle keyboard buttons
    this.bot.hears('📱 Акаунти', async (ctx) => {
      await this.showAccounts(ctx);
    });

    this.bot.hears('🎯 Фільтри', async (ctx) => {
      await this.showFilters(ctx);
    });

    this.bot.hears('▶️ Старт', async (ctx) => {
      await this.startSniper(ctx);
    });

    this.bot.hears('⏹ Стоп', async (ctx) => {
      await this.stopSniper(ctx);
    });

    this.bot.hears('📊 Статус', async (ctx) => {
      await this.showStatus(ctx);
    });

    this.bot.hears('📈 Статистика', async (ctx) => {
      await this.showStats(ctx);
    });

    // Handle text messages (for states)
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
      const accountId = ctx.match[1];
      await this.showAccountDetails(ctx, accountId);
    });

    // Delete account
    this.bot.action(/^delete_account_(.+)$/, async (ctx) => {
      const accountId = ctx.match[1];
      await db.deleteEAAccount(accountId);
      await ctx.answerCbQuery('✅ Акаунт видалено');
      await this.showAccounts(ctx);
    });

    // Update cookies
    this.bot.action(/^update_cookies_(.+)$/, async (ctx) => {
      const accountId = ctx.match[1];
      this.userStates.set(ctx.from!.id, {
        step: 'update_cookies',
        data: { accountId }
      });
      await ctx.reply('🍪 Надішліть нові cookies у форматі JSON:');
    });

    // Filter selection
    this.bot.action(/^filter_(.+)$/, async (ctx) => {
      const filterId = ctx.match[1];
      await this.showFilterDetails(ctx, filterId);
    });

    // Toggle filter
    this.bot.action(/^toggle_filter_(.+)_(.+)$/, async (ctx) => {
      const filterId = ctx.match[1];
      const newState = ctx.match[2] === 'on';
      await db.toggleFilter(filterId, newState);
      await ctx.answerCbQuery(newState ? '✅ Фільтр увімкнено' : '⏸ Фільтр вимкнено');
      await this.showFilters(ctx);
    });

    // Delete filter
    this.bot.action(/^delete_filter_(.+)$/, async (ctx) => {
      const filterId = ctx.match[1];
      await db.deleteFilter(filterId);
      await ctx.answerCbQuery('✅ Фільтр видалено');
      await this.showFilters(ctx);
    });

    // Start sniper for specific account
    this.bot.action(/^start_sniper_(.+)$/, async (ctx) => {
      const accountId = ctx.match[1];
      await this.startSniperForAccount(ctx, accountId);
    });

    // Stop sniper for specific account
    this.bot.action(/^stop_sniper_(.+)$/, async (ctx) => {
      const accountId = ctx.match[1];
      await sniperEngine.stopSession(accountId);
      await ctx.answerCbQuery('⏹ Снайпер зупинено');
      await this.showStatus(ctx);
    });

// Platform selection
    this.bot.action(/^platform_(.+)$/, async (ctx) => {
      const platform = ctx.match[1] as 'ps' | 'xbox' | 'pc';
      const state = this.userStates.get(ctx.from!.id);
      if (state && state.step === 'add_account_platform') {
        state.data.platform = platform;
        state.step = 'add_account_cookies';
        await ctx.reply(
          '🍪 Надішліть cookies\n\n' +
          'Як отримати:\n' +
          '1. Відкрийте https://www.ea.com/ea-sports-fc/ultimate-team/web-app\n' +
          '2. Увійдіть в акаунт\n' +
          '3. Натисніть F12 (DevTools)\n' +
          '4. Вкладка Application - Cookies - ea.com\n' +
          '5. Скопіюйте значення sid, personaId, nucleusId\n\n' +
          'Надішліть у форматі:\n' +
          '{"sid":"xxx","personaId":"xxx","nucleusId":"xxx"}'
        );
      }
    });

    // Add account / filter buttons
    this.bot.action('add_account', async (ctx) => {
      await ctx.answerCbQuery();
      await this.startAddAccount(ctx);
    });

    this.bot.action('add_filter', async (ctx) => {
      await ctx.answerCbQuery();
      await this.startAddFilter(ctx);
    });

    // Main menu buttons
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

    this.bot.action('stats', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showStats(ctx);
    });
  }

  // ==========================================
  // SNIPER EVENTS
  // ==========================================
  private setupSniperEvents(): void {
    sniperEngine.on('item_purchased', async (data) => {
      const { accountId, item, buyPrice, sellPrice } = data;
      
      // Find user for this account
      const accounts = await this.getAccountsByAccountId(accountId);
      if (!accounts.length) return;

      const user = await db.getUserByTelegramId(accounts[0].user_id as any);
      if (!user) return;

      await this.bot.telegram.sendMessage(
        user.telegram_id,
        `✅ *Куплено!*\n\n` +
        `👤 ${EAAPI.getPlayerName(item)}\n` +
        `💰 Ціна: ${buyPrice.toLocaleString()} монет\n` +
        `🏷️ Буде продано за: ${sellPrice?.toLocaleString() || 'N/A'} монет`,
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
        `💵 Продано за: ${sellPrice.toLocaleString()} монет`,
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
        `Оновіть cookies для продовження роботи.\n` +
        `Використайте /accounts`,
        { parse_mode: 'Markdown' }
      );
    });

    sniperEngine.on('captcha_required', async (data) => {
      const { accountId } = data;
      
      const accounts = await this.getAccountsByAccountId(accountId);
      if (!accounts.length) return;

      const user = await db.getUserByTelegramId(accounts[0].user_id as any);
      if (!user) return;

      await this.bot.telegram.sendMessage(
        user.telegram_id,
        `🔐 *Потрібна капча!*\n\n` +
        `Зайдіть у Web App та пройдіть перевірку.\n` +
        `Снайпер буде автоматично продовжено.`,
        { parse_mode: 'Markdown' }
      );
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

    const buttons = accounts.map(acc => [
      Markup.button.callback(
        `${acc.platform.toUpperCase()} | ${acc.email} | ${acc.coins.toLocaleString()}💰`,
        `account_${acc.id}`
      )
    ]);

    buttons.push([Markup.button.callback('➕ Додати акаунт', 'add_account')]);

    await ctx.reply(
      `📱 *Ваші EA акаунти:*`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  }

  private async showAccountDetails(ctx: BotContext, accountId: string): Promise<void> {
    const accountData = await db.getEAAccountWithCookies(accountId);
    if (!accountData) {
      await ctx.answerCbQuery('❌ Акаунт не знайдено');
      return;
    }

    const { account } = accountData;
    const session = sniperEngine.getSession(accountId);

    let statusText = '⏹ Зупинено';
    if (session) {
      switch (session.status) {
        case 'running': statusText = '🟢 Працює'; break;
        case 'paused': statusText = '⏸ Пауза'; break;
        case 'error': statusText = '🔴 Помилка'; break;
      }
    }

    await ctx.editMessageText(
      `📱 *Акаунт: ${account.email}*\n\n` +
      `🎮 Платформа: ${account.platform.toUpperCase()}\n` +
      `💰 Монети: ${account.coins.toLocaleString()}\n` +
      `📊 Статус: ${statusText}\n` +
      `🕐 Останній вхід: ${account.last_login ? new Date(account.last_login).toLocaleString('uk-UA') : 'Ніколи'}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            session?.status === 'running'
              ? Markup.button.callback('⏹ Зупинити', `stop_sniper_${accountId}`)
              : Markup.button.callback('▶️ Запустити', `start_sniper_${accountId}`)
          ],
          [Markup.button.callback('🍪 Оновити cookies', `update_cookies_${accountId}`)],
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
      await ctx.answerCbQuery('❌ Фільтр не знайдено');
      return;
    }

    await ctx.editMessageText(
      `🎯 *Фільтр: ${filter.name}*\n\n` +
      `📊 Статус: ${filter.is_active ? '🟢 Активний' : '⏸ Вимкнено'}\n` +
      `💰 Max Buy: ${filter.max_buy.toLocaleString()}\n` +
      `💵 Sell Price: ${filter.sell_price?.toLocaleString() || 'Auto'}\n` +
      (filter.player_id ? `👤 Player ID: ${filter.player_id}\n` : '') +
      (filter.position ? `📍 Position: ${filter.position}\n` : '') +
      (filter.league ? `🏆 League: ${filter.league}\n` : '') +
      (filter.nation ? `🌍 Nation: ${filter.nation}\n` : ''),
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
      await ctx.reply('❌ Спочатку додайте EA акаунт через /add_account');
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
      await ctx.reply('❌ Спочатку додайте EA акаунт через /add_account');
      return;
    }

    const buttons = accounts.map(acc => {
      const session = sniperEngine.getSession(acc.id);
      const status = session?.status === 'running' ? '🟢' : '⏹';
      return [
        Markup.button.callback(
          `${status} ${acc.platform.toUpperCase()} | ${acc.email}`,
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

    await ctx.answerCbQuery('🚀 Запуск...');

    const success = await sniperEngine.startSession(accountId, ctx.user.id);

    if (success) {
      await ctx.reply('✅ Снайпер запущено!');
    } else {
      await ctx.reply('❌ Помилка запуску. Перевірте cookies.');
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

  private async showStatus(ctx: BotContext): Promise<void> {
    if (!ctx.user) return;

    const accounts = await db.getEAAccountsByUser(ctx.user.id);
    
    let statusText = '📊 *Статус бота*\n\n';

    for (const acc of accounts) {
      const session = sniperEngine.getSession(acc.id);
      
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
        statusText += `├ Витрачено: ${session.stats.spent.toLocaleString()}💰\n`;
        statusText += `└ Прибуток: ${session.stats.profit.toLocaleString()}💰\n\n`;
      } else {
        statusText += `└ Статус: ⏹ Не запущено\n\n`;
      }
    }

    await ctx.reply(statusText, { parse_mode: 'Markdown' });
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
    let totalPurchases = 0;
    let totalSales = 0;

    for (const stat of history) {
      statsText += `📅 ${stat.date}\n`;
      statsText += `├ Покупок: ${stat.purchases}\n`;
      statsText += `├ Продажів: ${stat.sales}\n`;
      statsText += `└ Прибуток: ${stat.profit.toLocaleString()}💰\n\n`;

      totalProfit += stat.profit;
      totalPurchases += stat.purchases;
      totalSales += stat.sales;
    }

    statsText += `*Всього:*\n`;
    statsText += `├ Покупок: ${totalPurchases}\n`;
    statsText += `├ Продажів: ${totalSales}\n`;
    statsText += `└ Прибуток: ${totalProfit.toLocaleString()}💰`;

    await ctx.reply(statsText, { parse_mode: 'Markdown' });
  }

  private async searchPrices(ctx: BotContext, query: string): Promise<void> {
    await ctx.reply('🔍 Шукаю...');

    const players = await priceService.searchPlayer(query);

    if (players.length === 0) {
      await ctx.reply('❌ Гравців не знайдено');
      return;
    }

    // Get prices for top 5 results
    const topPlayers = players.slice(0, 5);
    
    let resultText = `🔍 *Результати для "${query}":*\n\n`;

    for (const player of topPlayers) {
      const price = await priceService.getPrice(player.id, 'ps');
      
      resultText += `*${player.name}* (${player.rating})\n`;
      resultText += `├ ID: ${player.id}\n`;
      resultText += `├ FUTBIN: ${price.futbinPrice?.toLocaleString() || 'N/A'}💰\n`;
      resultText += `├ FUT.GG: ${price.futggPrice?.toLocaleString() || 'N/A'}💰\n`;
      resultText += `└ Lowest: ${price.lowestBin?.toLocaleString() || 'N/A'}💰\n\n`;
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

      case 'add_account_cookies':
        try {
          const cookies = JSON.parse(text);
          
          if (!cookies.sid || !cookies.personaId || !cookies.nucleusId) {
            await ctx.reply(
              '❌ Невірний формат! Потрібні поля: sid, personaId, nucleusId\n\n' +
              'Приклад:\n' +
              '{"sid":"xxx","personaId":"xxx","nucleusId":"xxx"}'
            );
            return;
          }

          const account = await db.addEAAccount(
            ctx.user!.id,
            state.data.email,
            state.data.platform,
            cookies
          );

          this.userStates.delete(ctx.from!.id);

          await ctx.reply(
            `✅ Акаунт додано!\n\n` +
            `📧 Email: ${state.data.email}\n` +
            `🎮 Платформа: ${state.data.platform.toUpperCase()}\n\n` +
            `Наступний крок - створіть фільтр:\n` +
            `/add_filter`
          );
        } catch (error) {
          await ctx.reply(
            '❌ Невірний формат JSON!\n\n' +
            'Надішліть у форматі:\n' +
            '{"sid":"ваш_sid","personaId":"ваш_id","nucleusId":"ваш_nucleus"}'
          );
        }
        break;

      case 'update_cookies':
        try {
          const cookies = JSON.parse(text);

          if (!cookies.sid || !cookies.personaId || !cookies.nucleusId) {
            await ctx.reply(
              '❌ Невірний формат! Потрібні поля: sid, personaId, nucleusId'
            );
            return;
          }

          await db.updateEAAccountSession(state.data.accountId, { cookies });

          this.userStates.delete(ctx.from!.id);

          await ctx.reply('✅ Cookies успішно оновлено!');
        } catch (error) {
          await ctx.reply(
            '❌ Невірний формат JSON!\n\n' +
            'Надішліть у форматі:\n' +
            '{"sid":"ваш_sid","personaId":"ваш_id","nucleusId":"ваш_nucleus"}'
          );
        }
        break;

      case 'add_filter_name':
        state.data.name = text;
        state.step = 'add_filter_max_buy';
        await ctx.reply(
          '💰 Введіть максимальну ціну покупки (в монетах):\n\n' +
          'Приклад: 10000'
        );
        break;

      case 'add_filter_max_buy':
        const maxBuy = parseInt(text.replace(/\s/g, ''));
        if (isNaN(maxBuy) || maxBuy <= 0) {
          await ctx.reply('❌ Введіть коректне число більше 0:');
          return;
        }
        state.data.maxBuy = maxBuy;
        state.step = 'add_filter_sell_price';
        await ctx.reply(
          '💵 Введіть ціну продажу:\n\n' +
          `• Введіть число (наприклад: ${Math.floor(maxBuy * 1.1)})\n` +
          '• Або напишіть "auto" для авто-розрахунку (+10%)'
        );
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
            player_id: state.data.playerId || null,
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

          const profitInfo = sellPrice
            ? `${(sellPrice - state.data.maxBuy).toLocaleString()} монет`
            : 'авто-розрахунок';

          await ctx.reply(
            `✅ Фільтр створено!\n\n` +
            `📝 Назва: ${state.data.name}\n` +
            `💰 Макс. покупка: ${state.data.maxBuy.toLocaleString()}\n` +
            `💵 Ціна продажу: ${sellPrice?.toLocaleString() || 'Auto'}\n` +
            `📈 Прибуток: ${profitInfo}\n\n` +
            `Запустіть снайпер: /start_sniper`
          );
        } catch (error) {
          await ctx.reply('❌ Помилка створення фільтра. Спробуйте ще раз.');
          logger.error('Filter creation error:', error);
        }
        break;

      default:
        this.userStates.delete(ctx.from!.id);
        await ctx.reply('❓ Невідома команда. Почніть спочатку: /start');
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================
  private getMainKeyboard() {
    return Markup.keyboard([
      ['📱 Акаунти', '🎯 Фільтри'],
      ['▶️ Старт', '⏹ Стоп'],
      ['📊 Статус', '📈 Статистика']
    ]).resize();
  }

  private async getAccountsByAccountId(accountId: string): Promise<EAAccount[]> {
    // This is a workaround - in production you'd want a direct query
    const { data } = await db['client']
      .from('ea_accounts')
      .select('*')
      .eq('id', accountId);
    return data || [];
  }

  // ==========================================
  // START BOT
  // ==========================================
  async start(): Promise<void> {
    // Set bot commands
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Почати роботу' },
      { command: 'accounts', description: 'Керування акаунтами' },
      { command: 'filters', description: 'Керування фільтрами' },
      { command: 'start_sniper', description: 'Запустити снайпер' },
      { command: 'stop_sniper', description: 'Зупинити снайпер' },
      { command: 'status', description: 'Статус бота' },
      { command: 'stats', description: 'Статистика' },
      { command: 'prices', description: 'Перевірити ціни' },
      { command: 'help', description: 'Допомога' }
    ]);

    // Start bot
    await this.bot.launch();
    logger.info('🤖 Telegram bot started');

    // Graceful shutdown
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

export const telegramBot = new TelegramBot();
