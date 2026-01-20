import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { Cookie, CookieJar } from 'tough-cookie';
import { config } from '../config';
import { logger } from '../utils/logger';
import { db, EAAccount } from '../database';

// ==========================================
// EA API TYPES
// ==========================================
export interface EASession {
  personaId: string;
  nucleusId: string;
  sessionId: string;
  phishingToken: string;
  dob: string;
}

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

// ==========================================
// EA API SERVICE
// ==========================================
export class EAAPI {
  private client: AxiosInstance;
  private cookieJar: CookieJar;
  private session: EASession | null = null;
  private accountId: string;
  public platform: string;
  private baseUrl: string;

  // Request tracking
  private requestCount: number = 0;
  private hourStart: number = Date.now();
  private lastRequestTime: number = 0;

  constructor(accountId: string, platform: 'ps' | 'xbox' | 'pc') {
    this.accountId = accountId;
    this.platform = platform;
    this.cookieJar = new CookieJar();

    // Platform-specific URLs
    const platformUrls: Record<string, string> = {
      'ps': 'https://utas.mob.v1.fut.ea.com',
      'xbox': 'https://utas.mob.v2.fut.ea.com',
      'pc': 'https://utas.mob.v4.fut.ea.com'
    };

    this.baseUrl = platformUrls[platform] || platformUrls['ps'];

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.ea.com',
        'Referer': 'https://www.ea.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      }
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => this.handleError(error)
    );
  }

  // ==========================================
  // SESSION MANAGEMENT
  // ==========================================
  async initFromCookies(cookies: Record<string, string>): Promise<boolean> {
    try {
      // Set cookies to jar
      for (const [name, value] of Object.entries(cookies)) {
        const cookie = new Cookie({
          key: name,
          value: value,
          domain: '.ea.com',
          path: '/'
        });
        await this.cookieJar.setCookie(cookie, 'https://ea.com');
      }

      // Extract session data from cookies
      this.session = {
        personaId: cookies['personaId'] || '',
        nucleusId: cookies['nucleusId'] || '',
        sessionId: cookies['sid'] || cookies['sessionId'] || '',
        phishingToken: cookies['phishing'] || '',
        dob: cookies['dob'] || ''
      };

      // Verify session is valid
      const isValid = await this.verifySession();
      
      if (isValid) {
        logger.info(`EA Session initialized for account ${this.accountId}`);
      }

      return isValid;
    } catch (error) {
      logger.error('Failed to init from cookies:', error);
      return false;
    }
  }

  async verifySession(): Promise<boolean> {
    try {
      const response = await this.getCredits();
      return response.credits !== undefined;
    } catch (error) {
      return false;
    }
  }

  // ==========================================
  // RATE LIMITING
  // ==========================================
  private async checkRateLimit(): Promise<void> {
    const now = Date.now();

    // Reset hourly counter
    if (now - this.hourStart > 3600000) {
      this.hourStart = now;
      this.requestCount = 0;
    }

    // Check if we're over limit
    if (this.requestCount >= config.trading.maxRequestsPerHour) {
      const waitTime = 3600000 - (now - this.hourStart);
      throw new Error(`Rate limit exceeded. Wait ${Math.ceil(waitTime / 60000)} minutes.`);
    }

    // Minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minDelay = config.trading.minSearchDelay;

    if (timeSinceLastRequest < minDelay) {
      await this.delay(minDelay - timeSinceLastRequest);
    }

    this.requestCount++;
    this.lastRequestTime = Date.now();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private randomDelay(): Promise<void> {
    const delay = Math.floor(
      Math.random() * (config.trading.maxSearchDelay - config.trading.minSearchDelay) +
      config.trading.minSearchDelay
    );
    return this.delay(delay);
  }

  // ==========================================
  // REQUEST HELPERS
  // ==========================================
  private getHeaders(): Record<string, string> {
    if (!this.session) {
      throw new Error('Session not initialized');
    }

    return {
      'X-UT-SID': this.session.sessionId,
      'X-UT-PHISHING-TOKEN': this.session.phishingToken,
      'X-Requested-With': 'ShockwaveFlash'
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: object
  ): Promise<T> {
    await this.checkRateLimit();

    const url = `/ut/game/fc26${endpoint}`;
    
    try {
      const response: AxiosResponse<T> = await this.client.request({
        method,
        url,
        data,
        headers: this.getHeaders()
      });

      return response.data;
    } catch (error: any) {
      throw this.handleError(error);
    }
  }

  private handleError(error: any): Error {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      switch (status) {
        case 401:
          return new Error('SESSION_EXPIRED');
        case 403:
          return new Error('FORBIDDEN');
        case 409:
          return new Error('CONFLICT');
        case 426:
          return new Error('CAPTCHA_REQUIRED');
        case 429:
          return new Error('RATE_LIMITED');
        case 458:
          return new Error('TRANSFER_MARKET_LOCKED');
        case 460:
          return new Error('ITEM_NOT_FOUND');
        case 461:
          return new Error('PERMISSION_DENIED');
        case 478:
          return new Error('NO_TRADE_EXISTS');
        case 512:
          return new Error('MARKET_LOCKED');
        default:
          return new Error(`EA_ERROR_${status}: ${JSON.stringify(data)}`);
      }
    }

    return error;
  }

  // ==========================================
  // API METHODS
  // ==========================================

  /**
   * Get current coins balance
   */
  async getCredits(): Promise<{ credits: number }> {
    return this.request<{ credits: number }>('GET', '/user/credits');
  }

  /**
   * Search transfer market
   */
  async search(filter: SearchFilter): Promise<SearchResponse> {
    await this.randomDelay();

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

    return this.request<SearchResponse>('GET', `/transfermarket?${params.toString()}`);
  }

  /**
   * Buy item instantly (BIN)
   */
  async buyNow(tradeId: number, price: number): Promise<BuyResponse> {
    const data = {
      bid: price
    };

    return this.request<BuyResponse>('PUT', `/trade/${tradeId}/bid`, data);
  }

  /**
   * Place a bid on item
   */
  async placeBid(tradeId: number, amount: number): Promise<BuyResponse> {
    const data = {
      bid: amount
    };

    return this.request<BuyResponse>('PUT', `/trade/${tradeId}/bid`, data);
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
    const data = {
      itemData: {
        id: itemId
      },
      startingBid: startPrice,
      duration: duration,
      buyNowPrice: buyNowPrice
    };

    return this.request<{ id: number }>('POST', '/auctionhouse', data);
  }

  /**
   * Get tradepile (items for sale)
   */
  async getTradepile(): Promise<{ auctionInfo: AuctionItem[] }> {
    return this.request<{ auctionInfo: AuctionItem[] }>('GET', '/tradepile');
  }

  /**
   * Get watchlist
   */
  async getWatchlist(): Promise<{ auctionInfo: AuctionItem[] }> {
    return this.request<{ auctionInfo: AuctionItem[] }>('GET', '/watchlist');
  }

  /**
   * Get unassigned items
   */
  async getUnassigned(): Promise<{ itemData: any[] }> {
    return this.request<{ itemData: any[] }>('GET', '/purchased/items');
  }

  /**
   * Send item to tradepile
   */
  async sendToTradepile(itemId: number): Promise<{ itemData: any[] }> {
    const data = {
      itemData: [{ id: itemId, pile: 'trade' }]
    };

    return this.request<{ itemData: any[] }>('PUT', '/item', data);
  }

  /**
   * Send item to club
   */
  async sendToClub(itemId: number): Promise<{ itemData: any[] }> {
    const data = {
      itemData: [{ id: itemId, pile: 'club' }]
    };

    return this.request<{ itemData: any[] }>('PUT', '/item', data);
  }

  /**
   * Quick sell item
   */
  async quickSell(itemId: number): Promise<{ credits: number }> {
    return this.request<{ credits: number }>('DELETE', `/item/${itemId}`);
  }

  /**
   * Relist all expired items
   */
  async relistAll(): Promise<{ tradeIdList: number[] }> {
    return this.request<{ tradeIdList: number[] }>('PUT', '/auctionhouse/relist');
  }

  /**
   * Remove sold items from tradepile
   */
  async removeSold(): Promise<void> {
    const tradepile = await this.getTradepile();
    const soldItems = tradepile.auctionInfo.filter(item => item.tradeState === 'closed');

    for (const item of soldItems) {
      await this.request('DELETE', `/trade/${item.tradeId}`);
      await this.delay(200);
    }
  }

  /**
   * Get lowest BIN price for a player
   */
  async getLowestBIN(playerId: number): Promise<number | null> {
    try {
      const result = await this.search({
        maskedDefId: playerId,
        count: 21
      });

      if (result.auctionInfo.length === 0) return null;

      const prices = result.auctionInfo.map(item => item.buyNowPrice);
      return Math.min(...prices);
    } catch (error) {
      logger.error(`Failed to get lowest BIN for player ${playerId}:`, error);
      return null;
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

  /**
   * Calculate sell price with EA tax
   */
  static calculateSellPrice(buyPrice: number, profitMargin: number = 0.05): number {
    // EA takes 5% tax, so we need to account for that
    const taxMultiplier = 0.95;
    const targetProfit = buyPrice * profitMargin;
    const sellPrice = Math.ceil((buyPrice + targetProfit) / taxMultiplier);
    
    // Round to valid price
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

  getRequestCount(): number {
    return this.requestCount;
  }

  getRemainingRequests(): number {
    return config.trading.maxRequestsPerHour - this.requestCount;
  }
}

// ==========================================
// EA API FACTORY
// ==========================================
export class EAAPIFactory {
  private static instances: Map<string, EAAPI> = new Map();

  static async getInstance(accountId: string): Promise<EAAPI | null> {
    // Return existing instance if available
    if (this.instances.has(accountId)) {
      return this.instances.get(accountId)!;
    }

    // Load account from database
    const accountData = await db.getEAAccountWithCookies(accountId);
    if (!accountData) {
      logger.error(`Account ${accountId} not found`);
      return null;
    }

    const { account, cookies } = accountData;

    // Create new API instance
    const api = new EAAPI(accountId, account.platform);
    const initialized = await api.initFromCookies(cookies as Record<string, string>);

    if (!initialized) {
      logger.error(`Failed to initialize EA API for account ${accountId}`);
      return null;
    }

    this.instances.set(accountId, api);
    return api;
  }

  static removeInstance(accountId: string): void {
    this.instances.delete(accountId);
  }

  static clearAll(): void {
    this.instances.clear();
  }
}
