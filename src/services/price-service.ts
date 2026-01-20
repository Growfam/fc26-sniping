/**
 * FC26 Price Service
 * Get player prices from FUTBIN/FUT.GG
 */

import axios from 'axios';
import { logger } from '../utils/logger';
import { config } from '../config';

// ==========================================
// TYPES
// ==========================================

export interface PlayerPrice {
  lowestBin: number | null;
  averagePrice: number | null;
  lastUpdated: Date;
  platform: string;
}

export interface PlayerInfo {
  id: number;
  name: string;
  rating: number;
  position: string;
  club: string;
  nation: string;
}

// ==========================================
// CACHE
// ==========================================

interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  
  const isExpired = Date.now() - entry.timestamp > config.prices.cacheTTL * 1000;
  if (isExpired) {
    cache.delete(key);
    return null;
  }
  
  return entry.data as T;
}

function setCache(key: string, data: any): void {
  cache.set(key, {
    data,
    timestamp: Date.now()
  });
}

// ==========================================
// PRICE SERVICE
// ==========================================

class PriceService {
  private readonly FUTBIN_API = 'https://www.futbin.com/26/playerPrices';
  private readonly FUTGG_API = 'https://www.fut.gg/api/fut26/players';

  // ==========================================
  // SEARCH PLAYER
  // ==========================================

  async searchPlayer(query: string): Promise<PlayerInfo[]> {
    try {
      // Try FUTBIN first
      if (config.prices.futbinEnabled) {
        const results = await this.searchFutbin(query);
        if (results.length > 0) return results;
      }

      // Fallback to FUT.GG
      if (config.prices.futggEnabled) {
        return await this.searchFutgg(query);
      }

      return [];
    } catch (error) {
      logger.error('Player search error:', error);
      return [];
    }
  }

  private async searchFutbin(query: string): Promise<PlayerInfo[]> {
    try {
      const response = await axios.get(
        `https://www.futbin.com/search?year=26&term=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      return response.data.map((p: any) => ({
        id: p.id,
        name: p.name || `${p.common_name || p.first_name} ${p.last_name}`,
        rating: p.rating,
        position: p.position,
        club: p.club_name || '',
        nation: p.nation_name || ''
      }));
    } catch (error) {
      logger.debug('FUTBIN search failed:', error);
      return [];
    }
  }

  private async searchFutgg(query: string): Promise<PlayerInfo[]> {
    try {
      const response = await axios.get(
        `${this.FUTGG_API}/search?q=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.data?.data) return [];

      return response.data.data.map((p: any) => ({
        id: p.ea_id || p.id,
        name: p.name,
        rating: p.rating,
        position: p.position,
        club: p.club?.name || '',
        nation: p.nation?.name || ''
      }));
    } catch (error) {
      logger.debug('FUT.GG search failed:', error);
      return [];
    }
  }

  // ==========================================
  // GET PRICE
  // ==========================================

  async getPrice(playerId: number, platform: string = 'ps'): Promise<PlayerPrice> {
    const cacheKey = `price_${playerId}_${platform}`;
    const cached = getCached<PlayerPrice>(cacheKey);
    if (cached) return cached;

    try {
      let price: PlayerPrice | null = null;

      // Try FUTBIN
      if (config.prices.futbinEnabled) {
        price = await this.getPriceFutbin(playerId, platform);
      }

      // Fallback to FUT.GG
      if (!price?.lowestBin && config.prices.futggEnabled) {
        price = await this.getPriceFutgg(playerId, platform);
      }

      const result: PlayerPrice = price || {
        lowestBin: null,
        averagePrice: null,
        lastUpdated: new Date(),
        platform
      };

      setCache(cacheKey, result);
      return result;
    } catch (error) {
      logger.error('Get price error:', error);
      return {
        lowestBin: null,
        averagePrice: null,
        lastUpdated: new Date(),
        platform
      };
    }
  }

  private async getPriceFutbin(playerId: number, platform: string): Promise<PlayerPrice | null> {
    try {
      const response = await axios.get(
        `${this.FUTBIN_API}?id=${playerId}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      const platformKey = this.getFutbinPlatformKey(platform);
      const priceData = response.data?.[playerId]?.prices?.[platformKey];

      if (!priceData) return null;

      return {
        lowestBin: this.parsePrice(priceData.LCPrice),
        averagePrice: this.parsePrice(priceData.LCPrice2),
        lastUpdated: new Date(priceData.updated),
        platform
      };
    } catch (error) {
      logger.debug('FUTBIN price fetch failed:', error);
      return null;
    }
  }

  private async getPriceFutgg(playerId: number, platform: string): Promise<PlayerPrice | null> {
    try {
      const response = await axios.get(
        `${this.FUTGG_API}/${playerId}/prices`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      const prices = response.data?.data;
      if (!prices) return null;

      const platformPrices = prices[platform] || prices.ps || prices.xbox || prices.pc;

      return {
        lowestBin: platformPrices?.lowest_bin || null,
        averagePrice: platformPrices?.average || null,
        lastUpdated: new Date(),
        platform
      };
    } catch (error) {
      logger.debug('FUT.GG price fetch failed:', error);
      return null;
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================

  private getFutbinPlatformKey(platform: string): string {
    const map: { [key: string]: string } = {
      'ps': 'ps',
      'xbox': 'xbox',
      'pc': 'pc'
    };
    return map[platform] || 'ps';
  }

  private parsePrice(price: string | number | null | undefined): number | null {
    if (!price) return null;
    
    if (typeof price === 'number') return price;
    
    // Remove commas and parse
    const cleaned = price.toString().replace(/,/g, '');
    const parsed = parseInt(cleaned);
    
    return isNaN(parsed) ? null : parsed;
  }

  // ==========================================
  // CLEAR CACHE
  // ==========================================

  clearCache(): void {
    cache.clear();
  }
}

// Export singleton
export const priceService = new PriceService();
