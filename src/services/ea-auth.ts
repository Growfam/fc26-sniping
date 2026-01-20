/**
 * FC26 EA Authentication Service
 * 
 * Full authentication flow based on FifaSharp approach:
 * 1. Email + Password login to EA accounts
 * 2. 2FA verification (email/SMS/authenticator)
 * 3. OAuth token acquisition
 * 4. Session ID (X-UT-SID) generation
 * 5. Cookie caching for session persistence
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { logger } from '../utils/logger';
import { config } from '../config';
import { db } from '../database';
import { EventEmitter } from 'events';

// ==========================================
// TYPES & INTERFACES
// ==========================================

export interface EACredentials {
  email: string;
  password: string;
  platform: 'ps' | 'xbox' | 'pc';
}

export interface EASession {
  sid: string;           // X-UT-SID - main session token
  accessToken?: string;  // OAuth access token
  tokenType?: string;
  expiresAt?: Date;
  personaId?: string;
  nucleusId?: string;
  pidId?: string;
  dob?: string;
  phishingToken?: string;
  platform: 'ps' | 'xbox' | 'pc';
}

export interface AuthCookies {
  sid: string;
  [key: string]: string;
}

export interface LoginResult {
  success: boolean;
  session?: EASession;
  cookies?: AuthCookies;
  error?: string;
  requires2FA?: boolean;
}

export type TwoFactorCodeProvider = () => Promise<string | null>;

// ==========================================
// EA ENDPOINTS
// ==========================================

const EA_ENDPOINTS = {
  // Authentication
  LOGIN_PAGE: 'https://www.ea.com/login',
  ACCOUNTS_AUTH: 'https://accounts.ea.com/connect/auth',
  ACCOUNTS_TOKEN: 'https://accounts.ea.com/connect/token',
  
  // Gateway
  GATEWAY_IDENTITY: 'https://gateway.ea.com/proxy/identity/pids/me',
  
  // FUT/FC specific
  FUT_WEB_APP: 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app',
  FUT_AUTH: 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/auth.html',
  
  // Platform-specific UT endpoints
  UT_PS: 'https://utas.mob.v1.fut.ea.com',
  UT_XBOX: 'https://utas.mob.v2.fut.ea.com',
  UT_PC: 'https://utas.mob.v4.fut.ea.com',
};

const PLATFORM_ENDPOINTS: Record<string, string> = {
  'ps': EA_ENDPOINTS.UT_PS,
  'xbox': EA_ENDPOINTS.UT_XBOX,
  'pc': EA_ENDPOINTS.UT_PC,
};

// ==========================================
// EA AUTH SERVICE
// ==========================================

export class EAAuthService extends EventEmitter {
  private client: AxiosInstance;
  private cookieJar: CookieJar;
  private currentSession: EASession | null = null;
  
  // Browser-like headers
  private readonly DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  constructor() {
    super();
    this.cookieJar = new CookieJar();
    this.client = wrapper(axios.create({
      jar: this.cookieJar,
      withCredentials: true,
      timeout: 30000,
      maxRedirects: 10,
      headers: this.DEFAULT_HEADERS,
    }));
  }

  // ==========================================
  // MAIN LOGIN METHODS
  // ==========================================

  /**
   * Full login with email/password and 2FA
   * Based on FifaSharp TryLoginAsync
   */
  async loginWithCredentials(
    credentials: EACredentials,
    get2FACode: TwoFactorCodeProvider,
    onCookiesCached?: (cookies: AuthCookies) => void
  ): Promise<LoginResult> {
    try {
      logger.info(`[EAAuth] Starting login for ${credentials.email}`);

      // Step 1: Initialize session and get login page
      await this.initializeSession();

      // Step 2: Submit credentials
      const loginResult = await this.submitCredentials(
        credentials.email, 
        credentials.password
      );

      if (!loginResult.success) {
        return loginResult;
      }

      // Step 3: Handle 2FA if required
      if (loginResult.requires2FA) {
        logger.info(`[EAAuth] 2FA required`);
        this.emit('2fa_required', {});

        const code = await get2FACode();
        if (!code) {
          return {
            success: false,
            error: '2FA code not provided'
          };
        }

        const twoFAResult = await this.submit2FACode(code);
        if (!twoFAResult.success) {
          return twoFAResult;
        }
      }

      // Step 4: Get OAuth token
      const tokenResult = await this.getAccessToken(credentials.platform);
      if (!tokenResult.success) {
        return tokenResult;
      }

      // Step 5: Get persona and nucleus IDs
      const identityResult = await this.getIdentity();
      if (!identityResult.success) {
        return identityResult;
      }

      // Step 6: Authenticate to FUT/FC
      const futAuthResult = await this.authenticateToFUT(credentials.platform);
      if (!futAuthResult.success) {
        return futAuthResult;
      }

      // Build final session
      this.currentSession = {
        sid: futAuthResult.session!.sid,
        accessToken: tokenResult.session!.accessToken,
        personaId: identityResult.session!.personaId,
        nucleusId: identityResult.session!.nucleusId,
        platform: credentials.platform,
      };

      // Cache cookies if callback provided
      const cookies = this.getLoginCookies();
      if (onCookiesCached && cookies) {
        onCookiesCached(cookies);
      }

      logger.info(`[EAAuth] Login successful for ${credentials.email}`);

      return {
        success: true,
        session: this.currentSession,
        cookies: cookies || undefined
      };

    } catch (error: any) {
      logger.error(`[EAAuth] Login failed:`, error);
      return {
        success: false,
        error: error.message || 'Unknown login error'
      };
    }
  }

  /**
   * Login using cached cookies (FifaSharp pattern)
   * Skips email/password/2FA if cookies are still valid
   */
  async loginWithCookies(
    cookies: AuthCookies,
    platform: 'ps' | 'xbox' | 'pc'
  ): Promise<LoginResult> {
    try {
      logger.info(`[EAAuth] Attempting login with cached cookies`);

      // Restore cookies to jar
      await this.restoreCookies(cookies);

      // Verify session is still valid
      const verifyResult = await this.verifySession(platform);
      
      if (verifyResult.success) {
        this.currentSession = {
          sid: cookies.sid,
          platform,
          ...verifyResult.session
        };

        logger.info(`[EAAuth] Cookie login successful`);
        return {
          success: true,
          session: this.currentSession,
          cookies
        };
      }

      logger.warn(`[EAAuth] Cookie login failed - session expired`);
      return {
        success: false,
        error: 'Session expired. Please login with credentials.'
      };

    } catch (error: any) {
      logger.error(`[EAAuth] Cookie login error:`, error);
      return {
        success: false,
        error: error.message || 'Cookie login failed'
      };
    }
  }

  // ==========================================
  // AUTHENTICATION STEPS
  // ==========================================

  /**
   * Step 1: Initialize session
   */
  private async initializeSession(): Promise<void> {
    // Clear old cookies
    this.cookieJar = new CookieJar();
    this.client = wrapper(axios.create({
      jar: this.cookieJar,
      withCredentials: true,
      timeout: 30000,
      maxRedirects: 10,
      headers: this.DEFAULT_HEADERS,
    }));

    // Visit login page to get initial cookies
    await this.client.get(EA_ENDPOINTS.LOGIN_PAGE);
    
    logger.debug(`[EAAuth] Session initialized`);
  }

  /**
   * Step 2: Submit email and password
   */
  private async submitCredentials(
    email: string, 
    password: string
  ): Promise<LoginResult> {
    try {
      // EA uses OAuth2 flow
      const authParams = new URLSearchParams({
        client_id: 'FC26_JS_WEB_APP',
        response_type: 'token',
        redirect_uri: EA_ENDPOINTS.FUT_AUTH,
        locale: 'en_US',
        prompt: 'login',
        display: 'web2/login'
      });

      const authUrl = `${EA_ENDPOINTS.ACCOUNTS_AUTH}?${authParams.toString()}`;
      
      // Get login form
      const loginPageResponse = await this.client.get(authUrl, {
        maxRedirects: 5
      });

      // Extract form data and submit
      const formData = new URLSearchParams({
        email: email,
        password: password,
        _eventId: 'submit',
        cid: this.extractCid(loginPageResponse.data),
        showAgeUp: 'true',
        thirdPartyCaptchaResponse: '',
        _rememberMe: 'on',
      });

      // Find the actual login URL from the response
      const loginUrl = this.extractLoginUrl(loginPageResponse.data) || 
                       loginPageResponse.request.res.responseUrl;

      const loginResponse = await this.client.post(loginUrl, formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': authUrl,
        },
        maxRedirects: 0,
        validateStatus: (status) => status < 500,
      });

      // Check response
      const responseUrl = loginResponse.headers.location || '';
      const responseData = loginResponse.data || '';

      // Check for 2FA requirement
      if (responseUrl.includes('tfa') || 
          responseData.includes('twoFactorCode') ||
          responseData.includes('verification')) {
        return {
          success: true,
          requires2FA: true
        };
      }

      // Check for successful auth redirect
      if (responseUrl.includes('access_token=')) {
        const token = this.extractAccessToken(responseUrl);
        return {
          success: true,
          session: {
            accessToken: token || undefined,
            platform: 'pc', // Will be set later
            sid: ''
          }
        };
      }

      // Check for errors
      if (responseData.includes('error') || responseData.includes('invalid')) {
        return {
          success: false,
          error: 'Invalid email or password'
        };
      }

      return { success: true };

    } catch (error: any) {
      return {
        success: false,
        error: `Credential submission failed: ${error.message}`
      };
    }
  }

  /**
   * Step 3: Submit 2FA code
   */
  private async submit2FACode(code: string): Promise<LoginResult> {
    try {
      const formData = new URLSearchParams({
        oneTimeCode: code,
        _eventId: 'submit',
        _trustThisDevice: 'on',
      });

      const response = await this.client.post(
        'https://signin.ea.com/p/web2/twoFactorSubmit',
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          maxRedirects: 0,
          validateStatus: (status) => status < 500,
        }
      );

      const responseUrl = response.headers.location || '';

      if (responseUrl.includes('access_token=')) {
        return { success: true };
      }

      if (response.data?.includes('error') || response.data?.includes('invalid')) {
        return {
          success: false,
          error: 'Invalid 2FA code'
        };
      }

      return { success: true };

    } catch (error: any) {
      return {
        success: false,
        error: `2FA submission failed: ${error.message}`
      };
    }
  }

  /**
   * Step 4: Get OAuth access token
   */
  private async getAccessToken(platform: string): Promise<LoginResult> {
    try {
      const authParams = new URLSearchParams({
        client_id: 'FC26_JS_WEB_APP',
        response_type: 'token',
        redirect_uri: EA_ENDPOINTS.FUT_AUTH,
        locale: 'en_US',
      });

      const response = await this.client.get(
        `${EA_ENDPOINTS.ACCOUNTS_AUTH}?${authParams.toString()}`,
        {
          maxRedirects: 10,
          validateStatus: () => true,
        }
      );

      // Extract token from redirect URL or response
      const finalUrl = response.request?.res?.responseUrl || '';
      const accessToken = this.extractAccessToken(finalUrl);

      if (!accessToken) {
        return {
          success: false,
          error: 'Failed to obtain access token'
        };
      }

      return {
        success: true,
        session: {
          accessToken,
          platform: platform as 'ps' | 'xbox' | 'pc',
          sid: ''
        }
      };

    } catch (error: any) {
      return {
        success: false,
        error: `Token acquisition failed: ${error.message}`
      };
    }
  }

  /**
   * Step 5: Get user identity (persona, nucleus IDs)
   */
  private async getIdentity(): Promise<LoginResult> {
    try {
      const response = await this.client.get(EA_ENDPOINTS.GATEWAY_IDENTITY, {
        headers: {
          'Accept': 'application/json',
        }
      });

      const data = response.data;

      return {
        success: true,
        session: {
          personaId: data.pid?.pidId,
          nucleusId: data.pid?.externalRefValue,
          platform: 'pc' as const,
          sid: ''
        }
      };

    } catch (error: any) {
      return {
        success: false,
        error: `Identity fetch failed: ${error.message}`
      };
    }
  }

  /**
   * Step 6: Authenticate to FUT/FC and get SID
   */
  private async authenticateToFUT(platform: 'ps' | 'xbox' | 'pc'): Promise<LoginResult> {
    try {
      const baseUrl = PLATFORM_ENDPOINTS[platform];
      
      // Get user accounts
      const accountsResponse = await this.client.get(
        `${baseUrl}/ut/game/fc26/user/accountinfo`,
        {
          headers: {
            'Accept': 'application/json',
            'Easw-Session-Data-Nucleus-Id': this.currentSession?.nucleusId || '',
          }
        }
      );

      // Authenticate
      const authResponse = await this.client.post(
        `${baseUrl}/ut/auth?client=webcomp`,
        {
          isReadOnly: false,
          sku: 'FUT26WEB',
          clientVersion: 1,
        },
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          }
        }
      );

      const sid = authResponse.data?.sid;

      if (!sid) {
        return {
          success: false,
          error: 'Failed to obtain session ID'
        };
      }

      return {
        success: true,
        session: {
          sid,
          platform,
        }
      };

    } catch (error: any) {
      return {
        success: false,
        error: `FUT authentication failed: ${error.message}`
      };
    }
  }

  // ==========================================
  // SESSION VERIFICATION
  // ==========================================

  /**
   * Verify if current session is valid
   */
  private async verifySession(platform: 'ps' | 'xbox' | 'pc'): Promise<LoginResult> {
    try {
      const baseUrl = PLATFORM_ENDPOINTS[platform];
      const sid = this.currentSession?.sid || this.getLoginCookies()?.sid;

      if (!sid) {
        return {
          success: false,
          error: 'No SID available'
        };
      }

      const response = await this.client.get(
        `${baseUrl}/ut/game/fc26/user/credits`,
        {
          headers: {
            'Accept': 'application/json',
            'X-UT-SID': sid,
          }
        }
      );

      if (response.data?.credits !== undefined) {
        return {
          success: true,
          session: {
            sid,
            platform,
          }
        };
      }

      return {
        success: false,
        error: 'Session verification failed'
      };

    } catch (error: any) {
      return {
        success: false,
        error: `Session verification error: ${error.message}`
      };
    }
  }

  // ==========================================
  // COOKIE MANAGEMENT
  // ==========================================

  /**
   * Get current login cookies for caching
   */
  getLoginCookies(): AuthCookies | null {
    try {
      const cookies = this.cookieJar.toJSON();
      const cookieMap: AuthCookies = { sid: '' };

      for (const cookie of cookies.cookies) {
        cookieMap[cookie.key] = cookie.value;
        
        // Look for session ID
        if (cookie.key.toLowerCase().includes('sid') || 
            cookie.key === 'UT-SID' ||
            cookie.key === 'X-UT-SID') {
          cookieMap.sid = cookie.value;
        }
      }

      // Add SID from current session if available
      if (this.currentSession?.sid) {
        cookieMap.sid = this.currentSession.sid;
      }

      return cookieMap.sid ? cookieMap : null;
    } catch (error) {
      logger.error('[EAAuth] Failed to get login cookies:', error);
      return null;
    }
  }

  /**
   * Restore cookies from cache
   */
  private async restoreCookies(cookies: AuthCookies): Promise<void> {
    const domains = ['.ea.com', '.fut.ea.com'];
    
    for (const [key, value] of Object.entries(cookies)) {
      for (const domain of domains) {
        try {
          await this.cookieJar.setCookie(
            `${key}=${value}; Domain=${domain}; Path=/`,
            `https://${domain.replace('.', '')}`
          );
        } catch (e) {
          // Ignore invalid cookie errors
        }
      }
    }
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  /**
   * Extract CID from login page
   */
  private extractCid(html: string): string {
    const match = html.match(/name="cid"\s+value="([^"]+)"/);
    return match ? match[1] : '';
  }

  /**
   * Extract login URL from page
   */
  private extractLoginUrl(html: string): string | null {
    const match = html.match(/action="([^"]+)"/);
    return match ? match[1] : null;
  }

  /**
   * Extract access token from URL
   */
  private extractAccessToken(url: string): string | null {
    const match = url.match(/access_token=([^&]+)/);
    return match ? match[1] : null;
  }

  /**
   * Get current session
   */
  getCurrentSession(): EASession | null {
    return this.currentSession;
  }

  /**
   * Clear session
   */
  clearSession(): void {
    this.currentSession = null;
    this.cookieJar = new CookieJar();
    logger.info('[EAAuth] Session cleared');
  }
}

// ==========================================
// EA AUTH MANAGER
// ==========================================

/**
 * Manages EA authentication for multiple accounts
 */
export class EAAuthManager {
  private authService: EAAuthService;
  private sessions: Map<string, EASession> = new Map();

  constructor() {
    this.authService = new EAAuthService();
  }

  /**
   * Login with email/password
   */
  async login(
    accountId: string,
    credentials: EACredentials,
    get2FACode: TwoFactorCodeProvider
  ): Promise<LoginResult> {
    const result = await this.authService.loginWithCredentials(
      credentials,
      get2FACode,
      async (cookies) => {
        // Save cookies to database
        await db.updateEAAccountSession(accountId, { cookies });
      }
    );

    if (result.success && result.session) {
      this.sessions.set(accountId, result.session);
    }

    return result;
  }

  /**
   * Login with cached session
   */
  async loginWithCache(accountId: string, platform: 'ps' | 'xbox' | 'pc'): Promise<LoginResult> {
    const accountData = await db.getEAAccountWithCookies(accountId);
    
    if (!accountData) {
      return {
        success: false,
        error: 'Account not found'
      };
    }

    const cookies = accountData.cookies as AuthCookies;
    
    if (!cookies || !cookies.sid) {
      return {
        success: false,
        error: 'No cached session available'
      };
    }

    const result = await this.authService.loginWithCookies(cookies, platform);

    if (result.success && result.session) {
      this.sessions.set(accountId, result.session);
    }

    return result;
  }

  /**
   * Get session for account
   */
  getSession(accountId: string): EASession | undefined {
    return this.sessions.get(accountId);
  }

  /**
   * Remove session
   */
  removeSession(accountId: string): void {
    this.sessions.delete(accountId);
  }

  /**
   * Get auth service for advanced usage
   */
  getAuthService(): EAAuthService {
    return this.authService;
  }
}

// Export singleton
export const eaAuthManager = new EAAuthManager();
