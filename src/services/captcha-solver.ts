/**
 * FC26 Captcha Solver Service
 * 
 * Integration with Anti-Captcha and 2Captcha APIs
 * for automated captcha solving when detected
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { config } from '../config';

// ==========================================
// TYPES & INTERFACES
// ==========================================

export interface CaptchaConfig {
  provider: 'anticaptcha' | '2captcha' | 'manual';
  apiKey: string;
  timeout: number;       // Max wait time in ms
  pollingInterval: number; // Check interval in ms
}

export interface CaptchaSolution {
  success: boolean;
  solution?: string;
  error?: string;
  timeSpent?: number;
  cost?: number;
}

export interface CaptchaTask {
  type: 'recaptcha_v2' | 'recaptcha_v3' | 'funcaptcha' | 'image';
  websiteURL: string;
  websiteKey?: string;     // For reCAPTCHA
  publicKey?: string;      // For FunCaptcha
  imageBase64?: string;    // For image captcha
  minScore?: number;       // For reCAPTCHA v3
}

// ==========================================
// CAPTCHA SOLVER SERVICE
// ==========================================

export class CaptchaSolverService extends EventEmitter {
  private config: CaptchaConfig;
  private pendingTasks: Map<string, NodeJS.Timeout> = new Map();

  // API endpoints
  private readonly ANTICAPTCHA_API = 'https://api.anti-captcha.com';
  private readonly TWOCAPTCHA_API = 'https://2captcha.com';

  constructor(customConfig?: Partial<CaptchaConfig>) {
    super();
    
    this.config = {
      provider: 'anticaptcha',
      apiKey: config.captcha?.apiKey || '',
      timeout: 120000,      // 2 minutes
      pollingInterval: 5000, // 5 seconds
      ...customConfig
    };
  }

  // ==========================================
  // MAIN SOLVER METHODS
  // ==========================================

  /**
   * Solve captcha automatically
   */
  async solve(task: CaptchaTask): Promise<CaptchaSolution> {
    const startTime = Date.now();

    logger.info(`[Captcha] Starting ${task.type} solve...`);
    this.emit('captcha_started', { type: task.type });

    try {
      if (this.config.provider === 'manual') {
        return this.waitForManualSolution(task);
      }

      if (!this.config.apiKey) {
        return {
          success: false,
          error: 'Captcha API key not configured'
        };
      }

      let solution: CaptchaSolution;

      switch (this.config.provider) {
        case 'anticaptcha':
          solution = await this.solveWithAntiCaptcha(task);
          break;
        case '2captcha':
          solution = await this.solveWith2Captcha(task);
          break;
        default:
          solution = { success: false, error: 'Unknown captcha provider' };
      }

      solution.timeSpent = Date.now() - startTime;

      if (solution.success) {
        logger.info(`[Captcha] Solved in ${solution.timeSpent}ms`);
        this.emit('captcha_solved', solution);
      } else {
        logger.error(`[Captcha] Failed: ${solution.error}`);
        this.emit('captcha_failed', solution);
      }

      return solution;

    } catch (error: any) {
      logger.error(`[Captcha] Error:`, error);
      return {
        success: false,
        error: error.message,
        timeSpent: Date.now() - startTime
      };
    }
  }

  // ==========================================
  // ANTI-CAPTCHA IMPLEMENTATION
  // ==========================================

  private async solveWithAntiCaptcha(task: CaptchaTask): Promise<CaptchaSolution> {
    // Create task
    const createTaskResponse = await this.antiCaptchaCreateTask(task);
    
    if (!createTaskResponse.taskId) {
      return {
        success: false,
        error: createTaskResponse.errorDescription || 'Failed to create task'
      };
    }

    // Wait for solution
    return this.antiCaptchaWaitForResult(createTaskResponse.taskId);
  }

  private async antiCaptchaCreateTask(task: CaptchaTask): Promise<any> {
    let taskBody: any = {
      clientKey: this.config.apiKey,
      task: {
        websiteURL: task.websiteURL,
      }
    };

    switch (task.type) {
      case 'recaptcha_v2':
        taskBody.task.type = 'RecaptchaV2TaskProxyless';
        taskBody.task.websiteKey = task.websiteKey;
        break;

      case 'recaptcha_v3':
        taskBody.task.type = 'RecaptchaV3TaskProxyless';
        taskBody.task.websiteKey = task.websiteKey;
        taskBody.task.minScore = task.minScore || 0.3;
        taskBody.task.pageAction = 'verify';
        break;

      case 'funcaptcha':
        taskBody.task.type = 'FunCaptchaTaskProxyless';
        taskBody.task.websitePublicKey = task.publicKey;
        break;

      case 'image':
        taskBody.task.type = 'ImageToTextTask';
        taskBody.task.body = task.imageBase64;
        break;
    }

    try {
      const response = await axios.post(
        `${this.ANTICAPTCHA_API}/createTask`,
        taskBody
      );

      return response.data;
    } catch (error: any) {
      return {
        errorDescription: error.message
      };
    }
  }

  private async antiCaptchaWaitForResult(taskId: number): Promise<CaptchaSolution> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.config.timeout) {
      await this.delay(this.config.pollingInterval);

      try {
        const response = await axios.post(
          `${this.ANTICAPTCHA_API}/getTaskResult`,
          {
            clientKey: this.config.apiKey,
            taskId
          }
        );

        const { status, solution, errorDescription, cost } = response.data;

        if (status === 'ready') {
          return {
            success: true,
            solution: solution?.gRecaptchaResponse || 
                      solution?.token || 
                      solution?.text,
            cost: parseFloat(cost)
          };
        }

        if (status === 'error') {
          return {
            success: false,
            error: errorDescription
          };
        }

        // status === 'processing' - continue waiting
        this.emit('captcha_processing', { taskId, elapsed: Date.now() - startTime });

      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }

    return {
      success: false,
      error: 'Captcha solving timeout'
    };
  }

  // ==========================================
  // 2CAPTCHA IMPLEMENTATION
  // ==========================================

  private async solveWith2Captcha(task: CaptchaTask): Promise<CaptchaSolution> {
    // Create task
    const createResponse = await this.twoCaptchaCreateTask(task);

    if (!createResponse.id) {
      return {
        success: false,
        error: createResponse.error || 'Failed to create task'
      };
    }

    // Wait for solution
    return this.twoCaptchaWaitForResult(createResponse.id);
  }

  private async twoCaptchaCreateTask(task: CaptchaTask): Promise<any> {
    const params: any = {
      key: this.config.apiKey,
      json: 1,
    };

    switch (task.type) {
      case 'recaptcha_v2':
        params.method = 'userrecaptcha';
        params.googlekey = task.websiteKey;
        params.pageurl = task.websiteURL;
        break;

      case 'recaptcha_v3':
        params.method = 'userrecaptcha';
        params.googlekey = task.websiteKey;
        params.pageurl = task.websiteURL;
        params.version = 'v3';
        params.min_score = task.minScore || 0.3;
        break;

      case 'funcaptcha':
        params.method = 'funcaptcha';
        params.publickey = task.publicKey;
        params.pageurl = task.websiteURL;
        break;

      case 'image':
        params.method = 'base64';
        params.body = task.imageBase64;
        break;
    }

    try {
      const response = await axios.get(
        `${this.TWOCAPTCHA_API}/in.php`,
        { params }
      );

      return response.data;
    } catch (error: any) {
      return { error: error.message };
    }
  }

  private async twoCaptchaWaitForResult(taskId: string): Promise<CaptchaSolution> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.config.timeout) {
      await this.delay(this.config.pollingInterval);

      try {
        const response = await axios.get(
          `${this.TWOCAPTCHA_API}/res.php`,
          {
            params: {
              key: this.config.apiKey,
              action: 'get',
              id: taskId,
              json: 1
            }
          }
        );

        const { status, request } = response.data;

        if (status === 1) {
          return {
            success: true,
            solution: request
          };
        }

        if (request === 'ERROR_CAPTCHA_UNSOLVABLE') {
          return {
            success: false,
            error: 'Captcha is unsolvable'
          };
        }

        // CAPCHA_NOT_READY - continue waiting
        this.emit('captcha_processing', { taskId, elapsed: Date.now() - startTime });

      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }

    return {
      success: false,
      error: 'Captcha solving timeout'
    };
  }

  // ==========================================
  // MANUAL CAPTCHA HANDLING
  // ==========================================

  private manualSolutionCallback: ((solution: string) => void) | null = null;

  /**
   * Wait for manual captcha solution (for Telegram bot integration)
   */
  private async waitForManualSolution(task: CaptchaTask): Promise<CaptchaSolution> {
    return new Promise((resolve) => {
      // Emit event for bot to notify user
      this.emit('manual_captcha_required', {
        type: task.type,
        websiteURL: task.websiteURL,
        imageBase64: task.imageBase64
      });

      // Set up timeout
      const timeout = setTimeout(() => {
        this.manualSolutionCallback = null;
        resolve({
          success: false,
          error: 'Manual captcha timeout - user did not respond'
        });
      }, this.config.timeout);

      // Wait for solution
      this.manualSolutionCallback = (solution: string) => {
        clearTimeout(timeout);
        this.manualSolutionCallback = null;
        resolve({
          success: true,
          solution
        });
      };
    });
  }

  /**
   * Submit manual captcha solution (called from Telegram bot)
   */
  submitManualSolution(solution: string): boolean {
    if (this.manualSolutionCallback) {
      this.manualSolutionCallback(solution);
      return true;
    }
    return false;
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check API balance
   */
  async getBalance(): Promise<number> {
    try {
      if (this.config.provider === 'anticaptcha') {
        const response = await axios.post(
          `${this.ANTICAPTCHA_API}/getBalance`,
          { clientKey: this.config.apiKey }
        );
        return response.data.balance || 0;

      } else if (this.config.provider === '2captcha') {
        const response = await axios.get(
          `${this.TWOCAPTCHA_API}/res.php`,
          {
            params: {
              key: this.config.apiKey,
              action: 'getbalance',
              json: 1
            }
          }
        );
        return parseFloat(response.data.request) || 0;
      }

      return 0;
    } catch (error) {
      logger.error('[Captcha] Failed to get balance:', error);
      return 0;
    }
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CaptchaConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): CaptchaConfig {
    return { ...this.config };
  }

  /**
   * Cancel all pending tasks
   */
  cancelAll(): void {
    for (const [taskId, timeout] of this.pendingTasks) {
      clearTimeout(timeout);
      this.pendingTasks.delete(taskId);
    }
    this.manualSolutionCallback = null;
  }
}

// ==========================================
// EA CAPTCHA HANDLER
// ==========================================

/**
 * Specialized handler for EA/FC captchas
 */
export class EACaptchaHandler {
  private solver: CaptchaSolverService;
  
  // EA's known captcha parameters
  private static readonly EA_FUNCAPTCHA_PUBLIC_KEY = 'A4EECF77-AC87-8C8D-5754-BF882F72063B';
  private static readonly EA_RECAPTCHA_SITE_KEY = '6LdZ_8kUAAAAAJ_Yd2V6Z2ukCKKZQ9F5_WjKXJ5N';

  constructor(solver?: CaptchaSolverService) {
    this.solver = solver || new CaptchaSolverService();
  }

  /**
   * Handle EA FunCaptcha
   */
  async handleFunCaptcha(): Promise<CaptchaSolution> {
    return this.solver.solve({
      type: 'funcaptcha',
      websiteURL: 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app',
      publicKey: EACaptchaHandler.EA_FUNCAPTCHA_PUBLIC_KEY
    });
  }

  /**
   * Handle EA reCAPTCHA
   */
  async handleReCaptcha(): Promise<CaptchaSolution> {
    return this.solver.solve({
      type: 'recaptcha_v2',
      websiteURL: 'https://signin.ea.com',
      websiteKey: EACaptchaHandler.EA_RECAPTCHA_SITE_KEY
    });
  }

  /**
   * Get solver service
   */
  getSolver(): CaptchaSolverService {
    return this.solver;
  }
}

// Export instances
export const captchaSolver = new CaptchaSolverService();
export const eaCaptchaHandler = new EACaptchaHandler(captchaSolver);
