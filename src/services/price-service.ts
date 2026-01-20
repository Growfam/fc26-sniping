import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from '../config';
import { logger } from '../utils/logger';
import { db } from '../database';

// ==========================================
// TYPES
// ==========================================
export interface PlayerPrice {
  playerId: number;
  platform: string;
  futbinPrice: number | null;
  futggPrice: number | null;
  lowestBin: number | null;
  prp: number | null; // Price Range Percentage
  updatedAt: Date;
}

export interface PlayerInfo {
  id: number;
  name: string;
  rating: number;
  position: string;
  nation: number;
  league: number;
  club: number;
  rarity: string;
}

// ==========================================
// FUTBIN SERVICE
// ==========================================
class FutbinService {
  private baseUrl = 'https://www.futbin.com';
  private apiUrl = 'https://www.futbin.com/futbin/api';
  
  private headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.futbin.com/'
  };

  /**
   * Get player price from FUTBIN
   */
  async getPrice(playerId: number, platform: string = 'ps'): Promise<number | null> {
    try {
      // FUTBIN platform mapping
      const platformMap: Record<string, string> = {
        'ps': 'ps',
        'xbox': 'xbox',
        'pc': 'pc'
      };

      const response = await axios.get(
        `${this.apiUrl}/fetchPlayerInformation/${playerId}`,
        { headers: this.headers, timeout: 10000 }
      );

      if (response.data && response.data.data) {
        const prices = response.data.data[playerId]?.prices;
        if (prices) {
          const platformKey = platformMap[platform] || 'ps';
          const price = prices[platformKey];
          
          if (price && price.LCPrice) {
            return parseInt(price.LCPrice.replace(/,/g, ''));
          }
        }
      }

      return null;
    } catch (error) {
      logger.warn(`FUTBIN price fetch failed for player ${playerId}:`, error);
      return null;
    }
  }

  /**
   * Get player prices with graph data
   */
  async getPriceGraph(playerId: number, platform: string = 'ps'): Promise<number[] | null> {
    try {
      const response = await axios.get(
        `${this.apiUrl}/fetchPlayerPriceHistory/${playerId}/${platform}`,
        { headers: this.headers, timeout: 10000 }
      );

      if (response.data && Array.isArray(response.data)) {
        return response.data.map((point: any) => point.price);
      }

      return null;
    } catch (error) {
      logger.warn(`FUTBIN price graph failed for player ${playerId}:`, error);
      return null;
    }
  }

  /**
   * Search players by name
   */
  async searchPlayer(name: string): Promise<PlayerInfo[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/search?year=26&term=${encodeURIComponent(name)}`,
        { headers: this.headers, timeout: 10000 }
      );

      const $ = cheerio.load(response.data);
      const players: PlayerInfo[] = [];

      $('.table-row').each((_, element) => {
        const row = $(element);
        const player: PlayerInfo = {
          id: parseInt(row.attr('data-player-id') || '0'),
          name: row.find('.player-name').text().trim(),
          rating: parseInt(row.find('.rating').text().trim()) || 0,
          position: row.find('.position').text().trim(),
          nation: parseInt(row.attr('data-nation') || '0'),
          league: parseInt(row.attr('data-league') || '0'),
          club: parseInt(row.attr('data-team') || '0'),
          rarity: row.attr('data-rarity') || 'common'
        };

        if (player.id > 0) {
          players.push(player);
        }
      });

      return players;
    } catch (error) {
      logger.error('FUTBIN search failed:', error);
      return [];
    }
  }

  /**
   * Get popular/trending players
   */
  async getPopularPlayers(): Promise<PlayerInfo[]> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/26/players?page=1&sort=views&order=desc`,
        { headers: this.headers, timeout: 10000 }
      );

      const $ = cheerio.load(response.data);
      const players: PlayerInfo[] = [];

      $('tr[data-player-id]').slice(0, 50).each((_, element) => {
        const row = $(element);
        const player: PlayerInfo = {
          id: parseInt(row.attr('data-player-id') || '0'),
          name: row.find('.player-name').text().trim(),
          rating: parseInt(row.find('.rating').text().trim()) || 0,
          position: row.find('.position').text().trim(),
          nation: parseInt(row.attr('data-nation') || '0'),
          league: parseInt(row.attr('data-league') || '0'),
          club: parseInt(row.attr('data-team') || '0'),
          rarity: row.attr('data-rarity') || 'common'
        };

        if (player.id > 0) {
          players.push(player);
        }
      });

      return players;
    } catch (error) {
      logger.error('FUTBIN popular players failed:', error);
      return [];
    }
  }
}

// ==========================================
// FUT.GG SERVICE
// ==========================================
class FutGGService {
  private baseUrl = 'https://www.fut.gg';
  private apiUrl = 'https://api.fut.gg';

  private headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  /**
   * Get player price from FUT.GG
   */
  async getPrice(playerId: number, platform: string = 'ps'): Promise<number | null> {
    try {
      const platformMap: Record<string, string> = {
        'ps': 'ps',
        'xbox': 'xb',
        'pc': 'pc'
      };

      const response = await axios.get(
        `${this.apiUrl}/fc26/players/${playerId}/prices`,
        { 
          headers: this.headers, 
          timeout: 10000,
          params: { platform: platformMap[platform] }
        }
      );

      if (response.data && response.data.prices) {
        return response.data.prices.lowestBin || null;
      }

      return null;
    } catch (error) {
      logger.warn(`FUT.GG price fetch failed for player ${playerId}:`, error);
      return null;
    }
  }

  /**
   * Search players
   */
  async searchPlayer(name: string): Promise<PlayerInfo[]> {
    try {
      const response = await axios.get(
        `${this.apiUrl}/fc26/players/search`,
        { 
          headers: this.headers, 
          timeout: 10000,
          params: { q: name }
        }
      );

      if (response.data && Array.isArray(response.data.players)) {
        return response.data.players.map((p: any) => ({
          id: p.eaId || p.id,
          name: `${p.firstName} ${p.lastName}`.trim(),
          rating: p.rating,
          position: p.position,
          nation: p.nationId,
          league: p.leagueId,
          club: p.clubId,
          rarity: p.rarity || 'common'
        }));
      }

      return [];
    } catch (error) {
      logger.error('FUT.GG search failed:', error);
      return [];
    }
  }
}

// ==========================================
// COMBINED PRICE SERVICE
// ==========================================
export class PriceService {
  private futbin: FutbinService;
  private futgg: FutGGService;

  constructor() {
    this.futbin = new FutbinService();
    this.futgg = new FutGGService();
  }

  /**
   * Get best price from all sources
   */
  async getPrice(playerId: number, platform: string = 'ps'): Promise<PlayerPrice> {
    // Check cache first
    const cached = await db.getCachedPrice(playerId, platform);
    if (cached) {
      return {
        playerId,
        platform,
        futbinPrice: cached.futbin_price,
        futggPrice: cached.futgg_price,
        lowestBin: cached.lowest_bin,
        prp: null,
        updatedAt: new Date(cached.updated_at)
      };
    }

    // Fetch from sources in parallel
    const [futbinPrice, futggPrice] = await Promise.all([
      config.prices.futbinEnabled ? this.futbin.getPrice(playerId, platform) : null,
      config.prices.futggEnabled ? this.futgg.getPrice(playerId, platform) : null
    ]);

    // Calculate lowest known price
    const prices = [futbinPrice, futggPrice].filter(p => p !== null) as number[];
    const lowestBin = prices.length > 0 ? Math.min(...prices) : null;

    // Update cache
    await db.updatePriceCache(playerId, platform, {
      futbin: futbinPrice || undefined,
      futgg: futggPrice || undefined,
      lowestBin: lowestBin || undefined
    });

    return {
      playerId,
      platform,
      futbinPrice,
      futggPrice,
      lowestBin,
      prp: null,
      updatedAt: new Date()
    };
  }

  /**
   * Get prices for multiple players
   */
  async getPrices(playerIds: number[], platform: string = 'ps'): Promise<Map<number, PlayerPrice>> {
    const results = new Map<number, PlayerPrice>();

    // Batch fetch with concurrency limit
    const batchSize = 5;
    for (let i = 0; i < playerIds.length; i += batchSize) {
      const batch = playerIds.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(id => this.getPrice(id, platform))
      );

      batchResults.forEach((price, index) => {
        results.set(batch[index], price);
      });

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < playerIds.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  }

  /**
   * Search player by name (uses all sources)
   */
  async searchPlayer(name: string): Promise<PlayerInfo[]> {
    const [futbinResults, futggResults] = await Promise.all([
      this.futbin.searchPlayer(name),
      this.futgg.searchPlayer(name)
    ]);

    // Merge and deduplicate results
    const playersMap = new Map<number, PlayerInfo>();

    futbinResults.forEach(p => playersMap.set(p.id, p));
    futggResults.forEach(p => {
      if (!playersMap.has(p.id)) {
        playersMap.set(p.id, p);
      }
    });

    return Array.from(playersMap.values());
  }

  /**
   * Get price recommendation for trading
   */
  async getTradeRecommendation(
    playerId: number, 
    platform: string = 'ps'
  ): Promise<{
    buyPrice: number;
    sellPrice: number;
    profit: number;
    profitPercent: number;
  } | null> {
    const price = await this.getPrice(playerId, platform);

    if (!price.lowestBin) return null;

    // Calculate optimal buy/sell prices
    const marketPrice = price.lowestBin;
    const buyPrice = Math.floor(marketPrice * 0.90); // Buy at 90% of market
    const sellPrice = Math.floor(marketPrice * 0.98); // Sell at 98% of market
    const eaTax = Math.floor(sellPrice * 0.05); // 5% EA tax
    const profit = sellPrice - eaTax - buyPrice;
    const profitPercent = (profit / buyPrice) * 100;

    return {
      buyPrice,
      sellPrice,
      profit,
      profitPercent
    };
  }

  /**
   * Get popular players from FUTBIN
   */
  async getPopularPlayers(): Promise<PlayerInfo[]> {
    return this.futbin.getPopularPlayers();
  }

  /**
   * Get price history/trend
   */
  async getPriceTrend(playerId: number, platform: string = 'ps'): Promise<{
    current: number | null;
    trend: 'up' | 'down' | 'stable';
    change24h: number;
    history: number[];
  }> {
    const price = await this.getPrice(playerId, platform);
    const history = await this.futbin.getPriceGraph(playerId, platform);

    if (!history || history.length < 2) {
      return {
        current: price.lowestBin,
        trend: 'stable',
        change24h: 0,
        history: history || []
      };
    }

    const current = history[history.length - 1];
    const yesterday = history[Math.max(0, history.length - 24)];
    const change24h = ((current - yesterday) / yesterday) * 100;

    let trend: 'up' | 'down' | 'stable' = 'stable';
    if (change24h > 5) trend = 'up';
    else if (change24h < -5) trend = 'down';

    return {
      current: price.lowestBin,
      trend,
      change24h,
      history
    };
  }
}

export const priceService = new PriceService();
