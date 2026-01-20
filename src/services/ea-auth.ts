/**
 * FC26 EA Authentication Service
 * Full email/password authentication with 2FA support
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
  // Step 1: Start auth flow here - will redirect to login page with execution token
  ACCOUNTS_AUTH: 'https://accounts.ea.com/connect/auth',
  // Step 2: Login page (need execution token from redirect)
  LOGIN_PAGE: 'https://signin.ea.com/p/juno/login',
  // Step 3: 2FA page
  TWO_FACTOR: 'https://signin.ea.com/p/juno/tfa',
  // Step 4: Get identity
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

      // Step 1: Get login page and extract form data
      const loginPageResult = await this.getLoginPage();
      if (!loginPageResult.success) {
        return loginPageResult;
      }

      // Step 2: Submit credentials
      const submitResult = await this.submitCredentials(
        credentials.email,
        credentials.password,
        loginPageResult.formData!
      );

      if (!submitResult.success) {
        return submitResult;
      }

      // Step 3: Handle 2FA if required
      if (submitResult.requires2FA) {
        logger.info(`[EAAuth] 2FA required, method: ${submitResult.twoFactorMethod}`);
        
        if (!twoFactorProvider) {
          return {
            success: false,
            requires2FA: true,
            twoFactorMethod: submitResult.twoFactorMethod,
            error: 'Потрібен 2FA код. Використайте /2fa <код>'
          };
        }

        const code = await twoFactorProvider();
        if (!code) {
          return { success: false, error: '2FA код не надано або timeout' };
        }

        const tfaResult = await this.submit2FA(code, submitResult.formData!);
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

      // Step 5: Get persona ID
      const identityResult = await this.getIdentity();
      if (!identityResult.success) {
        return identityResult;
      }

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

      logger.info(`[EAAuth] Login successful for ${credentials.email}`);

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
  // STEP 1: GET LOGIN PAGE (with execution token)
  // ==========================================

  private async getLoginPage(): Promise<{ success: boolean; formData?: any; error?: string }> {
    try {
      logger.info('[EAAuth] Step 1: Getting execution token from accounts.ea.com...');
      
      // First request to accounts.ea.com - it will redirect to signin.ea.com with execution token
      const authResponse = await this.client.get(EA_ENDPOINTS.ACCOUNTS_AUTH, {
        params: AUTH_PARAMS,
        maxRedirects: 0, // Don't follow redirects automatically
        validateStatus: (status) => status < 400 || status === 302 || status === 303
      });

      let loginUrl: string | null = null;

      // Check for redirect
      if (authResponse.status === 302 || authResponse.status === 303) {
        loginUrl = authResponse.headers.location;
        logger.info(`[EAAuth] Got redirect to: ${loginUrl?.substring(0, 100)}...`);
      }

      if (!loginUrl) {
        // Try to find redirect in response
        const html = authResponse.data as string;
        const redirectMatch = html.match(/location\.href\s*=\s*["']([^"']+)["']/i) ||
                              html.match(/window\.location\s*=\s*["']([^"']+)["']/i);
        if (redirectMatch) {
          loginUrl = redirectMatch[1];
        }
      }

      if (!loginUrl) {
        logger.error('[EAAuth] No redirect URL found');
        return { success: false, error: 'EA не повернув URL логіну' };
      }

      // Now fetch the actual login page
      logger.info('[EAAuth] Step 2: Fetching login page...');
      
      const loginResponse = await this.client.get(loginUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        maxRedirects: 5
      });

      const html = loginResponse.data as string;
      
      // Log HTML snippet for debugging
      logger.info(`[EAAuth] Login page size: ${html.length} bytes`);
      
      // Extract execution token from URL or form
      let execution: string | null = null;
      
      // From URL
      const execUrlMatch = loginUrl.match(/execution=([^&]+)/);
      if (execUrlMatch) {
        execution = execUrlMatch[1];
        logger.info(`[EAAuth] Got execution from URL: ${execution.substring(0, 20)}...`);
      }
      
      // From form
      if (!execution) {
        const execFormMatch = html.match(/name=["']execution["'][^>]*value=["']([^"']+)["']/i) ||
                              html.match(/value=["']([^"']+)["'][^>]*name=["']execution["']/i);
        if (execFormMatch) {
          execution = execFormMatch[1];
          logger.info(`[EAAuth] Got execution from form: ${execution.substring(0, 20)}...`);
        }
      }
      
      // Try multiple CSRF patterns
      let csrf: string | null = null;
      
      const csrfPatterns = [
        /name=["']_csrf["'][^>]*value=["']([^"']+)["']/i,
        /value=["']([^"']+)["'][^>]*name=["']_csrf["']/i,
        /<input[^>]*name=["']_csrf["'][^>]*value=["']([^"']+)["']/i,
        /_csrf["'][^>]*value=["']([^"']+)["']/i,
        /name="_csrf"\s+value="([^"]+)"/,
        /csrf.*?value=["']([^"']+)["']/i
      ];
      
      for (const pattern of csrfPatterns) {
        const match = html.match(pattern);
        if (match) {
          csrf = match[1];
          logger.info(`[EAAuth] Got CSRF token: ${csrf.substring(0, 20)}...`);
          break;
        }
      }

      if (!csrf) {
        // Log part of HTML for debugging
        const formSection = html.match(/<form[\s\S]*?<\/form>/i);
        logger.error('[EAAuth] CSRF not found. Form HTML:', formSection ? formSection[0].substring(0, 500) : 'No form found');
        logger.error('[EAAuth] Full HTML snippet:', html.substring(0, 1000));
        return { success: false, error: 'Не вдалося отримати CSRF token' };
      }

      if (!execution) {
        logger.error('[EAAuth] Execution token not found');
        return { success: false, error: 'Не вдалося отримати execution token' };
      }

      logger.info('[EAAuth] Successfully got login page with CSRF and execution tokens');

      return {
        success: true,
        formData: {
          _csrf: csrf,
          execution: execution,
          loginUrl: loginUrl
        }
      };
    } catch (error: any) {
      logger.error('[EAAuth] Failed to get login page:', error.message);
      if (error.response) {
        logger.error('[EAAuth] Response status:', error.response.status);
        logger.error('[EAAuth] Response headers:', JSON.stringify(error.response.headers));
      }
      return { success: false, error: `Помилка завантаження: ${error.message}` };
    }
  }

  // ==========================================
  // STEP 2: SUBMIT CREDENTIALS
  // ==========================================

  private async submitCredentials(
    email: string,
    password: string,
    formData: any
  ): Promise<{ success: boolean; requires2FA?: boolean; twoFactorMethod?: string; formData?: any; error?: string }> {
    try {
      // Use the login URL from formData, or construct one
      const submitUrl = formData.loginUrl || EA_ENDPOINTS.LOGIN_PAGE;
      
      logger.info(`[EAAuth] Submitting credentials to: ${submitUrl.substring(0, 60)}...`);
      
      const response = await this.client.post(submitUrl, new URLSearchParams({
        email,
        password,
        _csrf: formData._csrf,
        execution: formData.execution || '',
        _eventId: 'submit'
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://signin.ea.com',
          'Referer': submitUrl
        },
        maxRedirects: 0,
        validateStatus: (status) => status < 500
      });

      const responseUrl = response.request?.res?.responseUrl || response.headers?.location || '';
      const html = typeof response.data === 'string' ? response.data : '';

      // Check for successful redirect
      if (responseUrl.includes('access_token=')) {
        return { success: true };
      }

      // Check for 2FA page
      if (html.includes('tfa') || html.includes('two-factor') || html.includes('security-code') || 
          html.includes('Введіть код') || html.includes('Enter code') || responseUrl.includes('tfa')) {
        const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
        
        return {
          success: true,
          requires2FA: true,
          twoFactorMethod: 'email',
          formData: {
            _csrf: csrfMatch ? csrfMatch[1] : formData._csrf
          }
        };
      }

      // Check for invalid credentials
      if (html.includes('incorrect') || html.includes('invalid') || html.includes('wrong') || 
          html.includes('Невірний') || html.includes('помилка')) {
        return { success: false, error: 'Невірний email або пароль' };
      }

      // Check for account issues
      if (html.includes('locked') || html.includes('suspended') || html.includes('заблоков')) {
        return { success: false, error: 'Акаунт заблоковано' };
      }

      // Follow redirect if needed
      if (response.status === 302 || response.status === 303) {
        const location = response.headers.location;
        if (location) {
          if (location.includes('tfa')) {
            return {
              success: true,
              requires2FA: true,
              twoFactorMethod: 'email',
              formData
            };
          }
          const followResponse = await this.client.get(location);
          if (followResponse.request?.res?.responseUrl?.includes('access_token=')) {
            return { success: true };
          }
        }
      }

      return { success: true };

    } catch (error: any) {
      if (error.response?.status === 302) {
        const location = error.response.headers?.location || '';
        if (location.includes('access_token=')) {
          return { success: true };
        }
        if (location.includes('tfa')) {
          return {
            success: true,
            requires2FA: true,
            twoFactorMethod: 'email',
            formData
          };
        }
      }
      return { success: false, error: `Помилка входу: ${error.message}` };
    }
  }

  // ==========================================
  // STEP 3: SUBMIT 2FA
  // ==========================================

  private async submit2FA(
    code: string,
    formData: any
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.client.post(EA_ENDPOINTS.TWO_FACTOR, new URLSearchParams({
        oneTimeCode: code,
        _csrf: formData._csrf,
        _trustThisDevice: 'on',
        _eventId: 'submit'
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        maxRedirects: 5,
        validateStatus: (status) => status < 500
      });

      const html = typeof response.data === 'string' ? response.data : '';
      const responseUrl = response.request?.res?.responseUrl || '';

      if (responseUrl.includes('access_token=') || response.status === 200) {
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
      logger.info('[EAAuth] Getting access token...');
      
      const response = await this.client.get(EA_ENDPOINTS.ACCOUNTS_AUTH, {
        params: AUTH_PARAMS,
        maxRedirects: 10
      });

      const finalUrl = response.request?.res?.responseUrl || '';
      logger.info(`[EAAuth] Final URL: ${finalUrl.substring(0, 100)}...`);
      
      const tokenMatch = finalUrl.match(/access_token=([^&]+)/);
      
      if (tokenMatch) {
        logger.info('[EAAuth] Access token obtained from URL');
        return { success: true, accessToken: tokenMatch[1] };
      }

      if (response.data?.access_token) {
        logger.info('[EAAuth] Access token obtained from response');
        return { success: true, accessToken: response.data.access_token };
      }

      // Check if we need to login again
      const html = typeof response.data === 'string' ? response.data : '';
      if (html.includes('login') || html.includes('signin')) {
        logger.warn('[EAAuth] Redirected to login page - session not established');
        return { success: false, error: 'Сесія не збережена. Спробуйте ще раз.' };
      }

      logger.warn('[EAAuth] No access token found in response');
      return { success: false, error: 'Не вдалося отримати access token. Можливо потрібна капча - відкрийте https://www.ea.com/ea-sports-fc/ultimate-team/web-app/' };

    } catch (error: any) {
      const location = error.response?.headers?.location || '';
      logger.info(`[EAAuth] Error response, checking location: ${location.substring(0, 100)}`);
      
      const tokenMatch = location.match(/access_token=([^&]+)/);
      if (tokenMatch) {
        logger.info('[EAAuth] Access token obtained from error redirect');
        return { success: true, accessToken: tokenMatch[1] };
      }
      
      logger.error(`[EAAuth] getAccessToken error: ${error.message}`);
      return { success: false, error: `Помилка токена: ${error.message}` };
    }
  }

  // ==========================================
  // STEP 5: GET IDENTITY
  // ==========================================

  private async getIdentity(): Promise<{ success: boolean; personaId?: string; nucleusId?: string; error?: string }> {
    try {
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
      const baseUrl = PLATFORM_ENDPOINTS[platform];
      
      // Authenticate
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
        return { success: true, sid: authResponse.data.sid };
      }

      return { success: false, error: 'Не вдалося отримати SID від EA' };

    } catch (error: any) {
      const status = error.response?.status;
      const data = error.response?.data;
      
      if (status === 401) {
        return { success: false, error: 'Сесія недійсна. Спробуйте ще раз.' };
      }
      if (status === 426) {
        return { success: false, error: '⚠️ Потрібна капча. Відкрийте https://www.ea.com/ea-sports-fc/ultimate-team/web-app/ в браузері, пройдіть капчу, потім спробуйте знову.' };
      }
      if (status === 458) {
        return { success: false, error: '🔒 Ринок заблоковано. Зіграйте 10+ матчів в FC26.' };
      }
      if (status === 461) {
        return { success: false, error: 'Немає доступу до FUT. Перевірте чи є FC26 на цьому акаунті.' };
      }
      if (status === 500 || status === 503) {
        return { success: false, error: 'Сервери EA недоступні. Спробуйте пізніше.' };
      }

      logger.error(`[EAAuth] FUT auth error:`, { status, data, message: error.message });
      return { success: false, error: `Помилка FUT: ${data?.message || error.message}` };
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
// EA AUTH MANAGER (Singleton)
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

          // Emit event for bot to ask user for 2FA
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
