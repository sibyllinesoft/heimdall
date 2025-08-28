/**
 * Gemini Direct Client with OAuth PKCE and thinking budget support
 * Supports 1M context window and thinkingBudget parameter
 */

import { BaseProviderClient, ProviderRequest, ProviderResponse, AuthCredentials, ProviderError } from './base_provider.js';

export interface GeminiRequest extends ProviderRequest {
  thinkingBudget?: number;
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    candidateCount?: number;
    stopSequences?: string[];
    responseMimeType?: string;
  };
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: object;
    }>;
  }>;
}

export interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
      role: string;
    };
    finishReason: string;
    index: number;
    safetyRatings: Array<{
      category: string;
      probability: string;
    }>;
  }>;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    thinkingTokens?: number;
  };
  modelVersion?: string;
}

/**
 * OAuth token cache for Gemini
 */
interface TokenCache {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  user_id: string;
}

/**
 * Gemini Direct API Client
 * Supports OAuth PKCE flow and thinkingBudget for 1M context
 */
export class GeminiClient extends BaseProviderClient {
  readonly provider = 'google';
  protected baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  
  private tokenCache = new Map<string, TokenCache>();
  private refreshPromises = new Map<string, Promise<string>>();
  
  constructor(
    private clientId?: string,
    private clientSecret?: string,
    private redirectUri?: string
  ) {
    super(45000, 3); // 45s timeout for thinking, 3 retries
  }
  
  async complete(
    request: GeminiRequest, 
    credentials: AuthCredentials
  ): Promise<ProviderResponse> {
    let token = credentials.token;
    
    // Handle OAuth token refresh if needed
    if (credentials.type === 'bearer' && credentials.refresh_token) {
      token = await this.ensureValidToken(credentials.token, credentials.refresh_token);
    }
    
    const messages = this.convertToGeminiFormat(request.messages);
    
    const body = {
      contents: messages,
      generationConfig: {
        maxOutputTokens: request.max_tokens || 2048,
        temperature: request.temperature || 0.7,
        ...request.generationConfig
      },
      safetySettings: request.safetySettings || this.getDefaultSafetySettings(),
      tools: request.tools,
      // Gemini-specific thinking parameter
      ...(request.thinkingBudget !== undefined && { thinkingBudget: request.thinkingBudget })
    };
    
    // Remove undefined values
    Object.keys(body).forEach(key => {
      if (body[key as keyof typeof body] === undefined) {
        delete body[key as keyof typeof body];
      }
    });
    
    const model = request.model.replace('google/', ''); // Remove provider prefix
    let url = `${this.baseUrl}/models/${model}:generateContent`;
    
    // For API key auth, add key as query parameter
    if (credentials.type === 'apikey') {
      url += `?key=${token}`;
    }
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Bifrost-Router/1.0'
    };
    
    // For OAuth, use Authorization header
    if (credentials.type === 'bearer') {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await this.makeRequest<GeminiResponse>(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    
    return this.convertToStandardFormat(response);
  }
  
  async validateCredentials(credentials: AuthCredentials): Promise<boolean> {
    try {
      let url = `${this.baseUrl}/models`;
      
      if (credentials.type === 'apikey') {
        url += `?key=${credentials.token}`;
        await this.makeRequest(url, { method: 'GET' });
      } else if (credentials.type === 'bearer') {
        await this.makeRequest(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
          }
        });
      }
      
      return true;
    } catch (error) {
      const providerError = this.handleError(error);
      // Only return false for auth errors
      return providerError.status !== 401 && providerError.status !== 403;
    }
  }
  
  /**
   * OAuth PKCE Flow Implementation
   */
  async initiateOAuthFlow(state: string, codeChallenge: string): Promise<string> {
    if (!this.clientId || !this.redirectUri) {
      throw new Error('OAuth client ID and redirect URI are required');
    }
    
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent'
    });
    
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }
  
  async exchangeCodeForTokens(
    code: string, 
    codeVerifier: string,
    userId: string
  ): Promise<AuthCredentials> {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error('OAuth credentials are required');
    }
    
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier
    });
    
    const response = await this.makeRequest<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });
    
    // Cache the tokens
    const expiresAt = Date.now() + (response.expires_in * 1000);
    this.tokenCache.set(userId, {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      expires_at: expiresAt,
      user_id: userId
    });
    
    return {
      type: 'bearer',
      token: response.access_token,
      refresh_token: response.refresh_token
    };
  }
  
  private async ensureValidToken(accessToken: string, refreshToken: string): Promise<string> {
    const userId = this.extractUserIdFromToken(accessToken);
    const cached = this.tokenCache.get(userId);
    
    // If token is still valid, use it
    if (cached && cached.expires_at > Date.now() + 60000) { // 1 minute buffer
      return cached.access_token;
    }
    
    // Prevent concurrent refresh requests
    if (this.refreshPromises.has(userId)) {
      return this.refreshPromises.get(userId)!;
    }
    
    const refreshPromise = this.refreshAccessToken(refreshToken, userId);
    this.refreshPromises.set(userId, refreshPromise);
    
    try {
      const newToken = await refreshPromise;
      this.refreshPromises.delete(userId);
      return newToken;
    } catch (error) {
      this.refreshPromises.delete(userId);
      throw error;
    }
  }
  
  private async refreshAccessToken(refreshToken: string, userId: string): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('OAuth credentials are required for token refresh');
    }
    
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    
    const response = await this.makeRequest<{
      access_token: string;
      expires_in: number;
      token_type: string;
    }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });
    
    // Update cache
    const expiresAt = Date.now() + (response.expires_in * 1000);
    this.tokenCache.set(userId, {
      access_token: response.access_token,
      refresh_token: refreshToken, // Keep the refresh token
      expires_at: expiresAt,
      user_id: userId
    });
    
    return response.access_token;
  }
  
  private extractUserIdFromToken(token: string): string {
    // Simple hash for user identification
    // In production, you'd decode the JWT or use a more robust method
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      const char = token.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString();
  }
  
  private convertToGeminiFormat(messages: Array<{ role: string; content: string }>) {
    return messages.map(msg => ({
      parts: [{ text: msg.content }],
      role: msg.role === 'assistant' ? 'model' : msg.role
    }));
  }
  
  private convertToStandardFormat(response: GeminiResponse): ProviderResponse {
    const choice = response.candidates[0];
    const content = choice?.content?.parts?.[0]?.text || '';
    
    return {
      id: `gemini-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.modelVersion || 'gemini-2.5-pro',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: choice?.finishReason?.toLowerCase() || 'stop'
      }],
      usage: {
        prompt_tokens: response.usageMetadata.promptTokenCount,
        completion_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount
      }
    };
  }
  
  private getDefaultSafetySettings() {
    return [
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
      },
      {
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
      },
      {
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
      },
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
      }
    ];
  }
  
  /**
   * Validate thinking budget parameter
   */
  validateThinkingBudget(budget: number, model: string): boolean {
    // Gemini 2.5 Pro supports thinking budgets
    if (model.includes('gemini-2.5-pro')) {
      return budget >= 128 && budget <= 32000; // Based on Vertex AI docs
    }
    
    return false;
  }
  
  /**
   * Get context capacity for model
   */
  getContextCapacity(model: string): number {
    if (model.includes('gemini-2.5-pro')) {
      return 1048576; // 1M tokens
    }
    
    return 128000; // Default for other Gemini models
  }
  
  /**
   * Check if model supports thinking
   */
  supportsThinking(model: string): boolean {
    return model.includes('gemini-2.5-pro');
  }
  
  handleError(error: unknown): ProviderError {
    const baseError = super.handleError(error);
    
    // Add Gemini-specific error handling
    if (typeof error === 'object' && error !== null) {
      const errorObj = error as any;
      
      // Gemini API error structure
      if (errorObj.error && errorObj.error.message) {
        return {
          error: {
            message: errorObj.error.message,
            type: errorObj.error.status || 'google_api_error',
            code: errorObj.error.code?.toString()
          },
          status: baseError.status
        };
      }
    }
    
    return baseError;
  }
}

/**
 * PKCE helper functions
 */
export class PKCEHelper {
  static generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(Array.from(array), byte => String.fromCharCode(byte))
      .join('')
      .replace(/[^A-Za-z0-9\-._~]/g, '') // URL safe characters
      .substring(0, 128); // Max length
  }
  
  static async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  
  static generateState(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }
}