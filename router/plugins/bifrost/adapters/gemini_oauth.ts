/**
 * Gemini OAuth Adapter supporting both OAuth Bearer tokens and API keys
 * Implements Google OAuth PKCE flow with fallback to API key
 * Enhanced for Milestone 4 with token caching and 1M context support
 */

import { AuthAdapter } from './auth_adapter.js';
import { AuthInfo } from '../../../../src/types/common.js';
import { PKCEHelper } from '../providers/gemini_client.js';

export class GeminiOAuthAdapter implements AuthAdapter {
  readonly id = 'google-oauth';
  private oauthCache = new Map<string, { token: string; expires_at: number }>();
  
  constructor(
    private apiKey?: string,
    private clientId?: string,
    private redirectUri?: string
  ) {
    // Fallback API key from environment
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.clientId = clientId || process.env.GOOGLE_CLIENT_ID;
    this.redirectUri = redirectUri || process.env.GOOGLE_REDIRECT_URI;
  }
  
  matches(reqHeaders: Record<string, string | string[]>): boolean {
    const authorization = this.getHeader(reqHeaders, 'authorization');
    
    // Check for Bearer token (OAuth)
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.substring(7);
      return this.looksLikeGoogleToken(token);
    }
    
    // Check for API key in headers
    const apiKey = this.getHeader(reqHeaders, 'x-goog-api-key');
    if (apiKey) {
      return this.looksLikeGeminiApiKey(apiKey);
    }
    
    // Fallback to environment API key if available
    return !!this.apiKey;
  }
  
  extract(reqHeaders: Record<string, string | string[]>): AuthInfo | null {
    const authorization = this.getHeader(reqHeaders, 'authorization');
    
    // Try OAuth Bearer token first
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.substring(7);
      if (this.looksLikeGoogleToken(token)) {
        return {
          provider: 'google',
          type: 'bearer',
          token
        };
      }
    }
    
    // Try API key from headers
    const apiKey = this.getHeader(reqHeaders, 'x-goog-api-key');
    if (apiKey && this.looksLikeGeminiApiKey(apiKey)) {
      return {
        provider: 'google',
        type: 'apikey',
        token: apiKey
      };
    }
    
    // Fallback to environment API key
    if (this.apiKey) {
      return {
        provider: 'google',
        type: 'apikey',
        token: this.apiKey
      };
    }
    
    return null;
  }
  
  apply(outgoing: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  }): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  } {
    const newHeaders = { ...outgoing.headers };
    
    // Extract auth info to determine how to apply it
    const authHeader = outgoing.headers['authorization'] || outgoing.headers['Authorization'];
    
    if (authHeader?.startsWith('Bearer ')) {
      // OAuth flow - keep the bearer token
      newHeaders['Authorization'] = authHeader;
    } else {
      // API key flow - check for API key in various places
      const apiKey = outgoing.headers['x-goog-api-key'] || this.apiKey;
      if (apiKey) {
        // For Gemini API, we can use query parameter or header
        // Using query parameter approach for compatibility
        const url = new URL(outgoing.url);
        url.searchParams.set('key', apiKey);
        
        return {
          ...outgoing,
          url: url.toString(),
          headers: {
            ...newHeaders,
            'content-type': 'application/json'
          }
        };
      }
    }
    
    return {
      ...outgoing,
      headers: {
        ...newHeaders,
        'content-type': 'application/json'
      }
    };
  }
  
  async validate(token: string): Promise<boolean> {
    try {
      // Test with a simple request to Gemini API
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${token}`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }
  
  private getHeader(headers: Record<string, string | string[]>, name: string): string | null {
    const value = headers[name] || headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0] || null;
    }
    return value || null;
  }
  
  private looksLikeGoogleToken(token: string): boolean {
    // Google OAuth tokens are typically longer and have specific patterns
    // This is a heuristic - adjust based on actual token patterns observed
    return token.length > 100 && /^[A-Za-z0-9._/-]+$/.test(token);
  }
  
  private looksLikeGeminiApiKey(key: string): boolean {
    // Gemini API keys typically start with specific prefixes
    return key.startsWith('AIza') && key.length >= 35;
  }
  
  /**
   * Enhanced PKCE OAuth flow methods for Milestone 4
   */
  
  /**
   * Initiate OAuth PKCE flow
   */
  async initiateOAuthFlow(userId: string): Promise<{
    auth_url: string;
    state: string;
    code_verifier: string;
  }> {
    if (!this.clientId || !this.redirectUri) {
      throw new Error('OAuth configuration missing: client_id and redirect_uri required');
    }
    
    const codeVerifier = PKCEHelper.generateCodeVerifier();
    const codeChallenge = await PKCEHelper.generateCodeChallenge(codeVerifier);
    const state = PKCEHelper.generateState();
    
    // Store verifier temporarily (in production, use secure storage)
    this.oauthCache.set(`verifier_${state}`, {
      token: codeVerifier,
      expires_at: Date.now() + 600000 // 10 minutes
    });
    
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/generative-language',
      state: `${state}_${userId}`,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent'
    });
    
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    
    return {
      auth_url: authUrl,
      state,
      code_verifier: codeVerifier
    };
  }
  
  /**
   * Complete OAuth flow by exchanging code for tokens
   */
  async completeOAuthFlow(
    authCode: string,
    state: string,
    userId: string
  ): Promise<AuthInfo> {
    if (!this.clientId) {
      throw new Error('OAuth client_id required');
    }
    
    // Retrieve code verifier
    const verifierEntry = this.oauthCache.get(`verifier_${state}`);
    if (!verifierEntry || verifierEntry.expires_at < Date.now()) {
      throw new Error('Invalid or expired OAuth state');
    }
    
    const codeVerifier = verifierEntry.token;
    
    // Clean up verifier
    this.oauthCache.delete(`verifier_${state}`);
    
    // Exchange code for tokens
    const tokenResponse = await this.exchangeAuthCode(authCode, codeVerifier);
    
    // Cache the access token
    this.oauthCache.set(`oauth_${userId}`, {
      token: tokenResponse.access_token,
      expires_at: Date.now() + (tokenResponse.expires_in * 1000)
    });
    
    // Store refresh token separately if provided
    if (tokenResponse.refresh_token) {
      this.oauthCache.set(`refresh_${userId}`, {
        token: tokenResponse.refresh_token,
        expires_at: Date.now() + (365 * 24 * 60 * 60 * 1000) // 1 year
      });
    }
    
    return {
      provider: 'google',
      type: 'bearer',
      token: tokenResponse.access_token
    };
  }
  
  /**
   * Get cached OAuth token for user
   */
  getCachedToken(userId: string): string | null {
    const cached = this.oauthCache.get(`oauth_${userId}`);
    if (!cached || cached.expires_at < Date.now() + 60000) { // 1 minute buffer
      return null;
    }
    return cached.token;
  }
  
  /**
   * Refresh expired OAuth token
   */
  async refreshToken(userId: string): Promise<string | null> {
    const refreshEntry = this.oauthCache.get(`refresh_${userId}`);
    if (!refreshEntry || refreshEntry.expires_at < Date.now()) {
      return null;
    }
    
    try {
      const newTokens = await this.refreshAccessToken(refreshEntry.token);
      
      // Update cache
      this.oauthCache.set(`oauth_${userId}`, {
        token: newTokens.access_token,
        expires_at: Date.now() + (newTokens.expires_in * 1000)
      });
      
      return newTokens.access_token;
    } catch (error) {
      console.error('Token refresh failed:', error);
      // Clean up invalid refresh token
      this.oauthCache.delete(`refresh_${userId}`);
      return null;
    }
  }
  
  private async exchangeAuthCode(code: string, codeVerifier: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  }> {
    const body = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: this.redirectUri!,
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier
    });
    
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Token exchange failed: ${error.error || response.statusText}`);
    }
    
    return response.json();
  }
  
  private async refreshAccessToken(refreshToken: string): Promise<{
    access_token: string;
    expires_in: number;
    token_type: string;
  }> {
    const body = new URLSearchParams({
      client_id: this.clientId!,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
    
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Token refresh failed: ${error.error || response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * Check if Gemini model supports 1M context
   */
  supportsLongContext(model: string): boolean {
    return model.includes('gemini-2.5-pro') || model.includes('gemini-pro-2.5');
  }
  
  /**
   * Get max context size for model
   */
  getMaxContextSize(model: string): number {
    if (this.supportsLongContext(model)) {
      return 1048576; // 1M tokens
    }
    return 128000; // Standard context size
  }
}