import { EAAPI, EAAPIFactory, AuctionItem, SearchFilter } from './ea-api';
import { priceService, PlayerPrice } from './price-service';
import { db, SniperFilter, Transaction } from '../database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

// ==========================================
// TYPES
// ==========================================
export interface SniperSession {
  accountId: string;
  userId: string;
  status: 'running' | 'paused' | 'stopped' | 'error';
  filters: SniperFilter[];
  stats: {
    searches: number;
    purchases: number;
    spent: number;
    listings: number;
    profit: number;
  };
  startTime: Date;
  lastActivity: Date;
  error?: string;
}

export interface SnipeResult {
  success: boolean;
  item?: AuctionItem;
  buyPrice?: number;
  sellPrice?: number;
  profit?: number;
  error?: string;
}

// ==========================================
// SNIPER ENGINE
// ==========================================
export class SniperEngine extends EventEmitter {
  private sessions: Map<string, SniperSession> = new Map();
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    super();
  }

  // ==========================================
  // SESSION MANAGEMENT
  // ==========================================

  /**
   * Start sniping session for an account
   */
  async startSession(accountId: string, userId: string): Promise<boolean> {
    if (this.sessions.has(accountId)) {
      const existing = this.sessions.get(accountId)!;
      if (existing.status === 'running') {
        return true; // Already running
      }
    }

    // Get EA API instance
    const api = await EAAPIFactory.getInstance(accountId);
    if (!api) {
      logger.error(`Failed to get EA API for account ${accountId}`);
      return false;
    }

    // Verify session
    try {
      const credits = await api.getCredits();
      logger.info(`Session verified. Coins: ${credits.credits}`);
    } catch (error) {
      logger.error(`Session verification failed:`, error);
      this.emit('session_error', { accountId, error: 'SESSION_EXPIRED' });
      return false;
    }

    // Load active filters
    const filters = await db.getActiveFilters(accountId);
    if (filters.length === 0) {
      logger.warn(`No active filters for account ${accountId}`);
    }

    // Create session
    const session: SniperSession = {
      accountId,
      userId,
      status: 'running',
      filters,
      stats: {
        searches: 0,
        purchases: 0,
        spent: 0,
        listings: 0,
        profit: 0
      },
      startTime: new Date(),
      lastActivity: new Date()
    };

    this.sessions.set(accountId, session);

    // Start sniper loop
    this.startSniperLoop(accountId, api);

    this.emit('session_started', { accountId, userId });
    logger.info(`Sniper session started for account ${accountId}`);

    return true;
  }

  /**
   * Stop sniping session
   */
  async stopSession(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;

    session.status = 'stopped';

    // Clear interval
    const interval = this.intervals.get(accountId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(accountId);
    }

    // Save final stats
    await db.updateDailyStats(session.userId, accountId, {
      searches: session.stats.searches,
      purchases: session.stats.purchases,
      profit: session.stats.profit
    });

    this.sessions.delete(accountId);
    this.emit('session_stopped', { accountId });
    logger.info(`Sniper session stopped for account ${accountId}`);
  }

  /**
   * Pause session
   */
  pauseSession(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (session) {
      session.status = 'paused';
      this.emit('session_paused', { accountId });
    }
  }

  /**
   * Resume session
   */
  resumeSession(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (session && session.status === 'paused') {
      session.status = 'running';
      this.emit('session_resumed', { accountId });
    }
  }

  /**
   * Get session status
   */
  getSession(accountId: string): SniperSession | undefined {
    return this.sessions.get(accountId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): SniperSession[] {
    return Array.from(this.sessions.values());
  }

  // ==========================================
  // SNIPER LOOP
  // ==========================================

  private startSniperLoop(accountId: string, api: EAAPI): void {
    const runCycle = async () => {
      const session = this.sessions.get(accountId);
      if (!session || session.status !== 'running') return;

      try {
        // Process each filter
        for (const filter of session.filters) {
          if (session.status !== 'running') break;

          await this.processFilter(accountId, api, filter, session);
        }

        // Manage tradepile
        await this.manageTradepile(accountId, api, session);

        // Update last activity
        session.lastActivity = new Date();

        // Anti-ban pause
        if (session.stats.purchases > 0 && 
            session.stats.purchases % config.trading.maxPurchasesPerHour === 0) {
          logger.info(`Anti-ban pause for account ${accountId}`);
          session.status = 'paused';
          setTimeout(() => {
            if (this.sessions.has(accountId)) {
              this.resumeSession(accountId);
            }
          }, 60000); // 1 minute pause
        }

      } catch (error: any) {
        await this.handleError(accountId, session, error);
      }
    };

    // Run immediately
    runCycle();

    // Set interval for continuous sniping
    const interval = setInterval(runCycle, this.getRandomDelay());
    this.intervals.set(accountId, interval);
  }

  private getRandomDelay(): number {
    return Math.floor(
      Math.random() * (config.trading.maxSearchDelay - config.trading.minSearchDelay) +
      config.trading.minSearchDelay
    );
  }

  // ==========================================
  // FILTER PROCESSING
  // ==========================================

  private async processFilter(
    accountId: string,
    api: EAAPI,
    filter: SniperFilter,
    session: SniperSession
  ): Promise<void> {
    // Build search criteria
    const searchFilter: SearchFilter = {
      type: 'player',
      maxBuy: filter.max_buy,
      count: 21
    };

    if (filter.player_id) searchFilter.maskedDefId = filter.player_id;
    if (filter.min_buy) searchFilter.minBuy = filter.min_buy;
    if (filter.position) searchFilter.position = filter.position;
    if (filter.nation) searchFilter.nationId = filter.nation;
    if (filter.league) searchFilter.leagueId = filter.league;
    if (filter.club) searchFilter.clubId = filter.club;

    try {
      // Search market
      const results = await api.search(searchFilter);
      session.stats.searches++;

      if (results.auctionInfo.length === 0) return;

      // Process each item
      for (const item of results.auctionInfo) {
        if (session.status !== 'running') break;

        // Check if item is a good deal
        const shouldBuy = await this.evaluateItem(item, filter, api.platform);
        
        if (shouldBuy) {
          const result = await this.attemptPurchase(api, item, filter, session);
          
          if (result.success) {
            // Record transaction
            await this.recordPurchase(session, filter, item, result);
            
            // Emit event
            this.emit('item_purchased', {
              accountId,
              item,
              buyPrice: result.buyPrice,
              sellPrice: result.sellPrice
            });

            // List for sale if auto-sell enabled
            if (filter.sell_price) {
              await this.listItem(api, item, filter.sell_price, session);
            }
          }
        }
      }

    } catch (error) {
      throw error;
    }
  }

  // ==========================================
  // ITEM EVALUATION
  // ==========================================

  private async evaluateItem(
    item: AuctionItem,
    filter: SniperFilter,
    platform: string
  ): Promise<boolean> {
    // Basic checks
    if (item.tradeState !== 'active') return false;
    if (item.buyNowPrice > filter.max_buy) return false;
    if (filter.min_buy && item.buyNowPrice < filter.min_buy) return false;

    // Check profit margin using external prices
    if (filter.player_id) {
      const priceData = await priceService.getPrice(filter.player_id, platform);
      
      if (priceData.lowestBin) {
        const potentialProfit = priceData.lowestBin - item.buyNowPrice;
        const profitPercent = (potentialProfit / item.buyNowPrice) * 100;

        // Check minimum profit margin
        if (profitPercent < config.trading.minProfitMargin) {
          return false;
        }
      }
    }

    return true;
  }

  // ==========================================
  // PURCHASE LOGIC
  // ==========================================

  private async attemptPurchase(
    api: EAAPI,
    item: AuctionItem,
    filter: SniperFilter,
    session: SniperSession
  ): Promise<SnipeResult> {
    try {
      // Attempt to buy
      const response = await api.buyNow(item.tradeId, item.buyNowPrice);

      // Check if purchase was successful
      const purchasedItem = response.auctionInfo.find(
        a => a.tradeId === item.tradeId && a.bidState === 'highest'
      );

      if (purchasedItem) {
        session.stats.purchases++;
        session.stats.spent += item.buyNowPrice;

        // Calculate sell price
        let sellPrice = filter.sell_price;
        if (!sellPrice) {
          sellPrice = EAAPI.calculateSellPrice(
            item.buyNowPrice, 
            config.trading.minProfitMargin / 100
          );
        }

        const profit = sellPrice - item.buyNowPrice - Math.floor(sellPrice * 0.05);

        return {
          success: true,
          item: purchasedItem,
          buyPrice: item.buyNowPrice,
          sellPrice,
          profit
        };
      }

      return { success: false, error: 'PURCHASE_FAILED' };

    } catch (error: any) {
      logger.warn(`Purchase failed for item ${item.tradeId}:`, error.message);
      
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  // ==========================================
  // LISTING LOGIC
  // ==========================================

  private async listItem(
    api: EAAPI,
    item: AuctionItem,
    sellPrice: number,
    session: SniperSession
  ): Promise<void> {
    try {
      // First, move to tradepile
      await api.sendToTradepile(item.itemData.id);
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 500));

      // Calculate start price (90% of BIN)
      const startPrice = EAAPI.roundToValidPrice(Math.floor(sellPrice * 0.9));

      // List item
      await api.listItem(item.itemData.id, startPrice, sellPrice, 3600);
      
      session.stats.listings++;
      
      logger.info(`Listed ${EAAPI.getPlayerName(item)} for ${sellPrice} coins`);

    } catch (error) {
      logger.error(`Failed to list item:`, error);
    }
  }

  // ==========================================
  // TRADEPILE MANAGEMENT
  // ==========================================

  private async manageTradepile(
    accountId: string,
    api: EAAPI,
    session: SniperSession
  ): Promise<void> {
    try {
      const tradepile = await api.getTradepile();

      // Process sold items
      const soldItems = tradepile.auctionInfo.filter(
        item => item.tradeState === 'closed'
      );

      for (const item of soldItems) {
        // Calculate profit
        const sellPrice = item.currentBid;
        session.stats.profit += sellPrice;

        // Update transaction in database
        // Note: This is simplified, you'd want to match by trade ID
        
        this.emit('item_sold', {
          accountId,
          item,
          sellPrice
        });
      }

      // Remove sold items
      if (soldItems.length > 0) {
        await api.removeSold();
      }

      // Relist expired items
      const expiredItems = tradepile.auctionInfo.filter(
        item => item.tradeState === 'expired'
      );

      if (expiredItems.length > 0) {
        await api.relistAll();
        logger.info(`Relisted ${expiredItems.length} expired items`);
      }

      // Check tradepile space
      const activeListings = tradepile.auctionInfo.filter(
        item => item.tradeState === 'active'
      ).length;

      if (activeListings >= 95) {
        logger.warn('Tradepile almost full, pausing purchases');
        session.status = 'paused';
      }

    } catch (error) {
      logger.error('Tradepile management error:', error);
    }
  }

  // ==========================================
  // TRANSACTION RECORDING
  // ==========================================

  private async recordPurchase(
    session: SniperSession,
    filter: SniperFilter,
    item: AuctionItem,
    result: SnipeResult
  ): Promise<void> {
    try {
      await db.recordTransaction({
  user_id: session.userId,
  ea_account_id: session.accountId,
  filter_id: filter.id,
  player_id: item.itemData.assetId,
  player_name: EAAPI.getPlayerName(item),
  buy_price: result.buyPrice!,
  sell_price: result.sellPrice || null,
  profit: null,
  status: 'bought',
  trade_id: String(item.tradeId),
  sold_at: null
});
    } catch (error) {
      logger.error('Failed to record transaction:', error);
    }
  }

  // ==========================================
  // ERROR HANDLING
  // ==========================================

  private async handleError(
    accountId: string,
    session: SniperSession,
    error: any
  ): Promise<void> {
    const errorMessage = error.message || String(error);
    
    logger.error(`Sniper error for ${accountId}:`, errorMessage);

    switch (errorMessage) {
      case 'SESSION_EXPIRED':
        session.status = 'error';
        session.error = 'Сесія закінчилась. Оновіть cookies.';
        this.emit('session_expired', { accountId });
        await this.stopSession(accountId);
        break;

      case 'CAPTCHA_REQUIRED':
        session.status = 'paused';
        session.error = 'Потрібна капча!';
        this.emit('captcha_required', { accountId });
        break;

      case 'RATE_LIMITED':
        session.status = 'paused';
        logger.warn('Rate limited, pausing for 5 minutes');
        setTimeout(() => this.resumeSession(accountId), 300000);
        break;

      case 'TRANSFER_MARKET_LOCKED':
        session.status = 'error';
        session.error = 'Трансферний ринок заблоковано!';
        this.emit('market_locked', { accountId });
        await this.stopSession(accountId);
        break;

      default:
        // For unknown errors, pause briefly and continue
        session.status = 'paused';
        setTimeout(() => this.resumeSession(accountId), 30000);
    }
  }

  // ==========================================
  // FILTER MANAGEMENT
  // ==========================================

  async addFilter(accountId: string, filter: SniperFilter): Promise<void> {
    const session = this.sessions.get(accountId);
    if (session) {
      session.filters.push(filter);
    }
  }

  async removeFilter(accountId: string, filterId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (session) {
      session.filters = session.filters.filter(f => f.id !== filterId);
    }
  }

  async reloadFilters(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (session) {
      session.filters = await db.getActiveFilters(accountId);
      logger.info(`Reloaded ${session.filters.length} filters for ${accountId}`);
    }
  }
}

// Export singleton instance
export const sniperEngine = new SniperEngine();
