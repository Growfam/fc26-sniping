/**
 * FC26 Sniper Bot v3.1
 * Telegram bot for filter management with player_id support
 */

import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

// ==========================================
// CONFIG
// ==========================================
const config = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseKey: process.env.SUPABASE_SERVICE_KEY || '',
};

if (!config.botToken || !config.supabaseUrl || !config.supabaseKey) {
    console.error('Missing environment variables!');
    process.exit(1);
}

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

// ==========================================
// MAIN KEYBOARD
// ==========================================
const mainKeyboard = Markup.keyboard([
    ['📋 Фільтри', '➕ Додати фільтр'],
    ['📊 Статистика', '📜 Історія']
]).resize();

// ==========================================
// DATABASE
// ==========================================
async function getOrCreateUser(telegramId: number, username: string) {
    const { data: existing } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

    if (existing) return existing;

    const { data: newUser } = await supabase
        .from('users')
        .insert({ telegram_id: telegramId, username })
        .select()
        .single();

    return newUser;
}

async function getFilters(userId: number) {
    const { data } = await supabase
        .from('sniper_filters')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
    return data || [];
}

async function addFilter(userId: number, filter: any) {
    const { data } = await supabase
        .from('sniper_filters')
        .insert({ user_id: userId, ...filter })
        .select()
        .single();
    return data;
}

async function toggleFilter(filterId: string, active: boolean) {
    await supabase
        .from('sniper_filters')
        .update({ is_active: active })
        .eq('id', filterId);
}

async function deleteFilter(filterId: string) {
    await supabase
        .from('sniper_filters')
        .delete()
        .eq('id', filterId);
}

async function getStats(userId: number) {
    const { data } = await supabase
        .from('sniper_stats')
        .select('*')
        .eq('user_id', userId)
        .single();
    return data;
}

async function getPurchaseLog(userId: number, limit = 10) {
    const { data } = await supabase
        .from('purchase_log')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
    return data || [];
}

// ==========================================
// BOT
// ==========================================
const bot = new Telegraf(config.botToken);

// User state for multi-step flows
const userStates = new Map<number, any>();

// Middleware - get user
bot.use(async (ctx, next) => {
    if (ctx.from) {
        await getOrCreateUser(ctx.from.id, ctx.from.username || '');
    }
    return next();
});

// ==========================================
// START
// ==========================================
bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    await ctx.reply(
        `👋 *FC26 Sniper Bot v3.1*\n\n` +
        `📝 *Ваш ID:* \`${userId}\`\n\n` +
        `Використовуйте кнопки нижче для керування фільтрами.\n\n` +
        `💡 *Як користуватись:*\n` +
        `1. Додайте фільтр з FUTBIN ID\n` +
        `2. Відкрийте FUT Web App\n` +
        `3. Натисніть СТАРТ в панелі`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

bot.command('help', async (ctx) => {
    await ctx.reply(
        `📚 *Допомога*\n\n` +
        `*Як знайти Player ID:*\n` +
        `1. Відкрийте futbin.com\n` +
        `2. Знайдіть потрібного гравця\n` +
        `3. ID в URL: futbin.com/26/player/*21743*/rooney\n\n` +
        `*Кнопки:*\n` +
        `📋 Фільтри - переглянути/видалити\n` +
        `➕ Додати - новий фільтр\n` +
        `📊 Статистика - пошуки/покупки\n` +
        `📜 Історія - останні покупки`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

// ==========================================
// FILTERS LIST
// ==========================================
async function showFilters(ctx: any) {
    const filters = await getFilters(ctx.from!.id);

    if (filters.length === 0) {
        await ctx.reply(
            '📭 У вас немає фільтрів.\n\nНатисніть "➕ Додати фільтр"',
            mainKeyboard
        );
        return;
    }

    let text = '🎯 *Ваші фільтри:*\n\n';
    const buttons: any[] = [];

    filters.forEach((f: any, i: number) => {
        const status = f.is_active ? '✅' : '❌';
        text += `${i + 1}. ${status} *${f.player_name || 'Без імені'}*\n`;
        text += `   ID: \`${f.player_id || '-'}\`\n`;
        text += `   Max: ${f.max_buy_price?.toLocaleString()}\n`;
        text += `   Sell: ${f.sell_price?.toLocaleString()}\n\n`;

        buttons.push([
            Markup.button.callback(
                `${status} ${f.player_name || `Фільтр ${i+1}`}`,
                `info_${f.id}`
            )
        ]);
    });

    buttons.push([Markup.button.callback('➕ Додати новий', 'add_filter')]);

    await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
}

bot.command('filters', showFilters);
bot.hears('📋 Фільтри', showFilters);

// Filter info/actions
bot.action(/^info_(.+)$/, async (ctx) => {
    const filterId = ctx.match[1];
    const filters = await getFilters(ctx.from!.id);
    const filter = filters.find((f: any) => f.id === filterId);

    if (!filter) {
        await ctx.answerCbQuery('Фільтр не знайдено');
        return;
    }

    const status = filter.is_active ? '✅ Активний' : '❌ Вимкнений';

    await ctx.editMessageText(
        `🎯 *${filter.player_name || 'Фільтр'}*\n\n` +
        `📊 Статус: ${status}\n` +
        `🆔 Player ID: \`${filter.player_id || '-'}\`\n` +
        `💰 Max ціна: ${filter.max_buy_price?.toLocaleString()}\n` +
        `💵 Sell ціна: ${filter.sell_price?.toLocaleString()}\n`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        filter.is_active ? '⏸ Вимкнути' : '▶️ Увімкнути',
                        `toggle_${filterId}`
                    ),
                    Markup.button.callback('🗑 Видалити', `delete_${filterId}`)
                ],
                [Markup.button.callback('◀️ Назад', 'back_to_filters')]
            ])
        }
    );
});

bot.action(/^toggle_(.+)$/, async (ctx) => {
    const filterId = ctx.match[1];
    const filters = await getFilters(ctx.from!.id);
    const filter = filters.find((f: any) => f.id === filterId);

    if (filter) {
        await toggleFilter(filterId, !filter.is_active);
        await ctx.answerCbQuery(filter.is_active ? '⏸ Вимкнено' : '▶️ Увімкнено');
    }

    // Refresh
    await showFilters(ctx);
    await ctx.deleteMessage().catch(() => {});
});

bot.action(/^delete_(.+)$/, async (ctx) => {
    const filterId = ctx.match[1];
    await deleteFilter(filterId);
    await ctx.answerCbQuery('🗑 Видалено');
    await ctx.deleteMessage().catch(() => {});
    await showFilters(ctx);
});

bot.action('back_to_filters', async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
    await showFilters(ctx);
});

// ==========================================
// ADD FILTER FLOW
// ==========================================
async function startAddFilter(ctx: any) {
    userStates.set(ctx.from!.id, { step: 'player_id' });
    await ctx.reply(
        '➕ *Новий фільтр*\n\n' +
        '🆔 Введіть Player ID з FUTBIN:\n\n' +
        '_Приклад: `21743` (Rooney TOTY)_\n' +
        '_URL: futbin.com/26/player/*21743*/rooney_\n\n' +
        'Або "-" щоб пропустити (шукатиме по імені)',
        { parse_mode: 'Markdown' }
    );
}

bot.command('add', startAddFilter);
bot.hears('➕ Додати фільтр', startAddFilter);
bot.action('add_filter', async (ctx) => {
    await ctx.answerCbQuery();
    await startAddFilter(ctx);
});

// ==========================================
// STATS
// ==========================================
async function showStats(ctx: any) {
    const stats = await getStats(ctx.from!.id);

    if (!stats) {
        await ctx.reply(
            '📊 Статистика поки пуста.\n\nЗапустіть снайпер в браузері.',
            mainKeyboard
        );
        return;
    }

    await ctx.reply(
        `📊 *Статистика*\n\n` +
        `🔍 Пошуків: ${stats.searches?.toLocaleString() || 0}\n` +
        `👀 Знайдено: ${stats.found?.toLocaleString() || 0}\n` +
        `✅ Куплено: ${stats.bought?.toLocaleString() || 0}\n` +
        `💰 Профіт: ${stats.profit?.toLocaleString() || 0}\n` +
        `❌ Помилок: ${stats.errors || 0}\n\n` +
        `🕐 Оновлено: ${stats.updated_at ? new Date(stats.updated_at).toLocaleString('uk-UA') : '-'}`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
}

bot.command('stats', showStats);
bot.hears('📊 Статистика', showStats);

// ==========================================
// PURCHASE LOG
// ==========================================
async function showLog(ctx: any) {
    const purchases = await getPurchaseLog(ctx.from!.id);

    if (purchases.length === 0) {
        await ctx.reply('📜 Історія покупок пуста.', mainKeyboard);
        return;
    }

    let text = '📜 *Останні покупки:*\n\n';
    purchases.forEach((p: any) => {
        const time = new Date(p.created_at).toLocaleString('uk-UA');
        text += `✅ *${p.player_name || 'Гравець'}*\n`;
        text += `   ${p.buy_price?.toLocaleString()} → ${p.sell_price?.toLocaleString()}\n`;
        text += `   Профіт: +${p.profit?.toLocaleString()}\n`;
        text += `   _${time}_\n\n`;
    });

    await ctx.reply(text, { parse_mode: 'Markdown', ...mainKeyboard });
}

bot.command('log', showLog);
bot.hears('📜 Історія', showLog);

// ==========================================
// TEXT HANDLER (for add filter flow)
// ==========================================
bot.on('text', async (ctx) => {
    const state = userStates.get(ctx.from!.id);
    if (!state) return;

    const text = ctx.message.text.trim();

    // Ignore keyboard buttons
    if (['📋 Фільтри', '➕ Додати фільтр', '📊 Статистика', '📜 Історія'].includes(text)) {
        return;
    }

    switch (state.step) {
        case 'player_id':
            if (text === '-') {
                state.player_id = null;
            } else {
                const playerId = parseInt(text.replace(/\D/g, ''));
                if (isNaN(playerId)) {
                    await ctx.reply('❌ Невірний ID. Введіть число або "-":');
                    return;
                }
                state.player_id = playerId;
            }
            state.step = 'player_name';
            await ctx.reply('📝 Введіть назву (для себе, напр. "Rooney TOTY"):');
            break;

        case 'player_name':
            state.player_name = text;
            state.step = 'max_buy';
            await ctx.reply('💰 Введіть максимальну ціну покупки (BIN):');
            break;

        case 'max_buy':
            const maxBuy = parseInt(text.replace(/\D/g, ''));
            if (isNaN(maxBuy) || maxBuy < 200) {
                await ctx.reply('❌ Мінімум 200. Спробуйте ще:');
                return;
            }
            state.max_buy_price = maxBuy;
            state.step = 'sell_price';
            await ctx.reply('💵 Введіть ціну продажу:');
            break;

        case 'sell_price':
            const sellPrice = parseInt(text.replace(/\D/g, ''));
            if (isNaN(sellPrice)) {
                await ctx.reply('❌ Невірна ціна. Спробуйте ще:');
                return;
            }
            state.sell_price = sellPrice;

            // Save filter
            await addFilter(ctx.from!.id, {
                player_name: state.player_name,
                player_id: state.player_id,
                max_buy_price: state.max_buy_price,
                sell_price: state.sell_price,
                is_active: true
            });

            userStates.delete(ctx.from!.id);

            const profit = sellPrice - state.max_buy_price - Math.floor(sellPrice * 0.05);
            await ctx.reply(
                `✅ *Фільтр додано!*\n\n` +
                `📝 ${state.player_name}\n` +
                `🆔 ID: \`${state.player_id || '-'}\`\n` +
                `💰 Max: ${state.max_buy_price.toLocaleString()}\n` +
                `💵 Sell: ${sellPrice.toLocaleString()}\n` +
                `📈 Профіт: ~${profit.toLocaleString()}\n\n` +
                `✅ Фільтр активний!`,
                { parse_mode: 'Markdown', ...mainKeyboard }
            );
            break;
    }
});

// ==========================================
// START BOT
// ==========================================
console.log('Starting FC26 Sniper Bot v3.1...');
bot.launch().then(() => {
    console.log('✅ Bot started successfully!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));