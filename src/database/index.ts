/**
 * FC26 Database Module - Supabase
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { logger } from '../utils/logger';
import crypto from 'crypto';

// ==========================================
// TYPES
// ==========================================

export interface User {
  id: string;
  telegram_id: number;
  username: string | null;
  created_at: string;
  is_active: boolean;
}

export interface EAAccount {
  id: string;
  user_id: string;
  email: string;
  platform: 'ps' | 'xbox' | 'pc';
  session_id: string | null;
  cookies_encrypted: string | null;
  coins: number;
  last_login: string | null;
  is_active: boolean;
  created_at: string;
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

export interface TradeHistory {
  id: string;
  ea_account_id: string;
  player_id: number;
  player_name: string;
  buy_price: number;
  sell_price: number | null;
  profit: number | null;
  status: 'bought' | 'listed' | 'sold' | 'failed';
  created_at: string;
}

// ==========================================
// ENCRYPTION HELPERS
// ==========================================

function encrypt(text: string): string {
  const key = config.security.encryptionKey;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }
  
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32)), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text: string): string {
  const key = config.security.encryptionKey;
  if (!key || key.length < 32) {
    logger.warn('ENCRYPTION_KEY not set or too short');
    return '';
  }
  
  // Check if text is empty or null
  if (!text || text.trim() === '') {
    return '';
  }
  
  // Try to parse as plain JSON first (old unencrypted data)
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object') {
      return text; // Already valid JSON, return as-is
    }
  } catch {
    // Not plain JSON, continue with decryption
  }
  
  // Check if text looks like encrypted format (iv:encrypted)
  if (!text.includes(':')) {
    // Not encrypted format
    return text;
  }
  
  try {
    const parts = text.split(':');
    
    // IV should be 32 hex characters (16 bytes)
    if (parts.length !== 2 || parts[0].length !== 32) {
      logger.warn('Invalid encrypted format');
      return '';
    }
    
    const ivHex = parts[0];
    const encrypted = parts[1];
    
    // Validate hex characters
    if (!/^[0-9a-fA-F]+$/.test(ivHex)) {
      logger.warn('Invalid IV hex characters');
      return '';
    }
    
    const iv = Buffer.from(ivHex, 'hex');
    
    // Verify IV is valid
    if (iv.length !== 16) {
      logger.warn('Invalid IV length after conversion');
      return '';
    }
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32)), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e: any) {
    // Decryption failed - cookies will need to be re-created
    logger.warn(`Decryption failed: ${e.message}`);
    return '';
  }
}

// ==========================================
// DATABASE CLASS
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
  // USERS
  // ==========================================

  async getOrCreateUser(telegramId: number, username: string | null): Promise<User> {
    // Try to get existing user
    const { data: existing } = await this.client
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (existing) {
      // Update username if changed
      if (username && existing.username !== username) {
        await this.client
          .from('users')
          .update({ username })
          .eq('id', existing.id);
      }
      return existing as User;
    }

    // Create new user
    const { data: newUser, error } = await this.client
      .from('users')
      .insert({ telegram_id: telegramId, username })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create user:', error);
      throw error;
    }

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
  // EA ACCOUNTS
  // ==========================================

  async getEAAccountsByUser(userId: string): Promise<EAAccount[]> {
    const { data, error } = await this.client
      .from('ea_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error) {
      logger.error('Failed to get EA accounts:', error);
      return [];
    }

    return data as EAAccount[];
  }

  async getEAAccountById(accountId: string): Promise<EAAccount | null> {
    const { data } = await this.client
      .from('ea_accounts')
      .select('*')
      .eq('id', accountId)
      .single();

    return data as EAAccount | null;
  }

  async getEAAccountWithCookies(accountId: string): Promise<{ account: EAAccount; cookies: any } | null> {
    const account = await this.getEAAccountById(accountId);
    if (!account) return null;

    let cookies = null;
    
    // Try to decrypt cookies_encrypted
    if (account.cookies_encrypted) {
      try {
        const decrypted = decrypt(account.cookies_encrypted);
        if (decrypted) {
          cookies = JSON.parse(decrypted);
        }
      } catch (e) {
        logger.warn('Failed to decrypt/parse cookies:', e);
      }
    }

    // Fallback to session_id if cookies not available
    if (!cookies && account.session_id) {
      cookies = { sid: account.session_id };
      logger.info(`Using session_id fallback for account ${accountId}`);
    }

    return { account, cookies };
  }

  async addEAAccount(
    userId: string,
    email: string,
    platform: 'ps' | 'xbox' | 'pc',
    cookies: any
  ): Promise<EAAccount | null> {
    const cookiesEncrypted = encrypt(JSON.stringify(cookies));
    const sessionId = cookies.sid || null;

    const { data, error } = await this.client
      .from('ea_accounts')
      .insert({
        user_id: userId,
        email,
        platform,
        session_id: sessionId,
        cookies_encrypted: cookiesEncrypted,
        coins: 0,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to add EA account:', error);
      return null;
    }

    return data as EAAccount;
  }

  async updateEAAccountSession(
    accountId: string,
    data: { cookies?: any; session_id?: string; coins?: number }
  ): Promise<boolean> {
    const updateData: any = {};

    if (data.cookies) {
      updateData.cookies_encrypted = encrypt(JSON.stringify(data.cookies));
    }
    if (data.session_id) {
      updateData.session_id = data.session_id;
    }
    if (data.coins !== undefined) {
      updateData.coins = data.coins;
    }
    updateData.last_login = new Date().toISOString();

    const { error } = await this.client
      .from('ea_accounts')
      .update(updateData)
      .eq('id', accountId);

    if (error) {
      logger.error('Failed to update EA account:', error);
      return false;
    }

    return true;
  }

  async deleteEAAccount(accountId: string): Promise<boolean> {
    const { error } = await this.client
      .from('ea_accounts')
      .update({ is_active: false })
      .eq('id', accountId);

    return !error;
  }

  // ==========================================
  // FILTERS
  // ==========================================

  async getFiltersByAccount(accountId: string): Promise<SniperFilter[]> {
    const { data, error } = await this.client
      .from('sniper_filters')
      .select('*')
      .eq('ea_account_id', accountId);

    if (error) {
      logger.error('Failed to get filters:', error);
      return [];
    }

    return data as SniperFilter[];
  }

  async getFiltersByUser(userId: string): Promise<SniperFilter[]> {
    const { data, error } = await this.client
      .from('sniper_filters')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      logger.error('Failed to get filters:', error);
      return [];
    }

    return data as SniperFilter[];
  }

  async getFilterById(filterId: string): Promise<SniperFilter | null> {
    const { data } = await this.client
      .from('sniper_filters')
      .select('*')
      .eq('id', filterId)
      .single();

    return data as SniperFilter | null;
  }

  async addFilter(filter: Omit<SniperFilter, 'id' | 'created_at'>): Promise<SniperFilter | null> {
    const { data, error } = await this.client
      .from('sniper_filters')
      .insert(filter)
      .select()
      .single();

    if (error) {
      logger.error('Failed to add filter:', error);
      return null;
    }

    return data as SniperFilter;
  }

  async updateFilter(filterId: string, updates: Partial<SniperFilter>): Promise<boolean> {
    const { error } = await this.client
      .from('sniper_filters')
      .update(updates)
      .eq('id', filterId);

    return !error;
  }

  async deleteFilter(filterId: string): Promise<boolean> {
    const { error } = await this.client
      .from('sniper_filters')
      .delete()
      .eq('id', filterId);

    return !error;
  }

  async toggleFilter(filterId: string, isActive: boolean): Promise<boolean> {
    const { error } = await this.client
      .from('sniper_filters')
      .update({ is_active: isActive })
      .eq('id', filterId);

    return !error;
  }

  // ==========================================
  // TRADE HISTORY
  // ==========================================

  async addTrade(trade: Omit<TradeHistory, 'id' | 'created_at'>): Promise<TradeHistory | null> {
    const { data, error } = await this.client
      .from('trade_history')
      .insert(trade)
      .select()
      .single();

    if (error) {
      logger.error('Failed to add trade:', error);
      return null;
    }

    return data as TradeHistory;
  }

  async updateTrade(
    tradeId: string,
    updates: { sell_price?: number; profit?: number; status?: string }
  ): Promise<boolean> {
    const { error } = await this.client
      .from('trade_history')
      .update(updates)
      .eq('id', tradeId);

    return !error;
  }

  async getStatsHistory(userId: string, days: number = 7): Promise<any[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data, error } = await this.client
      .from('trade_history')
      .select('*, ea_accounts!inner(user_id)')
      .eq('ea_accounts.user_id', userId)
      .gte('created_at', startDate.toISOString());

    if (error || !data) return [];

    // Group by date
    const stats: { [key: string]: { purchases: number; sales: number; profit: number } } = {};

    for (const trade of data) {
      const date = new Date(trade.created_at).toLocaleDateString('uk-UA');
      if (!stats[date]) {
        stats[date] = { purchases: 0, sales: 0, profit: 0 };
      }

      if (trade.status === 'bought') {
        stats[date].purchases++;
      } else if (trade.status === 'sold') {
        stats[date].sales++;
        stats[date].profit += trade.profit || 0;
      }
    }

    return Object.entries(stats).map(([date, data]) => ({ date, ...data }));
  }
}

// Export singleton instance
export const db = new Database();
