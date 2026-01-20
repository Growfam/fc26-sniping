/**
 * FC26 Sniper Engine
 * Main sniping logic with Anti-Ban integration
 */

import { EventEmitter } from 'events';
import { EAAPI, EAAPIFactory } from './ea-api';
import { antiBanService, AntiBanAction, RiskLevel } from './anti-ban';
import { db } from '../database';
import { logger } from '../utils/logger';
import { config } from '../config';

// ==========================================
// TYPES
// ==========================================

export interface SniperSession {
  accountId: string;
  userId: string;
  status: 'running' | 'paused' | 'stopped' | 'error';
  startedAt: Date;
  stats: {
    searches: number;
    purchases: number;
    sales: number;
    profit: number;
    errors: number;
  };
}

export interface SearchResult {
  tradeId: number;
  buyNowPrice: number;
  currentBid: number;
  expires: number;
  itemData: any;
}

// ==========================================
// SNIPER ENGINE
// ==========================================

class SniperEngine extends EventEmitter {
  private sessions: Map<string, SniperSession> = new Map();
  private searchLoops: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    super();
  }

  // ==========================================
  // SESSION MANAGEMENT
  // ==========================================

  async startSession(accountId: string, userId: string): Promise<boolean> {
    try {
      // Check if already running
      if (this.sessions.has(accountId)) {
        const session = this.sessions.get(accountId)!;
        if (session.status === 'running') {
          logger.warn(`Session already running for ${accountId}`);
          return false;
        }
      }

      // Initialize EA API
      const api = await EAAPIFactory.getInstance(accountId);
      if (!api) {
        logger.error(`Failed to get API instance for ${accountId}`);
        return false;
      }

      // Verify session
      const isValid = await api.verifySession();
      if (!isValid) {
        logger.error(`Invalid session for ${accountId}`);
        this.emit('session_expired', { accountId });
        return false;
      }

      // Create session
      const session: SniperSession = {
        accountId,
        userId,
        status: 'running',
        startedAt: new Date(),
        stats: {
          searches: 0,
          purchases: 0,
          sales: 0,
          profit: 0,
          errors: 0
        }
      };

      this.sessions.set(accountId, session);

      // Initialize Anti-Ban tracking
      antiBanService.initSession(accountId);

      // Start search loop
      this.startSearchLoop(accountId);

      logger.info(`Sniper session started for ${accountId}`);
      this.emit('session_started', { accountId, userId });

      return true;
    } catch (error) {
      logger.error(`Failed to start session for ${accountId}:`, error);
      return false;
    }
  }

  async stopSession(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;

    // Stop search loop
    const loop = this.searchLoops.get(accountId);
    if (loop) {
      clearTimeout(loop);
      this.searchLoops.delete(accountId);
    }

    session.status = 'stopped';
    
    logger.info(`Sniper session stopped for ${accountId}`);
    this.emit('session_stopped', { accountId, stats: session.stats });
  }

  getSession(accountId: string): SniperSession | undefined {
    return this.sessions.get(accountId);
  }

  getAllSessions(): SniperSession[] {
    return Array.from(this.sessions.values());
  }

  // ==========================================
  // SEARCH LOOP
  // ==========================================

  private async startSearchLoop(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session || session.status !== 'running') return;

    try {
      // Check Anti-Ban decision
      const decision = await antiBanService.shouldProceed(accountId, 'search');

      switch (decision.action) {
        case AntiBanAction.STOP:
          logger.warn(`[${accountId}] Anti-Ban STOP: ${decision.reason}`);
          session.status = 'stopped';
          this.emit('anti_ban_stop', { accountId, reason: decision.reason });
          return;

        case AntiBanAction.PAUSE:
          logger.info(`[${accountId}] Anti-Ban PAUSE: ${decision.reason} (${decision.pauseMs}ms)`);
          session.status = 'paused';
          this.emit('anti_ban_pause', { accountId, reason: decision.reason, duration: decision.pauseMs });
          
          // Schedule resume
          this.searchLoops.set(accountId, setTimeout(() => {
            session.status = 'running';
            this.startSearchLoop(accountId);
          }, decision.pauseMs!));
          return;

        case AntiBanAction.DELAY:
          // Wait for delay then proceed
          await this.delay(decision.delayMs!);
          break;

        case AntiBanAction.PROCEED:
          // Continue immediately
          break;
      }

      // Perform search
      await this.performSearch(accountId);

      // Schedule next iteration with random delay
      const nextDelay = this.randomDelay(
        config.antiBan.searchDelay.min,
        config.antiBan.searchDelay.max
      );

      this.searchLoops.set(accountId, setTimeout(() => {
        this.startSearchLoop(accountId);
      }, nextDelay));

    } catch (error) {
      logger.error(`[${accountId}] Search loop error:`, error);
      session.stats.errors++;
      
      // Handle error with Anti-Ban
      const errorDecision = antiBanService.recordError(accountId, 0);
      
      if (errorDecision.action === AntiBanAction.STOP) {
        session.status = 'error';
        this.emit('session_error', { accountId, error });
      } else {
        // Retry after delay
        this.searchLoops.set(accountId, setTimeout(() => {
          this.startSearchLoop(accountId);
        }, 30000));
      }
    }
  }

  // ==========================================
  // SEARCH & BUY LOGIC
  // ==========================================

  private async performSearch(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;

    const api = await EAAPIFactory.getInstance(accountId);
    if (!api) return;

    // Get active filters for this account
    const filters = await db.getFiltersByAccount(accountId);
    const activeFilters = filters.filter(f => f.is_active);

    if (activeFilters.length === 0) {
      logger.debug(`[${accountId}] No active filters`);
      return;
    }

    for (const filter of activeFilters) {
      try {
        // Build search parameters
        const searchParams = this.buildSearchParams(filter);
        
        // Perform search
        const results = await api.search(searchParams);
        session.stats.searches++;

        if (!results || !results.auctionInfo || results.auctionInfo.length === 0) {
          continue;
        }

        // Check for snipes
        for (const item of results.auctionInfo) {
          if (this.isSnipe(item, filter)) {
            await this.attemptPurchase(accountId, item, filter);
          }
        }

      } catch (error: any) {
        logger.error(`[${accountId}] Search error for filter ${filter.name}:`, error);
        
        // Handle specific error codes
        if (error.response?.status) {
          antiBanService.recordError(accountId, error.response.status);
        }
      }
    }
  }

  private buildSearchParams(filter: any): any {
    const params: any = {
      type: 'player',
      maxb: filter.max_buy
    };

    if (filter.player_id) params.maskedDefId = filter.player_id;
    if (filter.min_buy) params.minb = filter.min_buy;
    if (filter.position) params.pos = filter.position;
    if (filter.quality) params.quality = filter.quality;
    if (filter.rarity) params.rarityIds = filter.rarity;
    if (filter.nation) params.nat = filter.nation;
    if (filter.league) params.leag = filter.league;
    if (filter.club) params.team = filter.club;

    return params;
  }

  private isSnipe(item: any, filter: any): boolean {
    const buyNowPrice = item.buyNowPrice;
    
    // Check if price is within filter limits
    if (buyNowPrice > filter.max_buy) return false;
    if (filter.min_buy && buyNowPrice < filter.min_buy) return false;

    // Check if profitable (if sell price specified)
    if (filter.sell_price) {
      const profit = filter.sell_price - buyNowPrice;
      const profitPercent = (profit / buyNowPrice) * 100;
      
      if (profitPercent < config.trading.minProfitMargin) {
        return false;
      }
    }

    return true;
  }

  private async attemptPurchase(accountId: string, item: any, filter: any): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;

    const api = await EAAPIFactory.getInstance(accountId);
    if (!api) return;

    // Check Anti-Ban for purchase
    const decision = await antiBanService.shouldProceed(accountId, 'buy');
    if (decision.action !== AntiBanAction.PROCEED && decision.action !== AntiBanAction.DELAY) {
      logger.warn(`[${accountId}] Purchase blocked by Anti-Ban: ${decision.reason}`);
      return;
    }

    if (decision.delayMs) {
      await this.delay(decision.delayMs);
    }

    try {
      const success = await api.buyNow(item.tradeId, item.buyNowPrice);

      if (success) {
        session.stats.purchases++;
        
        // Record trade
        await db.addTrade({
          ea_account_id: accountId,
          player_id: item.assetId || item.resourceId,
          player_name: EAAPI.getPlayerName(item),
          buy_price: item.buyNowPrice,
          sell_price: null,
          profit: null,
          status: 'bought'
        });

        logger.info(`[${accountId}] ✅ Bought ${EAAPI.getPlayerName(item)} for ${item.buyNowPrice}`);
        
        this.emit('item_purchased', {
          accountId,
          item,
          buyPrice: item.buyNowPrice,
          sellPrice: filter.sell_price
        });

        // List for sale if sell price specified
        if (filter.sell_price) {
          await this.listForSale(accountId, item, filter.sell_price);
        }
      }
    } catch (error: any) {
      logger.error(`[${accountId}] Purchase failed:`, error);
      
      if (error.response?.status) {
        antiBanService.recordError(accountId, error.response.status);
      }
    }
  }

  private async listForSale(accountId: string, item: any, sellPrice: number): Promise<void> {
    const api = await EAAPIFactory.getInstance(accountId);
    if (!api) return;

    // Small delay before listing
    await this.delay(this.randomDelay(1000, 2000));

    try {
      // First send to tradepile
      await api.sendToTradepile(item.id);
      
      // Small delay
      await this.delay(this.randomDelay(500, 1000));

      // List item
      const listed = await api.listItem(item.id, sellPrice, sellPrice);

      if (listed) {
        logger.info(`[${accountId}] Listed ${EAAPI.getPlayerName(item)} for ${sellPrice}`);
        
        this.emit('item_listed', {
          accountId,
          item,
          sellPrice
        });
      }
    } catch (error) {
      logger.error(`[${accountId}] Failed to list item:`, error);
    }
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

// Export singleton
export const sniperEngine = new SniperEngine();
