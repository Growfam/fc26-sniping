/**
 * EA Authentication using Puppeteer
 * Real browser automation - handles 2FA properly
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { logger } from '../utils/logger';

const WEB_APP_URL = 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/';

interface PuppeteerAuthResult {
  success: boolean;
  requires2FA?: boolean;
  error?: string;
  session?: {
    sid: string;
    accessToken?: string;
  };
}

interface PendingAuth {
  browser: Browser;
  page: Page;
  email: string;
  platform: string;
}

class EAPuppeteerAuth {
  private pendingAuths: Map<string, PendingAuth> = new Map();

  async startLogin(tempId: string, email: string, password: string, platform: string): Promise<PuppeteerAuthResult> {
    let browser: Browser | null = null;
    
    try {
      logger.info(`[PuppeteerAuth] Starting login for ${email}`);
      
      browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
          '--no-zygote'
        ]
      });

      const page = await browser.newPage();
      
      // Set larger viewport - EA requires minimum size
      await page.setViewport({ width: 1920, height: 1080 });

      // Navigate to Web App
      logger.info('[PuppeteerAuth] Navigating to Web App...');
      await page.goto(WEB_APP_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      // Wait for and click Login button
      logger.info('[PuppeteerAuth] Looking for Login button...');
      await page.waitForSelector('button.btn-standard', { timeout: 15000 });
      await page.click('button.btn-standard');

      // Wait for login page
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

      // Enter email
      logger.info('[PuppeteerAuth] Entering email...');
      await page.waitForSelector('input[name="email"]', { timeout: 10000 });
      await page.type('input[name="email"]', email, { delay: 50 });

      // Click Next
      await page.click('button[type="submit"], a#logInBtn');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

      // Wait a bit for page to load
      await this.sleep(1000);

      // Enter password
      logger.info('[PuppeteerAuth] Entering password...');
      const passwordInput = await page.$('input[type="password"]');
      if (passwordInput) {
        await passwordInput.type(password, { delay: 50 });

        // Click Sign In
        const signInBtn = await page.$('button[type="submit"], a#logInBtn');
        if (signInBtn) {
          await signInBtn.click();
        }
      }

      // Wait for result
      await this.sleep(3000);

      // Check current URL
      const currentUrl = page.url();
      logger.info(`[PuppeteerAuth] Current URL: ${currentUrl.substring(0, 60)}...`);

      // Check for 2FA page
      const pageContent = await page.content();
      const is2FAPage = pageContent.includes('Verify your identity') ||
                        pageContent.includes('SEND CODE') ||
                        pageContent.includes('Send Code') ||
                        currentUrl.includes('s3');

      if (is2FAPage) {
        logger.info('[PuppeteerAuth] 2FA required, clicking Send Code...');

        // Click Send Code button
        const sendCodeBtn = await page.$('button.btn-primary, button.otkbtn');
        if (sendCodeBtn) {
          await sendCodeBtn.click();
          await this.sleep(2000);

          logger.info('[PuppeteerAuth] Send Code clicked, waiting for user to enter code...');

          // Save browser and page for later
          this.pendingAuths.set(tempId, { browser, page, email, platform });

          return {
            success: true,
            requires2FA: true
          };
        }
      }

      // Check for error
      if (pageContent.includes('credentials are incorrect') || pageContent.includes('wrong password')) {
        await browser.close();
        return { success: false, error: 'Невірний email або пароль' };
      }

      // Check for success (access token in URL)
      if (currentUrl.includes('access_token=')) {
        const accessToken = this.extractAccessToken(currentUrl);
        logger.info('[PuppeteerAuth] Login successful!');
        await browser.close();
        return {
          success: true,
          session: { sid: '', accessToken }
        };
      }

      // Unknown state
      await browser.close();
      return { success: false, error: 'Невідома помилка авторизації' };

    } catch (error: any) {
      logger.error('[PuppeteerAuth] Error:', error.message);
      if (browser) await browser.close();
      return { success: false, error: error.message };
    }
  }

  async continue2FA(tempId: string, code: string): Promise<PuppeteerAuthResult> {
    const pending = this.pendingAuths.get(tempId);

    if (!pending) {
      return { success: false, error: 'Сесія авторизації не знайдена' };
    }

    const { browser, page } = pending;

    try {
      logger.info('[PuppeteerAuth] Entering 2FA code...');

      // Find code input
      const codeInput = await page.$('input[name="twoFactorCode"], input[name="oneTimeCode"], input[name="verification"], input[type="text"]');
      if (!codeInput) {
        throw new Error('Поле для коду не знайдено');
      }

      // Clear and enter code
      await codeInput.click({ clickCount: 3 });
      await codeInput.type(code, { delay: 50 });

      // Click submit
      const submitBtn = await page.$('button[type="submit"], a#btnSubmit, button.btn-primary');
      if (submitBtn) {
        await submitBtn.click();
      }

      // Wait for navigation
      await this.sleep(5000);

      const currentUrl = page.url();
      logger.info(`[PuppeteerAuth] After 2FA URL: ${currentUrl.substring(0, 60)}...`);

      // Check for success
      if (currentUrl.includes('access_token=')) {
        const accessToken = this.extractAccessToken(currentUrl);
        logger.info('[PuppeteerAuth] 2FA successful!');

        // Get SID from FUT API
        const sid = await this.getSidFromPage(page, pending.platform);

        await browser.close();
        this.pendingAuths.delete(tempId);

        return {
          success: true,
          session: { sid, accessToken }
        };
      }

      // Check for error
      const pageContent = await page.content();
      if (pageContent.includes('incorrect') || pageContent.includes('invalid') || pageContent.includes('expired')) {
        return { success: false, error: 'Невірний або застарілий код' };
      }

      // Maybe we need to wait for Web App to load
      if (currentUrl.includes('web-app')) {
        logger.info('[PuppeteerAuth] On Web App, getting SID...');
        const sid = await this.getSidFromPage(page, pending.platform);

        await browser.close();
        this.pendingAuths.delete(tempId);

        return {
          success: true,
          session: { sid }
        };
      }

      return { success: false, error: 'Помилка перевірки коду' };

    } catch (error: any) {
      logger.error('[PuppeteerAuth] 2FA error:', error.message);
      await browser.close();
      this.pendingAuths.delete(tempId);
      return { success: false, error: error.message };
    }
  }

  private async getSidFromPage(page: Page, platform: string): Promise<string> {
    try {
      // Wait for FUT to load
      await this.sleep(5000);

      // Listen for network requests to get SID
      const sid: string = await page.evaluate(`
        (function() {
          const keys = ['FUTWebSID', 'sid', 'ut-sid'];
          for (const key of keys) {
            const val = localStorage.getItem(key) || sessionStorage.getItem(key);
            if (val) return val;
          }
          return '';
        })()
      `) as string;

      if (sid) {
        logger.info('[PuppeteerAuth] Got SID from storage');
        return sid;
      }

      // Alternative: intercept network requests
      logger.warn('[PuppeteerAuth] Could not get SID from storage');
      return '';

    } catch (error) {
      logger.error('[PuppeteerAuth] Error getting SID:', error);
      return '';
    }
  }

  private extractAccessToken(url: string): string {
    const match = url.match(/access_token=([^&]+)/);
    return match ? match[1] : '';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Cleanup
  async cleanup(tempId: string): Promise<void> {
    const pending = this.pendingAuths.get(tempId);
    if (pending) {
      await pending.browser.close();
      this.pendingAuths.delete(tempId);
    }
  }
}

export const eaPuppeteerAuth = new EAPuppeteerAuth();