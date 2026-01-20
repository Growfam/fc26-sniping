import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import CryptoJS from 'crypto-js';

// ==========================================
// DATABASE TYPES
// ==========================================
export interface User {
  id: string;
  telegram_id: number;
  username: string | null;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface EAAccount {
  id: string;
  user_id: string;
  email: string;
  platform: 'ps' | 'xbox' | 'pc';
  persona_id: string | null;
  nucleus_id: string | null;
  session_id: string | null;
  phishing_token: string | null;
  cookies_encrypted: string | null;
  coins: number;
  is_active: boolean;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

export interface SniperFilter {
  id: string;
  user_id: string;
  ea_account_id: string;
  name: string;
  player_id: number | null;
  min_buy: number | null;
  max_buy: number;
  sell_price: number | null;
  position: string | null;
  quality: string | null;
  rarity: string | null;
  nation: number | null;
  league: number | null;
  club: number | null;
  is_active: boolean;
  created_at: string;
}

export interface Transaction {
  id: string;
  user_id: string;
  ea_account_id: string;
  filter_id: string | null;
  player_id: number;
  player_name: string;
  buy_price: number;
  sell_price: number | null;
  profit: number | null;
  status: 'bought' | 'listed' | 'sold' | 'expired';
  trade_id: string;
  created_at: string;
  sold_at: string | null;
}

export interface PriceCache {
  player_id: number;
  platform: string;
  futbin_price: number | null;
  futgg_price: number | null;
  lowest_bin: number | null;
  updated_at: string;
}

export interface BotStats {
  id: string;
  user_id: string;
  ea_account_id: string;
  date: string;
  searches: number;
  purchases: number;
  sales: number;
  profit: number;
  coins_start: number;
  coins_end: number;
}

// ==========================================
// SUPABASE CLIENT
// ==========================================
class Database {
  private client: SupabaseClient;

  constructor() {
    this.client = createClient(
      config.supabase.url,
      config.supabase.serviceKey
    );
  }

  // ==========================================
  // ENCRYPTION HELPERS
  // ==========================================
  encryptData(data: string): string {
    return CryptoJS.AES.encrypt(data, config.security.encryptionKey).toString();
  }

  decryptData(encryptedData: string): string {
    const bytes = CryptoJS.AES.decrypt(encryptedData, config.security.encryptionKey);
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  // ==========================================
  // USER OPERATIONS
  // ==========================================
  async getOrCreateUser(telegramId: number, username: string | null): Promise<User> {
    // Спробуємо знайти існуючого користувача
    const { data: existing } = await this.client
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (existing) {
      return existing as User;
    }

    // Створюємо нового
    const { data: newUser, error } = await this.client
      .from('users')
      .insert({
        telegram_id: telegramId,
        username: username,
        is_active: true,
        is_admin: config.telegram.adminIds.includes(telegramId)
      })
      .select()
      .single();

    if (error) throw error;
    return newUser as User;
  }

  async getUserByTelegramId(telegramId: number): Promise<User | null> {
    const { data } = await this.client
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    return data as User | null;
  }

  // ==========================================
  // EA ACCOUNT OPERATIONS
  // ==========================================
  async addEAAccount(
    userId: string,
    email: string,
    platform: 'ps' | 'xbox' | 'pc',
    cookies: object
  ): Promise<EAAccount> {
    const cookiesEncrypted = this.encryptData(JSON.stringify(cookies));

    const { data, error } = await this.client
      .from('ea_accounts')
      .insert({
        user_id: userId,
        email: email,
        platform: platform,
        cookies_encrypted: cookiesEncrypted,
        is_active: true
      })
      .select()
      .single();

    if (error) throw error;
    return data as EAAccount;
  }

  async updateEAAccountSession(
    accountId: string,
    sessionData: {
      persona_id?: string;
      nucleus_id?: string;
      session_id?: string;
      phishing_token?: string;
      cookies?: object;
      coins?: number;
    }
  ): Promise<void> {
    const updateData: any = {
      updated_at: new Date().toISOString(),
      last_login: new Date().toISOString()
    };

    if (sessionData.persona_id) updateData.persona_id = sessionData.persona_id;
    if (sessionData.nucleus_id) updateData.nucleus_id = sessionData.nucleus_id;
    if (sessionData.session_id) updateData.session_id = sessionData.session_id;
    if (sessionData.phishing_token) updateData.phishing_token = sessionData.phishing_token;
    if (sessionData.coins !== undefined) updateData.coins = sessionData.coins;
    if (sessionData.cookies) {
      updateData.cookies_encrypted = this.encryptData(JSON.stringify(sessionData.cookies));
    }

    await this.client
      .from('ea_accounts')
      .update(updateData)
      .eq('id', accountId);
  }

  async getEAAccountsByUser(userId: string): Promise<EAAccount[]> {
    const { data } = await this.client
      .from('ea_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true);

    return (data || []) as EAAccount[];
  }

  async getEAAccountWithCookies(accountId: string): Promise<{ account: EAAccount; cookies: object } | null> {
    const { data } = await this.client
      .from('ea_accounts')
      .select('*')
      .eq('id', accountId)
      .single();

    if (!data || !data.cookies_encrypted) return null;

    const cookies = JSON.parse(this.decryptData(data.cookies_encrypted));
    return { account: data as EAAccount, cookies };
  }

  async deleteEAAccount(accountId: string): Promise<void> {
    await this.client
      .from('ea_accounts')
      .update({ is_active: false })
      .eq('id', accountId);
  }

  // ==========================================
  // SNIPER FILTER OPERATIONS
  // ==========================================
  async addFilter(filter: Omit<SniperFilter, 'id' | 'created_at'>): Promise<SniperFilter> {
    const { data, error } = await this.client
      .from('sniper_filters')
      .insert(filter)
      .select()
      .single();

    if (error) throw error;
    return data as SniperFilter;
  }

  async getActiveFilters(eaAccountId: string): Promise<SniperFilter[]> {
    const { data } = await this.client
      .from('sniper_filters')
      .select('*')
      .eq('ea_account_id', eaAccountId)
      .eq('is_active', true);

    return (data || []) as SniperFilter[];
  }

  async getFiltersByUser(userId: string): Promise<SniperFilter[]> {
    const { data } = await this.client
      .from('sniper_filters')
      .select('*')
      .eq('user_id', userId);

    return (data || []) as SniperFilter[];
  }

  async toggleFilter(filterId: string, isActive: boolean): Promise<void> {
    await this.client
      .from('sniper_filters')
      .update({ is_active: isActive })
      .eq('id', filterId);
  }

  async deleteFilter(filterId: string): Promise<void> {
    await this.client
      .from('sniper_filters')
      .delete()
      .eq('id', filterId);
  }

  // ==========================================
  // TRANSACTION OPERATIONS
  // ==========================================
  async recordTransaction(transaction: Omit<Transaction, 'id' | 'created_at'>): Promise<Transaction> {
    const { data, error } = await this.client
      .from('transactions')
      .insert(transaction)
      .select()
      .single();

    if (error) throw error;
    return data as Transaction;
  }

  async updateTransactionSold(transactionId: string, sellPrice: number): Promise<void> {
    const { data: tx } = await this.client
      .from('transactions')
      .select('buy_price')
      .eq('id', transactionId)
      .single();

    if (tx) {
      const profit = sellPrice - tx.buy_price - Math.floor(sellPrice * 0.05); // 5% EA tax

      await this.client
        .from('transactions')
        .update({
          sell_price: sellPrice,
          profit: profit,
          status: 'sold',
          sold_at: new Date().toISOString()
        })
        .eq('id', transactionId);
    }
  }

  async getTransactionsByUser(userId: string, limit: number = 50): Promise<Transaction[]> {
    const { data } = await this.client
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return (data || []) as Transaction[];
  }

  async getTodayStats(userId: string, eaAccountId: string): Promise<{
    purchases: number;
    sales: number;
    profit: number;
  }> {
    const today = new Date().toISOString().split('T')[0];

    const { data } = await this.client
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .eq('ea_account_id', eaAccountId)
      .gte('created_at', today);

    const transactions = (data || []) as Transaction[];

    return {
      purchases: transactions.length,
      sales: transactions.filter(t => t.status === 'sold').length,
      profit: transactions.reduce((sum, t) => sum + (t.profit || 0), 0)
    };
  }

  // ==========================================
  // PRICE CACHE OPERATIONS
  // ==========================================
  async getCachedPrice(playerId: number, platform: string): Promise<PriceCache | null> {
    const { data } = await this.client
      .from('price_cache')
      .select('*')
      .eq('player_id', playerId)
      .eq('platform', platform)
      .single();

    if (!data) return null;

    // Перевіряємо TTL
    const updatedAt = new Date(data.updated_at);
    const now = new Date();
    const diffSeconds = (now.getTime() - updatedAt.getTime()) / 1000;

    if (diffSeconds > config.prices.cacheTTL) {
      return null; // Кеш застарілий
    }

    return data as PriceCache;
  }

  async updatePriceCache(
    playerId: number,
    platform: string,
    prices: { futbin?: number; futgg?: number; lowestBin?: number }
  ): Promise<void> {
    await this.client
      .from('price_cache')
      .upsert({
        player_id: playerId,
        platform: platform,
        futbin_price: prices.futbin || null,
        futgg_price: prices.futgg || null,
        lowest_bin: prices.lowestBin || null,
        updated_at: new Date().toISOString()
      });
  }

  // ==========================================
  // STATS OPERATIONS
  // ==========================================
  async updateDailyStats(
    userId: string,
    eaAccountId: string,
    updates: Partial<BotStats>
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    const { data: existing } = await this.client
      .from('bot_stats')
      .select('*')
      .eq('user_id', userId)
      .eq('ea_account_id', eaAccountId)
      .eq('date', today)
      .single();

    if (existing) {
      await this.client
        .from('bot_stats')
        .update({
          searches: (existing.searches || 0) + (updates.searches || 0),
          purchases: (existing.purchases || 0) + (updates.purchases || 0),
          sales: (existing.sales || 0) + (updates.sales || 0),
          profit: (existing.profit || 0) + (updates.profit || 0),
          coins_end: updates.coins_end || existing.coins_end
        })
        .eq('id', existing.id);
    } else {
      await this.client
        .from('bot_stats')
        .insert({
          user_id: userId,
          ea_account_id: eaAccountId,
          date: today,
          ...updates
        });
    }
  }

  async getStatsHistory(userId: string, days: number = 7): Promise<BotStats[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data } = await this.client
      .from('bot_stats')
      .select('*')
      .eq('user_id', userId)
      .gte('date', startDate.toISOString().split('T')[0])
      .order('date', { ascending: false });

    return (data || []) as BotStats[];
  }
}

export const db = new Database();
