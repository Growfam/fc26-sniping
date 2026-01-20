/**
 * FC26 Sniper Bot v3.0
 * Telegram bot for filter management
 * Sniping happens in browser via userscript
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
        (ctx as any).dbUser = await getOrCreateUser(ctx.from.id, ctx.from.username || '');
    }
    return next();
});

// ==========================================
// COMMANDS
// ==========================================
bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    await ctx.reply(
        `👋 *FC26 Sniper Bot v3*\n\n` +
        `Цей бот керує фільтрами для снайпера.\n` +
        `Снайпер працює в браузері через userscript.\n\n` +
        `📝 *Ваш ID:* \`${userId}\`\n` +
        `(потрібен для налаштування скрипта)\n\n` +
        `*Команди:*\n` +
        `/filters - мої фільтри\n` +
        `/add - додати фільтр\n` +
        `/stats - статистика\n` +
        `/log - останні покупки\n` +
        `/help - допомога`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('help', async (ctx) => {
    await ctx.reply(
        `📚 *Як користуватись:*\n\n` +
        `1️⃣ Встановіть Tampermonkey в браузер\n` +
        `2️⃣ Встановіть userscript fc26-sniper\n` +
        `3️⃣ Вставте ваш ID: \`${ctx.from?.id}\`\n` +
        `4️⃣ Налаштуйте фільтри тут в боті\n` +
        `5️⃣ Відкрийте FUT Web App\n` +
        `6️⃣ Натисніть СТАРТ в панелі снайпера\n\n` +
        `*Команди фільтрів:*\n` +
        `/add - додати фільтр\n` +
        `/filters - переглянути фільтри\n` +
        `/stats - статистика снайпера`,
        { parse_mode: 'Markdown' }
    );
});

// ==========================================
// FILTERS
// ==========================================
bot.command('filters', async (ctx) => {
    const filters = await getFilters(ctx.from!.id);
    
    if (filters.length === 0) {
        await ctx.reply(
            '📭 У вас немає фільтрів.\n\nДодайте через /add',
            Markup.inlineKeyboard([[
                Markup.button.callback('➕ Додати фільтр', 'add_filter')
            ]])
        );
        return;
    }

    let text = '🎯 *Ваші фільтри:*\n\n';
    const buttons: any[] = [];

    filters.forEach((f: any, i: number) => {
        const status = f.is_active ? '✅' : '❌';
        text += `${status} *${f.player_name || `Фільтр ${i+1}`}*\n`;
        text += `   Max: ${f.max_buy_price?.toLocaleString() || '-'}\n`;
        text += `   Sell: ${f.sell_price?.toLocaleString() || '-'}\n\n`;
        
        buttons.push([
            Markup.button.callback(
                f.is_active ? '⏸️' : '▶️', 
                `toggle_${f.id}`
            ),
            Markup.button.callback('🗑️', `delete_${f.id}`)
        ]);
    });

    buttons.push([Markup.button.callback('➕ Додати', 'add_filter')]);

    await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
});

bot.action(/^toggle_(.+)$/, async (ctx) => {
    const filterId = ctx.match[1];
    const filters = await getFilters(ctx.from!.id);
    const filter = filters.find((f: any) => f.id === filterId);
    
    if (filter) {
        await toggleFilter(filterId, !filter.is_active);
        await ctx.answerCbQuery(filter.is_active ? 'Вимкнено' : 'Увімкнено');
        
        // Refresh list
        const newFilters = await getFilters(ctx.from!.id);
        let text = '🎯 *Ваші фільтри:*\n\n';
        const buttons: any[] = [];

        newFilters.forEach((f: any, i: number) => {
            const status = f.is_active ? '✅' : '❌';
            text += `${status} *${f.player_name || `Фільтр ${i+1}`}*\n`;
            text += `   Max: ${f.max_buy_price?.toLocaleString() || '-'}\n`;
            text += `   Sell: ${f.sell_price?.toLocaleString() || '-'}\n\n`;
            
            buttons.push([
                Markup.button.callback(f.is_active ? '⏸️' : '▶️', `toggle_${f.id}`),
                Markup.button.callback('🗑️', `delete_${f.id}`)
            ]);
        });
        buttons.push([Markup.button.callback('➕ Додати', 'add_filter')]);

        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        });
    }
});

bot.action(/^delete_(.+)$/, async (ctx) => {
    const filterId = ctx.match[1];
    await deleteFilter(filterId);
    await ctx.answerCbQuery('Видалено');
    await ctx.deleteMessage();
});

// ==========================================
// ADD FILTER FLOW
// ==========================================
bot.command('add', async (ctx) => {
    userStates.set(ctx.from!.id, { step: 'player_name' });
    await ctx.reply(
        '➕ *Новий фільтр*\n\n' +
        'Введіть імʼя гравця (або "-" щоб пропустити):',
        { parse_mode: 'Markdown' }
    );
});

bot.action('add_filter', async (ctx) => {
    await ctx.answerCbQuery();
    userStates.set(ctx.from!.id, { step: 'player_name' });
    await ctx.reply(
        '➕ *Новий фільтр*\n\n' +
        'Введіть імʼя гравця (або "-" щоб пропустити):',
        { parse_mode: 'Markdown' }
    );
});

bot.on('text', async (ctx) => {
    const state = userStates.get(ctx.from!.id);
    if (!state) return;

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return; // Ignore commands

    switch (state.step) {
        case 'player_name':
            state.player_name = text === '-' ? null : text;
            state.step = 'max_buy';
            await ctx.reply('💰 Введіть максимальну ціну покупки (BIN):');
            break;

        case 'max_buy':
            const maxBuy = parseInt(text.replace(/\D/g, ''));
            if (isNaN(maxBuy) || maxBuy < 200) {
                await ctx.reply('❌ Невірна ціна. Мінімум 200. Спробуйте ще:');
                return;
            }
            state.max_buy_price = maxBuy;
            state.step = 'sell_price';
            await ctx.reply('💵 Введіть ціну продажу (для розрахунку профіту):');
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
                max_buy_price: state.max_buy_price,
                sell_price: state.sell_price,
                is_active: true
            });

            userStates.delete(ctx.from!.id);

            const profit = sellPrice - state.max_buy_price - Math.floor(sellPrice * 0.05);
            await ctx.reply(
                `✅ *Фільтр додано!*\n\n` +
                `🎮 ${state.player_name || 'Без імені'}\n` +
                `💰 Max: ${state.max_buy_price.toLocaleString()}\n` +
                `💵 Sell: ${sellPrice.toLocaleString()}\n` +
                `📈 Профіт: ~${profit.toLocaleString()}\n\n` +
                `Фільтр автоматично активний.`,
                { parse_mode: 'Markdown' }
            );
            break;
    }
});

// ==========================================
// STATS
// ==========================================
bot.command('stats', async (ctx) => {
    const stats = await getStats(ctx.from!.id);
    
    if (!stats) {
        await ctx.reply('📊 Статистика поки пуста. Запустіть снайпер в браузері.');
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
        { parse_mode: 'Markdown' }
    );
});

bot.command('log', async (ctx) => {
    const purchases = await getPurchaseLog(ctx.from!.id);
    
    if (purchases.length === 0) {
        await ctx.reply('📜 Історія покупок пуста.');
        return;
    }

    let text = '📜 *Останні покупки:*\n\n';
    purchases.forEach((p: any) => {
        const time = new Date(p.created_at).toLocaleString('uk-UA');
        text += `✅ ${p.player_name || 'Гравець'}\n`;
        text += `   ${p.buy_price?.toLocaleString()} → ${p.sell_price?.toLocaleString()}\n`;
        text += `   Профіт: ${p.profit?.toLocaleString()}\n`;
        text += `   ${time}\n\n`;
    });

    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ==========================================
// START
// ==========================================
console.log('Starting FC26 Sniper Bot...');
bot.launch().then(() => {
    console.log('✅ Bot started successfully!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
