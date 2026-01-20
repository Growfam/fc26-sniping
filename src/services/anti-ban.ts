/**
 * FC26 Anti-Ban System
 * 
 * Comprehensive protection against EA bans based on:
 * - futapi/fut guidelines (500 req/hour, 5000/day)
 * - MagicBuyer-UT patterns (7-15s delays, cycle pauses)
 * - FifaSharp session management
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { config } from '../config';

// ==========================================
// TYPES & INTERFACES
// ==========================================

export interface AntiBanConfig {
  // Delays (milliseconds)
  searchDelay: { min: number; max: number };
  buyDelay: { min: number; max: number };
  actionDelay: { min: number; max: number };
  
  // Limits
  maxSearchesPerHour: number;
  maxPurchasesPerHour: number;
  maxRequestsPerHour: number;
  maxRequestsPerDay: number;
  
  // Session management
  sessionDurationMs: number;
  pauseBetweenSessionsMs: number;
  
  // Cycle pauses
  pauseAfterSearches: number;
  cyclePauseDuration: { min: number; max: number };
  
  // Night mode (hours 0-23)
  nightModeStart: number;
  nightModeEnd: number;
  nightModeEnabled: boolean;
  
  // Error handling
  stopOnErrorCodes: number[];
  maxConsecutiveErrors: number;
  
  // Risk management
  riskThresholds: {
    low: number;      // 0-30%
    medium: number;   // 30-60%
    high: number;     // 60-100%
  };
}

export interface SessionStats {
  accountId: string;
  sessionStart: Date;
  requestsThisHour: number;
  requestsToday: number;
  searchesThisHour: number;
  purchasesThisHour: number;
  errorsThisHour: number;
  consecutiveErrors: number;
  lastRequestTime: Date | null;
  lastSearchTime: Date | null;
  lastPurchaseTime: Date | null;
  hourStart: Date;
  dayStart: Date;
  searchesSinceLastPause: number;
  currentRiskLevel: RiskLevel;
}

export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

export enum AntiBanAction {
  PROCEED = 'proceed',
  DELAY = 'delay',
  PAUSE = 'pause',
  STOP = 'stop'
}

export interface AntiBanDecision {
  action: AntiBanAction;
  delayMs?: number;
  pauseMs?: number;
  reason: string;
  riskLevel: RiskLevel;
  stats: SessionStats;
}

// ==========================================
// DEFAULT CONFIGURATION
// ==========================================

export const DEFAULT_ANTI_BAN_CONFIG: AntiBanConfig = {
  // Delays - based on MagicBuyer-UT recommendations
  searchDelay: { min: 7000, max: 15000 },
  buyDelay: { min: 1000, max: 3000 },
  actionDelay: { min: 500, max: 1500 },
  
  // Limits - based on futapi/fut guidelines
  maxSearchesPerHour: 350,
  maxPurchasesPerHour: 25,
  maxRequestsPerHour: 400,
  maxRequestsPerDay: 5000,
  
  // Session management
  sessionDurationMs: 90 * 60 * 1000, // 1.5 hours
  pauseBetweenSessionsMs: 30 * 60 * 1000, // 30 minutes
  
  // Cycle pauses - MagicBuyer pattern
  pauseAfterSearches: 50,
  cyclePauseDuration: { min: 30000, max: 60000 },
  
  // Night mode
  nightModeStart: 2,  // 02:00
  nightModeEnd: 8,    // 08:00
  nightModeEnabled: true,
  
  // Error handling
  stopOnErrorCodes: [421, 429, 458, 461, 512],
  maxConsecutiveErrors: 5,
  
  // Risk thresholds (percentage of limit)
  riskThresholds: {
    low: 30,
    medium: 60,
    high: 85
  }
};

// ==========================================
// ANTI-BAN SERVICE
// ==========================================

export class AntiBanService extends EventEmitter {
  private config: AntiBanConfig;
  private sessions: Map<string, SessionStats> = new Map();
  private globalPaused: boolean = false;
  private pausedUntil: Date | null = null;

  constructor(customConfig?: Partial<AntiBanConfig>) {
    super();
    this.config = { ...DEFAULT_ANTI_BAN_CONFIG, ...customConfig };
  }

  // ==========================================
  // SESSION MANAGEMENT
  // ==========================================

  /**
   * Initialize session stats for an account
   */
  initSession(accountId: string): SessionStats {
    const now = new Date();
    const stats: SessionStats = {
      accountId,
      sessionStart: now,
      requestsThisHour: 0,
      requestsToday: 0,
      searchesThisHour: 0,
      purchasesThisHour: 0,
      errorsThisHour: 0,
      consecutiveErrors: 0,
      lastRequestTime: null,
      lastSearchTime: null,
      lastPurchaseTime: null,
      hourStart: now,
      dayStart: new Date(now.setHours(0, 0, 0, 0)),
      searchesSinceLastPause: 0,
      currentRiskLevel: RiskLevel.LOW
    };

    this.sessions.set(accountId, stats);
    logger.info(`[AntiBan] Session initialized for ${accountId}`);
    return stats;
  }

  /**
   * Get session stats for an account
   */
  getSession(accountId: string): SessionStats | undefined {
    return this.sessions.get(accountId);
  }

  /**
   * Remove session
   */
  removeSession(accountId: string): void {
    this.sessions.delete(accountId);
    logger.info(`[AntiBan] Session removed for ${accountId}`);
  }

  // ==========================================
  // CORE DECISION LOGIC
  // ==========================================

  /**
   * Main decision function - call before ANY request
   */
  async shouldProceed(
    accountId: string, 
    requestType: 'search' | 'buy' | 'action'
  ): Promise<AntiBanDecision> {
    let stats = this.sessions.get(accountId);
    
    if (!stats) {
      stats = this.initSession(accountId);
    }

    // Reset hourly counters if needed
    this.resetHourlyCountersIfNeeded(stats);

    // Check night mode
    if (this.isNightModeActive()) {
      return {
        action: AntiBanAction.STOP,
        reason: 'Night mode active (02:00-08:00)',
        riskLevel: RiskLevel.LOW,
        stats
      };
    }

    // Check global pause
    if (this.globalPaused && this.pausedUntil) {
      const remainingMs = this.pausedUntil.getTime() - Date.now();
      if (remainingMs > 0) {
        return {
          action: AntiBanAction.PAUSE,
          pauseMs: remainingMs,
          reason: 'Global pause active',
          riskLevel: stats.currentRiskLevel,
          stats
        };
      } else {
        this.globalPaused = false;
        this.pausedUntil = null;
      }
    }

    // Check consecutive errors
    if (stats.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      return {
        action: AntiBanAction.STOP,
        reason: `Too many consecutive errors: ${stats.consecutiveErrors}`,
        riskLevel: RiskLevel.CRITICAL,
        stats
      };
    }

    // Check session duration
    const sessionDuration = Date.now() - stats.sessionStart.getTime();
    if (sessionDuration >= this.config.sessionDurationMs) {
      return {
        action: AntiBanAction.PAUSE,
        pauseMs: this.config.pauseBetweenSessionsMs,
        reason: 'Session duration exceeded, need break',
        riskLevel: RiskLevel.MEDIUM,
        stats
      };
    }

    // Check limits
    const limitCheck = this.checkLimits(stats, requestType);
    if (limitCheck.action !== AntiBanAction.PROCEED) {
      return limitCheck;
    }

    // Check cycle pause
    if (requestType === 'search' && 
        stats.searchesSinceLastPause >= this.config.pauseAfterSearches) {
      const pauseDuration = this.randomDelay(
        this.config.cyclePauseDuration.min,
        this.config.cyclePauseDuration.max
      );
      stats.searchesSinceLastPause = 0;
      return {
        action: AntiBanAction.PAUSE,
        pauseMs: pauseDuration,
        reason: `Cycle pause after ${this.config.pauseAfterSearches} searches`,
        riskLevel: RiskLevel.LOW,
        stats
      };
    }

    // Calculate delay
    const delay = this.calculateDelay(stats, requestType);
    
    // Update risk level
    stats.currentRiskLevel = this.calculateRiskLevel(stats);

    return {
      action: delay > 0 ? AntiBanAction.DELAY : AntiBanAction.PROCEED,
      delayMs: delay,
      reason: delay > 0 ? 'Normal delay between requests' : 'OK to proceed',
      riskLevel: stats.currentRiskLevel,
      stats
    };
  }

  /**
   * Check all limits
   */
  private checkLimits(stats: SessionStats, requestType: string): AntiBanDecision {
    // Daily limit
    if (stats.requestsToday >= this.config.maxRequestsPerDay) {
      return {
        action: AntiBanAction.STOP,
        reason: `Daily request limit reached: ${stats.requestsToday}/${this.config.maxRequestsPerDay}`,
        riskLevel: RiskLevel.CRITICAL,
        stats
      };
    }

    // Hourly request limit
    if (stats.requestsThisHour >= this.config.maxRequestsPerHour) {
      const minutesToNextHour = 60 - new Date().getMinutes();
      return {
        action: AntiBanAction.PAUSE,
        pauseMs: minutesToNextHour * 60 * 1000,
        reason: `Hourly request limit reached: ${stats.requestsThisHour}/${this.config.maxRequestsPerHour}`,
        riskLevel: RiskLevel.HIGH,
        stats
      };
    }

    // Search limit
    if (requestType === 'search' && stats.searchesThisHour >= this.config.maxSearchesPerHour) {
      const minutesToNextHour = 60 - new Date().getMinutes();
      return {
        action: AntiBanAction.PAUSE,
        pauseMs: minutesToNextHour * 60 * 1000,
        reason: `Hourly search limit reached: ${stats.searchesThisHour}/${this.config.maxSearchesPerHour}`,
        riskLevel: RiskLevel.HIGH,
        stats
      };
    }

    // Purchase limit
    if (requestType === 'buy' && stats.purchasesThisHour >= this.config.maxPurchasesPerHour) {
      const minutesToNextHour = 60 - new Date().getMinutes();
      return {
        action: AntiBanAction.PAUSE,
        pauseMs: minutesToNextHour * 60 * 1000,
        reason: `Hourly purchase limit reached: ${stats.purchasesThisHour}/${this.config.maxPurchasesPerHour}`,
        riskLevel: RiskLevel.HIGH,
        stats
      };
    }

    return {
      action: AntiBanAction.PROCEED,
      reason: 'All limits OK',
      riskLevel: stats.currentRiskLevel,
      stats
    };
  }

  // ==========================================
  // DELAY CALCULATION
  // ==========================================

  /**
   * Calculate appropriate delay based on request type and current stats
   */
  private calculateDelay(stats: SessionStats, requestType: string): number {
    let baseDelay: { min: number; max: number };

    switch (requestType) {
      case 'search':
        baseDelay = this.config.searchDelay;
        break;
      case 'buy':
        baseDelay = this.config.buyDelay;
        break;
      default:
        baseDelay = this.config.actionDelay;
    }

    // Calculate time since last request
    const timeSinceLastRequest = stats.lastRequestTime
      ? Date.now() - stats.lastRequestTime.getTime()
      : Infinity;

    // If enough time has passed, no additional delay needed
    if (timeSinceLastRequest >= baseDelay.min) {
      return 0;
    }

    // Calculate delay based on risk level
    let multiplier = 1;
    switch (stats.currentRiskLevel) {
      case RiskLevel.MEDIUM:
        multiplier = 1.5;
        break;
      case RiskLevel.HIGH:
        multiplier = 2;
        break;
      case RiskLevel.CRITICAL:
        multiplier = 3;
        break;
    }

    const delay = this.randomDelay(
      baseDelay.min * multiplier,
      baseDelay.max * multiplier
    );

    // Subtract time already waited
    return Math.max(0, delay - timeSinceLastRequest);
  }

  /**
   * Generate random delay
   */
  private randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ==========================================
  // RISK CALCULATION
  // ==========================================

  /**
   * Calculate current risk level
   */
  private calculateRiskLevel(stats: SessionStats): RiskLevel {
    const requestPercentage = (stats.requestsThisHour / this.config.maxRequestsPerHour) * 100;
    const searchPercentage = (stats.searchesThisHour / this.config.maxSearchesPerHour) * 100;
    const purchasePercentage = (stats.purchasesThisHour / this.config.maxPurchasesPerHour) * 100;
    
    const maxPercentage = Math.max(requestPercentage, searchPercentage, purchasePercentage);
    
    // Add error factor
    const errorFactor = stats.errorsThisHour * 5; // Each error adds 5%
    const totalRisk = maxPercentage + errorFactor;

    if (totalRisk >= this.config.riskThresholds.high) {
      return RiskLevel.HIGH;
    } else if (totalRisk >= this.config.riskThresholds.medium) {
      return RiskLevel.MEDIUM;
    } else {
      return RiskLevel.LOW;
    }
  }

  /**
   * Get risk percentage
   */
  getRiskPercentage(accountId: string): number {
    const stats = this.sessions.get(accountId);
    if (!stats) return 0;

    const requestPercentage = (stats.requestsThisHour / this.config.maxRequestsPerHour) * 100;
    const searchPercentage = (stats.searchesThisHour / this.config.maxSearchesPerHour) * 100;
    const purchasePercentage = (stats.purchasesThisHour / this.config.maxPurchasesPerHour) * 100;
    const errorFactor = stats.errorsThisHour * 5;
    
    return Math.min(100, Math.max(requestPercentage, searchPercentage, purchasePercentage) + errorFactor);
  }

  // ==========================================
  // EVENT RECORDING
  // ==========================================

  /**
   * Record a request
   */
  recordRequest(accountId: string, requestType: 'search' | 'buy' | 'action'): void {
    const stats = this.sessions.get(accountId);
    if (!stats) return;

    const now = new Date();
    stats.requestsThisHour++;
    stats.requestsToday++;
    stats.lastRequestTime = now;
    stats.consecutiveErrors = 0; // Reset on successful request

    if (requestType === 'search') {
      stats.searchesThisHour++;
      stats.searchesSinceLastPause++;
      stats.lastSearchTime = now;
    } else if (requestType === 'buy') {
      stats.purchasesThisHour++;
      stats.lastPurchaseTime = now;
    }

    // Update risk level
    stats.currentRiskLevel = this.calculateRiskLevel(stats);

    // Emit stats update
    this.emit('stats_updated', stats);

    logger.debug(`[AntiBan] Recorded ${requestType} for ${accountId}. ` +
      `Requests: ${stats.requestsThisHour}/${this.config.maxRequestsPerHour}, ` +
      `Risk: ${stats.currentRiskLevel}`);
  }

  /**
   * Record an error
   */
  recordError(accountId: string, errorCode: number): AntiBanDecision {
    const stats = this.sessions.get(accountId);
    if (!stats) {
      return {
        action: AntiBanAction.PROCEED,
        reason: 'No session found',
        riskLevel: RiskLevel.LOW,
        stats: this.initSession(accountId)
      };
    }

    stats.errorsThisHour++;
    stats.consecutiveErrors++;

    // Check if this is a stop error
    if (this.config.stopOnErrorCodes.includes(errorCode)) {
      logger.warn(`[AntiBan] Critical error ${errorCode} for ${accountId}. Stopping.`);
      
      this.emit('critical_error', { accountId, errorCode, stats });
      
      return {
        action: AntiBanAction.STOP,
        reason: `Critical error code: ${errorCode}`,
        riskLevel: RiskLevel.CRITICAL,
        stats
      };
    }

    // Check consecutive errors
    if (stats.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      logger.warn(`[AntiBan] Max consecutive errors reached for ${accountId}. Stopping.`);
      
      return {
        action: AntiBanAction.STOP,
        reason: `Max consecutive errors: ${stats.consecutiveErrors}`,
        riskLevel: RiskLevel.CRITICAL,
        stats
      };
    }

    // Update risk level
    stats.currentRiskLevel = this.calculateRiskLevel(stats);

    // Emit error event
    this.emit('error_recorded', { accountId, errorCode, stats });

    // Return appropriate action based on error count
    const pauseDuration = Math.min(stats.consecutiveErrors * 10000, 60000);
    
    return {
      action: AntiBanAction.PAUSE,
      pauseMs: pauseDuration,
      reason: `Error recorded: ${errorCode}. Errors this hour: ${stats.errorsThisHour}`,
      riskLevel: stats.currentRiskLevel,
      stats
    };
  }

  // ==========================================
  // HELPER METHODS
  // ==========================================

  /**
   * Check if night mode is active
   */
  private isNightModeActive(): boolean {
    if (!this.config.nightModeEnabled) return false;
    
    const hour = new Date().getHours();
    
    if (this.config.nightModeStart <= this.config.nightModeEnd) {
      return hour >= this.config.nightModeStart && hour < this.config.nightModeEnd;
    } else {
      // Handle wrap-around (e.g., 22:00 to 06:00)
      return hour >= this.config.nightModeStart || hour < this.config.nightModeEnd;
    }
  }

  /**
   * Reset hourly counters if new hour started
   */
  private resetHourlyCountersIfNeeded(stats: SessionStats): void {
    const now = new Date();
    const hoursSinceStart = (now.getTime() - stats.hourStart.getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceStart >= 1) {
      stats.requestsThisHour = 0;
      stats.searchesThisHour = 0;
      stats.purchasesThisHour = 0;
      stats.errorsThisHour = 0;
      stats.hourStart = now;
      
      logger.info(`[AntiBan] Hourly counters reset for ${stats.accountId}`);
    }

    // Reset daily counters
    const daysSinceStart = (now.getTime() - stats.dayStart.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceStart >= 1) {
      stats.requestsToday = 0;
      stats.dayStart = new Date(now.setHours(0, 0, 0, 0));
      
      logger.info(`[AntiBan] Daily counters reset for ${stats.accountId}`);
    }
  }

  /**
   * Force global pause
   */
  forcePause(durationMs: number): void {
    this.globalPaused = true;
    this.pausedUntil = new Date(Date.now() + durationMs);
    
    logger.warn(`[AntiBan] Global pause activated for ${durationMs / 1000}s`);
    this.emit('global_pause', { durationMs, until: this.pausedUntil });
  }

  /**
   * Resume from global pause
   */
  resumeFromPause(): void {
    this.globalPaused = false;
    this.pausedUntil = null;
    
    logger.info(`[AntiBan] Resumed from global pause`);
    this.emit('global_resume', {});
  }

  /**
   * Reset session for new work cycle
   */
  resetSession(accountId: string): void {
    const stats = this.sessions.get(accountId);
    if (stats) {
      stats.sessionStart = new Date();
      stats.searchesSinceLastPause = 0;
      stats.consecutiveErrors = 0;
      stats.currentRiskLevel = RiskLevel.LOW;
      
      logger.info(`[AntiBan] Session reset for ${accountId}`);
    }
  }

  /**
   * Get human-readable status
   */
  getStatus(accountId: string): string {
    const stats = this.sessions.get(accountId);
    if (!stats) return 'No session';

    const risk = this.getRiskPercentage(accountId);
    const riskEmoji = risk < 30 ? '🟢' : risk < 60 ? '🟡' : risk < 85 ? '🟠' : '🔴';

    return [
      `${riskEmoji} Risk: ${risk.toFixed(1)}%`,
      `📊 Requests: ${stats.requestsThisHour}/${this.config.maxRequestsPerHour}`,
      `🔍 Searches: ${stats.searchesThisHour}/${this.config.maxSearchesPerHour}`,
      `💰 Purchases: ${stats.purchasesThisHour}/${this.config.maxPurchasesPerHour}`,
      `⚠️ Errors: ${stats.errorsThisHour}`,
      `⏱️ Session: ${Math.floor((Date.now() - stats.sessionStart.getTime()) / 60000)}min`
    ].join('\n');
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<AntiBanConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info(`[AntiBan] Configuration updated`);
    this.emit('config_updated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): AntiBanConfig {
    return { ...this.config };
  }
}

// Export singleton instance
export const antiBanService = new AntiBanService();
