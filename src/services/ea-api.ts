/**
 * FC26 EA API Service - Updated with Anti-Ban Integration
 * 
 * Complete rewrite incorporating:
 * - Anti-Ban system integration
 * - New authentication flow
 * - Captcha handling
 * - Session management
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { Cookie, CookieJar } from 'tough-cookie';
import { config } from '../config';
import { logger } from '../utils/logger';
import { db, EAAccount } from '../database';
import { antiBanService, AntiBanAction, AntiBanDecision } from './anti-ban';
import { captchaSolver, eaCaptchaHandler } from './captcha-solver';
import { eaAuthManager, EASession, AuthCookies } from './ea-auth';
import { EventEmitter } from 'events';

// ==========================================
// EA API TYPES
// ==========================================

export interface SearchFilter {
  type?: 'player' | 'training' | 'development' | 'playStyle';
  maskedDefId?: number;
  position?: string;
  zone?: string;
  quality?: string;
  rarityIds?: number[];
  leagueId?: number;
  clubId?: number;
  nationId?: number;
  minBuy?: number;
  maxBuy?: number;
  minBid?: number;
  maxBid?: number;
  level?: string;
  start?: number;
  count?: number;
}

export interface AuctionItem {
  tradeId: number;
  buyNowPrice: number;
  currentBid: number;
  expires: number;
  startingBid: number;
  itemData: {
    id: number;
    assetId: number;
    resourceId: number;
    rating: number;
    itemType: string;
    cardsubtypeid: number;
    owners: number;
    discardValue: number;
    nation: number;
    leagueId: number;
    teamid: number;
    rareflag: number;
    preferredPosition: string;
    firstName: string;
    lastName: string;
  };
  watched: boolean;
  tradeState: string;
  bidState: string;
  sellerEstablished: number;
  sellerName: string;
}

export interface SearchResponse {
  auctionInfo: AuctionItem[];
  bidTokens: object;
  credits: number;
}

export interface BuyResponse {
  auctionInfo: AuctionItem[];
  bidTokens: object;
  credits: number;
  currencies: Array<{ finalFunds: number; funds: number; name: string }>;
}

// Error codes for special handling
const EA_ERROR_CODES = {
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  CAPTCHA_REQUIRED: 426,
  RATE_LIMITED: 429,
  TRANSFER_LOCKED: 458,
  ITEM_NOT_FOUND: 460,
  PERMISSION_DENIED: 461,
  NO_TRADE: 478,
  MARKET_LOCKED: 512,
};

// Platform URLs
const PLATFORM_URLS: Record<string, string> = {
  'ps': 'https://utas.mob.v1.fut.ea.com',
  'xbox': 'https://utas.mob.v2.fut.ea.com',
  'pc': 'https://utas.mob.v4.fut.ea.com'
};

// ==========================================
// EA API CLASS
// ==========================================

export class EAAPI extends EventEmitter {
  private client: AxiosInstance;
  private accountId: string;
  private platform: 'ps' | 'xbox' | 'pc';
  private baseUrl: string;
  private session: EASession | null = null;
  
  // Coin tracking
  public coins: number = 0;

  constructor(accountId: string, platform: 'ps' | 'xbox' | 'pc') {
    super();
    this.accountId = accountId;
    this.platform = platform;
    this.baseUrl = PLATFORM_URLS[platform];

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.ea.com',
        'Referer': 'https://www.ea.com/',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      }
    });

    // Initialize Anti-Ban session
    antiBanService.initSession(accountId);
  }

  // ==========================================
  // SESSION MANAGEMENT
  // ==========================================

  /**
   * Initialize from stored cookies/session
   */
  async initFromCookies(cookies: Record<string, string>): Promise<boolean> {
    try {
      const sid = cookies.sid || cookies['X-UT-SID'] || cookies.sessionId;
      
      if (!sid) {
        logger.error(`[EAAPI] No SID found in cookies`);
        return false;
      }

      this.session = {
        sid,
        platform: this.platform,
      };

      // Verify session
      const isValid = await this.verifySession();

      if (isValid) {
        logger.info(`[EAAPI] Session verified for ${this.accountId}`);
        return true;
      }

      logger.warn(`[EAAPI] Session invalid for ${this.accountId}`);
      return false;

    } catch (error) {
      logger.error('[EAAPI] Init from cookies failed:', error);
      return false;
    }
  }

  /**
   * Set session directly
   */
  setSession(session: EASession): void {
    this.session = session;
  }

  /**
   * Verify current session is valid
   */
  async verifySession(): Promise<boolean> {
    try {
      const response = await this.getCredits();
      return response.credits !== undefined;
    } catch (error) {
      return false;
    }
  }

  // ==========================================
  // ANTI-BAN PROTECTED REQUEST
  // ==========================================

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    requestType: 'search' | 'buy' | 'action',
    data?: object
  ): Promise<T> {
    // Check Anti-Ban decision
    const decision = await antiBanService.shouldProceed(this.accountId, requestType);
    
    await this.handleAntiBanDecision(decision);

    const url = `/ut/game/fc26${endpoint}`;

    try {
      // Log request (debug mode)
      logger.debug(`[EAAPI] ${method} ${url}`);

      const response: AxiosResponse<T> = await this.client.request({
        method,
        url,
        data,
        headers: this.getHeaders()
      });

      // Record successful request
      antiBanService.recordRequest(this.accountId, requestType);

      return response.data;

    } catch (error: any) {
      return this.handleRequestError(error, requestType);
    }
  }

  /**
   * Handle Anti-Ban decision
   */
  private async handleAntiBanDecision(decision: AntiBanDecision): Promise<void> {
    switch (decision.action) {
      case AntiBanAction.STOP:
        logger.error(`[EAAPI] Anti-Ban STOP: ${decision.reason}`);
        this.emit('anti_ban_stop', { reason: decision.reason, stats: decision.stats });
        throw new Error(`ANTI_BAN_STOP: ${decision.reason}`);

      case AntiBanAction.PAUSE:
        logger.warn(`[EAAPI] Anti-Ban PAUSE: ${decision.reason} (${decision.pauseMs}ms)`);
        this.emit('anti_ban_pause', { 
          reason: decision.reason, 
          duration: decision.pauseMs 
        });
        await this.delay(decision.pauseMs!);
        break;

      case AntiBanAction.DELAY:
        if (decision.delayMs && decision.delayMs > 0) {
          logger.debug(`[EAAPI] Anti-Ban DELAY: ${decision.delayMs}ms`);
          await this.delay(decision.delayMs);
        }
        break;

      case AntiBanAction.PROCEED:
        // Continue normally
        break;
    }
  }

  /**
   * Handle request errors with Anti-Ban integration
   */
  private handleRequestError(error: any, requestType: string): never {
    const status = error.response?.status;
    const data = error.response?.data;

    logger.error(`[EAAPI] Request error: ${status}`, data);

    // Record error in Anti-Ban system
    if (status) {
      const decision = antiBanService.recordError(this.accountId, status);
      
      // Emit error events based on type
      switch (status) {
        case EA_ERROR_CODES.SESSION_EXPIRED:
          this.emit('session_expired', { accountId: this.accountId });
          break;
        case EA_ERROR_CODES.CAPTCHA_REQUIRED:
          this.emit('captcha_required', { accountId: this.accountId });
          break;
        case EA_ERROR_CODES.RATE_LIMITED:
          this.emit('rate_limited', { accountId: this.accountId });
          break;
        case EA_ERROR_CODES.TRANSFER_LOCKED:
          this.emit('transfer_locked', { accountId: this.accountId });
          break;
        case EA_ERROR_CODES.MARKET_LOCKED:
          this.emit('market_locked', { accountId: this.accountId });
          break;
      }

      // If Anti-Ban says stop, throw appropriate error
      if (decision.action === AntiBanAction.STOP) {
        throw new Error(`CRITICAL_ERROR_${status}`);
      }
    }

    // Throw descriptive error
    const errorCode = this.getErrorCode(status);
    throw new Error(errorCode);
  }

  /**
   * Get error code string
   */
  private getErrorCode(status: number): string {
    switch (status) {
      case 401: return 'SESSION_EXPIRED';
      case 403: return 'FORBIDDEN';
      case 409: return 'CONFLICT';
      case 426: return 'CAPTCHA_REQUIRED';
      case 429: return 'RATE_LIMITED';
      case 458: return 'TRANSFER_LOCKED';
      case 460: return 'ITEM_NOT_FOUND';
      case 461: return 'PERMISSION_DENIED';
      case 478: return 'NO_TRADE_EXISTS';
      case 512: return 'MARKET_LOCKED';
      default: return `EA_ERROR_${status}`;
    }
  }

  // ==========================================
  // HEADERS
  // ==========================================

  private getHeaders(): Record<string, string> {
    if (!this.session?.sid) {
      throw new Error('No session - call initFromCookies first');
    }

    return {
      'X-UT-SID': this.session.sid,
    };
  }

  // ==========================================
  // API METHODS
  // ==========================================

  /**
   * Get current coins balance
   */
  async getCredits(): Promise<{ credits: number }> {
    const response = await this.request<any>('GET', '/user/credits', 'action');

    let credits = 0;
    if (response.credits !== undefined) {
      credits = response.credits;
    } else if (response.userInfo?.credits !== undefined) {
      credits = response.userInfo.credits;
    } else if (response.currencies) {
      const coins = response.currencies.find((c: any) => c.name === 'COINS');
      if (coins) credits = coins.funds;
    }

    this.coins = credits;
    return { credits };
  }

  /**
   * Search transfer market
   */
  async search(filter: SearchFilter): Promise<SearchResponse> {
    const params = new URLSearchParams();

    params.append('start', String(filter.start || 0));
    params.append('num', String(filter.count || 21));
    params.append('type', filter.type || 'player');

    if (filter.maskedDefId) params.append('maskedDefId', String(filter.maskedDefId));
    if (filter.position) params.append('pos', filter.position);
    if (filter.zone) params.append('zone', filter.zone);
    if (filter.quality) params.append('lev', filter.quality);
    if (filter.rarityIds) params.append('rarityIds', filter.rarityIds.join(','));
    if (filter.leagueId) params.append('leag', String(filter.leagueId));
    if (filter.clubId) params.append('team', String(filter.clubId));
    if (filter.nationId) params.append('nat', String(filter.nationId));
    if (filter.minBuy) params.append('minb', String(filter.minBuy));
    if (filter.maxBuy) params.append('maxb', String(filter.maxBuy));
    if (filter.minBid) params.append('micr', String(filter.minBid));
    if (filter.maxBid) params.append('macr', String(filter.maxBid));

    return this.request<SearchResponse>('GET', `/transfermarket?${params.toString()}`, 'search');
  }

  /**
   * Buy item instantly (BIN)
   */
  async buyNow(tradeId: number, price: number): Promise<BuyResponse> {
    return this.request<BuyResponse>('PUT', `/trade/${tradeId}/bid`, 'buy', { bid: price });
  }

  /**
   * Place a bid on item
   */
  async placeBid(tradeId: number, amount: number): Promise<BuyResponse> {
    return this.request<BuyResponse>('PUT', `/trade/${tradeId}/bid`, 'buy', { bid: amount });
  }

  /**
   * List item for sale
   */
  async listItem(
    itemId: number,
    startPrice: number,
    buyNowPrice: number,
    duration: number = 3600
  ): Promise<{ id: number }> {
    return this.request<{ id: number }>('POST', '/auctionhouse', 'action', {
      itemData: { id: itemId },
      startingBid: startPrice,
      duration,
      buyNowPrice
    });
  }

  /**
   * Get tradepile
   */
  async getTradepile(): Promise<{ auctionInfo: AuctionItem[] }> {
    return this.request<{ auctionInfo: AuctionItem[] }>('GET', '/tradepile', 'action');
  }

  /**
   * Get watchlist
   */
  async getWatchlist(): Promise<{ auctionInfo: AuctionItem[] }> {
    return this.request<{ auctionInfo: AuctionItem[] }>('GET', '/watchlist', 'action');
  }

  /**
   * Get unassigned items
   */
  async getUnassigned(): Promise<{ itemData: any[] }> {
    return this.request<{ itemData: any[] }>('GET', '/purchased/items', 'action');
  }

  /**
   * Send item to tradepile
   */
  async sendToTradepile(itemId: number): Promise<{ itemData: any[] }> {
    return this.request<{ itemData: any[] }>('PUT', '/item', 'action', {
      itemData: [{ id: itemId, pile: 'trade' }]
    });
  }

  /**
   * Send item to club
   */
  async sendToClub(itemId: number): Promise<{ itemData: any[] }> {
    return this.request<{ itemData: any[] }>('PUT', '/item', 'action', {
      itemData: [{ id: itemId, pile: 'club' }]
    });
  }

  /**
   * Quick sell item
   */
  async quickSell(itemId: number): Promise<{ credits: number }> {
    return this.request<{ credits: number }>('DELETE', `/item/${itemId}`, 'action');
  }

  /**
   * Relist all expired items
   */
  async relistAll(): Promise<{ tradeIdList: number[] }> {
    return this.request<{ tradeIdList: number[] }>('PUT', '/auctionhouse/relist', 'action');
  }

  /**
   * Remove sold items
   */
  async removeSold(): Promise<void> {
    const tradepile = await this.getTradepile();
    const soldItems = tradepile.auctionInfo.filter(item => item.tradeState === 'closed');

    for (const item of soldItems) {
      await this.request<void>('DELETE', `/trade/${item.tradeId}`, 'action');
      await this.delay(200);
    }
  }

  /**
   * Keepalive ping
   */
  async keepalive(): Promise<{ credits: number }> {
    return this.getCredits();
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calculate sell price with EA tax
   */
  static calculateSellPrice(buyPrice: number, profitMargin: number = 0.05): number {
    const taxMultiplier = 0.95;
    const targetProfit = buyPrice * profitMargin;
    const sellPrice = Math.ceil((buyPrice + targetProfit) / taxMultiplier);
    return EAAPI.roundToValidPrice(sellPrice);
  }

  /**
   * Round to valid EA price
   */
  static roundToValidPrice(price: number): number {
    if (price < 1000) return Math.ceil(price / 50) * 50;
    if (price < 10000) return Math.ceil(price / 100) * 100;
    if (price < 50000) return Math.ceil(price / 250) * 250;
    if (price < 100000) return Math.ceil(price / 500) * 500;
    return Math.ceil(price / 1000) * 1000;
  }

  /**
   * Get player name from item
   */
  static getPlayerName(item: AuctionItem): string {
    const { firstName, lastName } = item.itemData;
    return `${firstName} ${lastName}`.trim() || 'Unknown Player';
  }

  /**
   * Get Anti-Ban status
   */
  getAntiBanStatus(): string {
    return antiBanService.getStatus(this.accountId);
  }

  /**
   * Get risk percentage
   */
  getRiskPercentage(): number {
    return antiBanService.getRiskPercentage(this.accountId);
  }
}

// ==========================================
// EA API FACTORY
// ==========================================

export class EAAPIFactory {
  private static instances: Map<string, EAAPI> = new Map();

  /**
   * Get or create API instance for account
   */
  static async getInstance(accountId: string): Promise<EAAPI | null> {
    // Return existing
    if (this.instances.has(accountId)) {
      return this.instances.get(accountId)!;
    }

    // Load from database
    const accountData = await db.getEAAccountWithCookies(accountId);
    if (!accountData) {
      logger.error(`[EAAPIFactory] Account ${accountId} not found`);
      return null;
    }

    const { account, cookies } = accountData;

    // Create new instance
    const api = new EAAPI(accountId, account.platform);
    const initialized = await api.initFromCookies(cookies as Record<string, string>);

    if (!initialized) {
      logger.error(`[EAAPIFactory] Failed to initialize API for ${accountId}`);
      return null;
    }

    this.instances.set(accountId, api);
    return api;
  }

  /**
   * Remove instance
   */
  static removeInstance(accountId: string): void {
    const api = this.instances.get(accountId);
    if (api) {
      antiBanService.removeSession(accountId);
      this.instances.delete(accountId);
    }
  }

  /**
   * Clear all instances
   */
  static clearAll(): void {
    for (const [accountId] of this.instances) {
      antiBanService.removeSession(accountId);
    }
    this.instances.clear();
  }

  /**
   * Get all active instances
   */
  static getActiveInstances(): string[] {
    return Array.from(this.instances.keys());
  }
}
