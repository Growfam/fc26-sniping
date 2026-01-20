/**
 * FC26 EA Authentication Service
 * Full email/password authentication with 2FA support
 * NO _csrf needed - EA uses execution token from URL
 */

import axios, { AxiosInstance } from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

// ==========================================
// TYPES
// ==========================================

export interface EACredentials {
  email: string;
  password: string;
  platform: 'ps' | 'xbox' | 'pc';
}

export interface EASession {
  sid: string;
  platform: 'ps' | 'xbox' | 'pc';
  personaId?: string;
  nucleusId?: string;
  expiresAt?: Date;
}

export interface AuthCookies {
  sid: string;
  platform: string;
  createdAt: string;
}

export interface LoginResult {
  success: boolean;
  session?: EASession;
  cookies?: AuthCookies;
  error?: string;
  requires2FA?: boolean;
  twoFactorMethod?: string;
}

// ==========================================
// CONSTANTS
// ==========================================

const PLATFORM_ENDPOINTS: Record<string, string> = {
  ps: 'https://utas.mob.v1.fut.ea.com/ut/game/fc26',
  xbox: 'https://utas.mob.v2.fut.ea.com/ut/game/fc26',
  pc: 'https://utas.mob.v4.fut.ea.com/ut/game/fc26'
};

const EA_ENDPOINTS = {
  ACCOUNTS_AUTH: 'https://accounts.ea.com/connect/auth',
  LOGIN_PAGE: 'https://signin.ea.com/p/juno/login',
  TWO_FACTOR: 'https://signin.ea.com/p/juno/tfa',
  GATEWAY: 'https://gateway.ea.com/proxy/identity/pids/me'
};

const AUTH_PARAMS = {
  hide_create: 'true',
  display: 'web2/login',
  scope: 'basic.identity offline signin basic.entitlement basic.persona',
  release_type: 'prod',
  response_type: 'token',
  redirect_uri: 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/auth.html',
  locale: 'en_US',
  prompt: 'login',
  client_id: 'FC26_JS_WEB_APP'
};

// ==========================================
// EA AUTH CLASS
// ==========================================

export class EAAuth extends EventEmitter {
  private client: AxiosInstance;
  private cookieJar: CookieJar;
  private currentSession: EASession | null = null;
  private accessToken: string | null = null;

  constructor() {
    super();
    this.cookieJar = new CookieJar();
    this.client = wrapper(axios.create({
      jar: this.cookieJar,
      withCredentials: true,
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      }
    }));
  }

  // ==========================================
  // MAIN LOGIN METHOD
  // ==========================================

  async login(
    credentials: EACredentials,
    twoFactorProvider?: () => Promise<string | null>
  ): Promise<LoginResult> {
    try {
      logger.info(`[EAAuth] Starting login for ${credentials.email}`);

      // Step 1: Get login URL with execution token
      const loginUrlResult = await this.getLoginUrl();
      if (!loginUrlResult.success) {
        return loginUrlResult;
      }

      logger.info(`[EAAuth] Got login URL with execution token`);

      // Step 2: Submit credentials
      const submitResult = await this.submitCredentials(
        credentials.email,
        credentials.password,
        loginUrlResult.loginUrl!
      );

      if (!submitResult.success && !submitResult.requires2FA) {
        return submitResult;
      }

      // Step 3: Handle 2FA if required
      if (submitResult.requires2FA) {
        logger.info(`[EAAuth] 2FA required`);
        
        if (!twoFactorProvider) {
          return {
            success: false,
            requires2FA: true,
            twoFactorMethod: 'email',
            error: 'Потрібен 2FA код. Використайте /2fa <код>'
          };
        }

        const code = await twoFactorProvider();
        if (!code) {
          return { success: false, error: '2FA код не надано або timeout' };
        }

        const tfaResult = await this.submit2FA(code, submitResult.tfaUrl!);
        if (!tfaResult.success) {
          return tfaResult;
        }
      }

      // Step 4: Get access token
      const tokenResult = await this.getAccessToken();
      if (!tokenResult.success) {
        return tokenResult;
      }

      this.accessToken = tokenResult.accessToken!;
      logger.info(`[EAAuth] Got access token`);

      // Step 5: Get persona ID
      const identityResult = await this.getIdentity();
      if (!identityResult.success) {
        return identityResult;
      }

      logger.info(`[EAAuth] Got identity: persona=${identityResult.personaId}`);

      // Step 6: Authenticate to FUT
      const futResult = await this.authenticateToFUT(credentials.platform, identityResult.personaId!);
      if (!futResult.success) {
        return futResult;
      }

      // Build session
      this.currentSession = {
        sid: futResult.sid!,
        platform: credentials.platform,
        personaId: identityResult.personaId,
        nucleusId: identityResult.nucleusId,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
      };

      const cookies: AuthCookies = {
        sid: futResult.sid!,
        platform: credentials.platform,
        createdAt: new Date().toISOString()
      };

      logger.info(`[EAAuth] ✅ Login successful!`);

      return {
        success: true,
        session: this.currentSession,
        cookies
      };

    } catch (error: any) {
      logger.error(`[EAAuth] Login error:`, error.message);
      return {
        success: false,
        error: `Помилка авторизації: ${error.message}`
      };
    }
  }

  // ==========================================
  // STEP 1: GET LOGIN URL WITH EXECUTION TOKEN
  // ==========================================

  private async getLoginUrl(): Promise<{ success: boolean; loginUrl?: string; error?: string }> {
    try {
      logger.info('[EAAuth] Step 1: Getting login URL...');
      
      // Simple approach: follow ALL redirects, get final URL
      const response = await this.client.get(EA_ENDPOINTS.ACCOUNTS_AUTH, {
        params: AUTH_PARAMS,
        maxRedirects: 10
      });

      // Get final URL after all redirects
      const loginUrl = response.request?.res?.responseUrl ||
                       response.request?.responseURL ||
                       response.config?.url;

      logger.info(`[EAAuth] Final URL: ${loginUrl}`);

      if (!loginUrl) {
        return { success: false, error: 'Не вдалося отримати URL' };
      }

      // Check if we landed on signin page
      if (loginUrl.includes('signin.ea.com')) {
        logger.info('[EAAuth] ✅ Got signin page');
        return { success: true, loginUrl };
      }

      // If we got access_token directly (already logged in via cookies)
      if (loginUrl.includes('access_token=')) {
        logger.info('[EAAuth] Already have access token from cookies!');
        return { success: true, loginUrl };
      }

      // Unexpected URL
      logger.warn(`[EAAuth] Unexpected URL: ${loginUrl}`);
      return { success: true, loginUrl }; // Try anyway

    } catch (error: any) {
      logger.error('[EAAuth] Failed to get login URL:', error.message);
      return { success: false, error: `Помилка: ${error.message}` };
    }
  }

  // ==========================================
  // STEP 2: SUBMIT CREDENTIALS (2-step: email first, then password)
  // ==========================================

  private async submitCredentials(
    email: string,
    password: string,
    loginUrl: string
  ): Promise<{ success: boolean; requires2FA?: boolean; tfaUrl?: string; error?: string }> {
    try {
      logger.info(`[EAAuth] Step 2a: Submitting EMAIL...`);

      // STEP 2a: Submit EMAIL first
      const emailResponse = await this.client.post(loginUrl, new URLSearchParams({
        email,
        _eventId: 'submit',
        cid: '',
        showAgeUp: 'true',
        googleCaptchaResponse: ''
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://signin.ea.com',
          'Referer': loginUrl
        },
        maxRedirects: 5
      });

      const emailHtml = typeof emailResponse.data === 'string' ? emailResponse.data : '';
      const passwordPageUrl = emailResponse.request?.res?.responseUrl || loginUrl;

      logger.info(`[EAAuth] After email, URL: ${passwordPageUrl.substring(0, 80)}`);

      // Check if still needs password (should have password field now)
      if (!emailHtml.includes('password') && !passwordPageUrl.includes('s2')) {
        logger.warn('[EAAuth] No password field found after email submit');
      }

      // Check for errors
      if (emailHtml.includes('not find') || emailHtml.includes('does not exist')) {
        return { success: false, error: 'Email не знайдено в системі EA' };
      }

      logger.info(`[EAAuth] Step 2b: Submitting PASSWORD...`);

      // STEP 2b: Submit PASSWORD
      const passResponse = await this.client.post(passwordPageUrl, new URLSearchParams({
        email,
        password,
        _eventId: 'submit',
        cid: '',
        showAgeUp: 'true',
        googleCaptchaResponse: '',
        _rememberMe: 'on',
        rememberMe: 'on'
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://signin.ea.com',
          'Referer': passwordPageUrl
        },
        maxRedirects: 5
      });

      const html = typeof passResponse.data === 'string' ? passResponse.data : '';
      const location = passResponse.headers?.location || '';
      const finalUrl = passResponse.request?.res?.responseUrl || '';

      logger.info(`[EAAuth] After password, status: ${passResponse.status}, URL: ${finalUrl.substring(0, 80)}`);

      // Check execution step (s1=email, s2=password, s3+=2FA or success)
      const execMatch = finalUrl.match(/execution=e\d+s(\d+)/);
      const execStep = execMatch ? parseInt(execMatch[1]) : 0;
      logger.info(`[EAAuth] Execution step: ${execStep}`);

      // Success - got access token
      if (finalUrl.includes('access_token=') || location.includes('access_token=')) {
        logger.info('[EAAuth] ✅ Got access token!');
        return { success: true };
      }

      // If we reached step 3+, password was accepted! This is 2FA page
      if (execStep >= 3) {
        logger.info('[EAAuth] ✅ Password accepted! Now on 2FA page (step 3+)');
        return { success: true, requires2FA: true, tfaUrl: finalUrl };
      }

      // Explicit 2FA detection
      if (finalUrl.includes('/tfa') || location.includes('/tfa') ||
          html.includes('twoFactorCode') || html.includes('security code') ||
          html.includes('Verify your identity') || html.includes('Enter the code') ||
          html.includes('One-Time Code') || html.includes('code we sent')) {
        logger.info('[EAAuth] 2FA required (explicit)');
        return { success: true, requires2FA: true, tfaUrl: finalUrl };
      }

      // Error messages - only if still on step 2
      if (execStep <= 2) {
        if (html.includes('Your credentials are incorrect') ||
            html.includes('credentials') && html.includes('incorrect') ||
            html.includes('wrong password')) {
          return { success: false, error: 'Невірний пароль' };
        }

        if (html.includes('locked') || html.includes('suspended') || html.includes('banned')) {
          return { success: false, error: 'Акаунт заблоковано' };
        }
      }

      // If still on signin page but step didn't change - something wrong
      if (finalUrl.includes('signin.ea.com') && execStep <= 2) {
        logger.warn('[EAAuth] Still on login page, step did not advance');
        return { success: false, error: 'Не вдалося увійти. Перевірте дані.' };
      }

      logger.info('[EAAuth] Credentials submitted successfully');
      return { success: true };

    } catch (error: any) {
      logger.error('[EAAuth] Submit error:', error.message);
      return { success: false, error: `Помилка входу: ${error.message}` };
    }
  }

  // ==========================================
  // STEP 3: SUBMIT 2FA CODE
  // ==========================================

  private async submit2FA(code: string, tfaUrl: string): Promise<{ success: boolean; error?: string }> {
    try {
      logger.info('[EAAuth] Step 3: Submitting 2FA code...');

      const response = await this.client.post(tfaUrl, new URLSearchParams({
        twoFactorCode: code,
        _eventId: 'submit',
        _trustThisDevice: 'on'
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://signin.ea.com',
          'Referer': tfaUrl
        },
        maxRedirects: 5
      });

      const finalUrl = response.request?.res?.responseUrl || '';
      const location = response.headers?.location || '';
      const html = typeof response.data === 'string' ? response.data : '';

      if (finalUrl.includes('access_token=') || location.includes('access_token=')) {
        logger.info('[EAAuth] 2FA success');
        return { success: true };
      }

      if (html.includes('incorrect') || html.includes('invalid') || html.includes('wrong')) {
        return { success: false, error: 'Невірний 2FA код' };
      }

      return { success: true };

    } catch (error: any) {
      return { success: false, error: `Помилка 2FA: ${error.message}` };
    }
  }

  // ==========================================
  // STEP 4: GET ACCESS TOKEN
  // ==========================================

  private async getAccessToken(): Promise<{ success: boolean; accessToken?: string; error?: string }> {
    try {
      logger.info('[EAAuth] Step 4: Getting access token...');

      const response = await this.client.get(EA_ENDPOINTS.ACCOUNTS_AUTH, {
        params: AUTH_PARAMS,
        maxRedirects: 10
      });

      const finalUrl = response.request?.res?.responseUrl || '';
      logger.info(`[EAAuth] Final URL: ${finalUrl.substring(0, 100)}`);

      // Extract token from URL fragment
      const tokenMatch = finalUrl.match(/access_token=([^&]+)/);
      if (tokenMatch) {
        return { success: true, accessToken: tokenMatch[1] };
      }

      if (response.data?.access_token) {
        return { success: true, accessToken: response.data.access_token };
      }

      // Check if redirected back to login
      if (finalUrl.includes('signin.ea.com') || finalUrl.includes('login')) {
        return { success: false, error: 'Сесія не збережена. Перевірте логін/пароль.' };
      }

      return { success: false, error: 'Не вдалося отримати access token' };

    } catch (error: any) {
      const location = error.response?.headers?.location || '';
      const tokenMatch = location.match(/access_token=([^&]+)/);
      if (tokenMatch) {
        return { success: true, accessToken: tokenMatch[1] };
      }
      return { success: false, error: `Помилка токена: ${error.message}` };
    }
  }

  // ==========================================
  // STEP 5: GET IDENTITY
  // ==========================================

  private async getIdentity(): Promise<{ success: boolean; personaId?: string; nucleusId?: string; error?: string }> {
    try {
      logger.info('[EAAuth] Step 5: Getting identity...');

      const response = await this.client.get(EA_ENDPOINTS.GATEWAY, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json'
        }
      });

      const pid = response.data?.pid;
      if (pid) {
        return {
          success: true,
          personaId: pid.personaId?.toString() || pid.pidId?.toString(),
          nucleusId: pid.nucleusId?.toString() || pid.externalRefValue
        };
      }

      return { success: false, error: 'Не вдалося отримати persona ID' };

    } catch (error: any) {
      return { success: false, error: `Помилка identity: ${error.message}` };
    }
  }

  // ==========================================
  // STEP 6: AUTHENTICATE TO FUT
  // ==========================================

  private async authenticateToFUT(
    platform: 'ps' | 'xbox' | 'pc',
    personaId: string
  ): Promise<{ success: boolean; sid?: string; error?: string }> {
    try {
      logger.info(`[EAAuth] Step 6: Authenticating to FUT (${platform})...`);

      const baseUrl = PLATFORM_ENDPOINTS[platform];

      const authResponse = await this.client.post(`${baseUrl}/auth`, {
        isReadOnly: false,
        sku: 'FUT26WEB',
        clientVersion: 1,
        locale: 'en-US',
        method: 'authcode',
        priorityLevel: 4,
        identification: {
          authCode: '',
          redirectUrl: 'nucleus:rest'
        }
      }, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-UT-Embed-Error': 'true',
          'Easw-Session-Data-Nucleus-Id': personaId
        }
      });

      if (authResponse.data?.sid) {
        logger.info('[EAAuth] Got SID from FUT');
        return { success: true, sid: authResponse.data.sid };
      }

      return { success: false, error: 'Не вдалося отримати SID' };

    } catch (error: any) {
      const status = error.response?.status;

      if (status === 401) {
        return { success: false, error: 'Токен недійсний' };
      }
      if (status === 426) {
        return { success: false, error: '⚠️ Потрібна капча. Відкрийте Web App у браузері і пройдіть капчу.' };
      }
      if (status === 458) {
        return { success: false, error: '🔒 Ринок заблоковано. Зіграйте 10+ матчів.' };
      }
      if (status === 461) {
        return { success: false, error: 'Немає доступу до FUT' };
      }

      return { success: false, error: `Помилка FUT: ${error.message}` };
    }
  }

  // ==========================================
  // SESSION METHODS
  // ==========================================

  async verifySession(sid: string, platform: 'ps' | 'xbox' | 'pc'): Promise<boolean> {
    try {
      const baseUrl = PLATFORM_ENDPOINTS[platform];
      const response = await this.client.get(`${baseUrl}/user/accountinfo`, {
        headers: { 'X-UT-SID': sid },
        validateStatus: () => true
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async getCredits(sid: string, platform: 'ps' | 'xbox' | 'pc'): Promise<number> {
    try {
      const baseUrl = PLATFORM_ENDPOINTS[platform];
      const response = await this.client.get(`${baseUrl}/user/credits`, {
        headers: { 'X-UT-SID': sid }
      });
      return response.data?.credits || 0;
    } catch {
      return 0;
    }
  }

  getCurrentSession(): EASession | null {
    return this.currentSession;
  }

  clearSession(): void {
    this.currentSession = null;
    this.accessToken = null;
    this.cookieJar = new CookieJar();
  }
}

// ==========================================
// EA AUTH MANAGER
// ==========================================

class EAAuthManager {
  private authInstances: Map<string, EAAuth> = new Map();
  private pending2FA: Map<string, {
    auth: EAAuth;
    credentials: EACredentials;
    resolve: (code: string) => void;
  }> = new Map();

  getAuth(accountId: string): EAAuth {
    if (!this.authInstances.has(accountId)) {
      this.authInstances.set(accountId, new EAAuth());
    }
    return this.authInstances.get(accountId)!;
  }

  async loginWithCredentials(
    tempId: string,
    credentials: EACredentials
  ): Promise<LoginResult> {
    const auth = new EAAuth();
    this.authInstances.set(tempId, auth);

    return new Promise((resolve) => {
      const twoFactorProvider = (): Promise<string | null> => {
        return new Promise((tfaResolve) => {
          this.pending2FA.set(tempId, {
            auth,
            credentials,
            resolve: tfaResolve
          });

          auth.emit('2fa_required', { tempId, method: 'email' });

          // Timeout after 5 minutes
          setTimeout(() => {
            if (this.pending2FA.has(tempId)) {
              this.pending2FA.delete(tempId);
              tfaResolve(null);
            }
          }, 5 * 60 * 1000);
        });
      };

      auth.login(credentials, twoFactorProvider).then(resolve);
    });
  }

  submit2FACode(tempId: string, code: string): boolean {
    const pending = this.pending2FA.get(tempId);
    if (pending) {
      pending.resolve(code);
      this.pending2FA.delete(tempId);
      return true;
    }
    return false;
  }

  hasPending2FA(tempId: string): boolean {
    return this.pending2FA.has(tempId);
  }

  async verifySession(
    accountId: string,
    sid: string,
    platform: 'ps' | 'xbox' | 'pc'
  ): Promise<boolean> {
    const auth = this.getAuth(accountId);
    return auth.verifySession(sid, platform);
  }

  clearSession(accountId: string): void {
    const auth = this.authInstances.get(accountId);
    if (auth) {
      auth.clearSession();
    }
    this.authInstances.delete(accountId);
    this.pending2FA.delete(accountId);
  }
}

export const eaAuthManager = new EAAuthManager();