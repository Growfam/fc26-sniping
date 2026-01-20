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
  LOGIN_PAGE: 'https://signin.ea.com/p/juno/login',
  LOGIN_SUBMIT: 'https://signin.ea.com/p/juno/login',
  TWO_FACTOR: 'https://signin.ea.com/p/juno/tfa',
  ACCOUNTS_AUTH: 'https://accounts.ea.com/connect/auth',
  GATEWAY: 'https://gateway.ea.com/proxy/identity/pids/me'
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
  // STEP 1: GET LOGIN PAGE
  // ==========================================

  private async getLoginPage(): Promise<{ success: boolean; formData?: any; error?: string }> {
    try {
      const response = await this.client.get(EA_ENDPOINTS.LOGIN_PAGE, {
        params: {
          client_id: 'FC26_JS_WEB_APP',
          redirect_uri: 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/auth.html',
          response_type: 'token',
          locale: 'en_US'
        }
      });

      const html = response.data;
      const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
      const executionMatch = html.match(/name="execution"\s+value="([^"]+)"/);

      if (!csrfMatch) {
        return { success: false, error: 'Не вдалося отримати CSRF token' };
      }

      return {
        success: true,
        formData: {
          _csrf: csrfMatch[1],
          execution: executionMatch ? executionMatch[1] : undefined
        }
      };
    } catch (error: any) {
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
      const response = await this.client.post(EA_ENDPOINTS.LOGIN_SUBMIT, new URLSearchParams({
        email,
        password,
        _csrf: formData._csrf,
        execution: formData.execution || '',
        _eventId: 'submit'
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
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
      const response = await this.client.get(EA_ENDPOINTS.ACCOUNTS_AUTH, {
        params: {
          client_id: 'FC26_JS_WEB_APP',
          redirect_uri: 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/auth.html',
          response_type: 'token',
          locale: 'en_US'
        },
        maxRedirects: 10
      });

      const finalUrl = response.request?.res?.responseUrl || '';
      const tokenMatch = finalUrl.match(/access_token=([^&]+)/);
      
      if (tokenMatch) {
        return { success: true, accessToken: tokenMatch[1] };
      }

      if (response.data?.access_token) {
        return { success: true, accessToken: response.data.access_token };
      }

      return { success: false, error: 'Не вдалося отримати access token. Перевірте логін/пароль.' };

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
