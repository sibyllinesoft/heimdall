/**
 * Anthropic Direct Client with OAuth token forwarding and 429 handling
 * Handles user OAuth tokens and implements fallback logic
 */

import { BaseProviderClient, ProviderRequest, ProviderResponse, AuthCredentials, ProviderError } from './base_provider.js';

export interface AnthropicRequest extends ProviderRequest {
  system?: string;
  stop_sequences?: string[];
  anthropic_version?: string;
  metadata?: {
    user_id?: string;
  };
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
  model: string;
  stop_reason: string;
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Rate limit cooldown tracking
 */
interface RateLimitCooldown {
  user_id: string;
  expires_at: number;
  retry_after?: number;
}

/**
 * Anthropic Direct API Client
 * Forwards user OAuth tokens and handles 429 responses
 */
export class AnthropicClient extends BaseProviderClient {
  readonly provider = 'anthropic';
  protected baseUrl = 'https://api.anthropic.com/v1';
  
  private cooldowns = new Map<string, RateLimitCooldown>();
  private defaultVersion = '2023-06-01';
  
  constructor() {
    super(30000, 2); // 30s timeout, limited retries for 429s
  }
  
  async complete(
    request: AnthropicRequest, 
    credentials: AuthCredentials
  ): Promise<ProviderResponse> {
    if (credentials.type !== 'bearer') {
      throw new Error('Anthropic client requires Bearer token authentication');
    }
    
    // Check for active cooldown
    const userId = this.extractUserIdFromRequest(request, credentials);
    if (this.isUserOnCooldown(userId)) {
      const cooldown = this.cooldowns.get(userId);
      throw {
        error: {
          message: `User on cooldown until ${new Date(cooldown!.expires_at).toISOString()}`,
          type: 'rate_limit_cooldown',
          code: '429'
        },
        status: 429
      } as ProviderError;
    }
    
    const messages = this.convertToAnthropicFormat(request.messages);
    
    const body = {
      model: request.model,
      max_tokens: request.max_tokens || 2048,
      temperature: request.temperature || 0.7,
      messages,
      stream: request.stream || false,
      anthropic_version: request.anthropic_version || this.defaultVersion,
      system: request.system,
      stop_sequences: request.stop_sequences,
      metadata: request.metadata
    };
    
    // Remove undefined values
    Object.keys(body).forEach(key => {
      if (body[key as keyof typeof body] === undefined) {
        delete body[key as keyof typeof body];
      }
    });
    
    const url = `${this.baseUrl}/messages`;
    
    try {
      const response = await this.makeRequest<AnthropicResponse>(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
          'anthropic-version': body.anthropic_version,
          'User-Agent': 'Bifrost-Router/1.0'
        },
        body: JSON.stringify(body)
      });
      
      return this.convertToStandardFormat(response);
    } catch (error) {
      const providerError = this.handleError(error);
      
      // Handle 429 specifically
      if (this.isRateLimitError(providerError)) {
        this.applyCooldown(userId, providerError);
      }
      
      throw providerError;
    }
  }
  
  async validateCredentials(credentials: AuthCredentials): Promise<boolean> {
    if (credentials.type !== 'bearer') {
      return false;
    }
    
    try {
      // Use a lightweight request to validate
      await this.makeRequest(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${credentials.token}`,
          'anthropic-version': this.defaultVersion,
          'Content-Type': 'application/json'
        }
      });
      
      return true;
    } catch (error) {
      const providerError = this.handleError(error);
      // Only return false for auth errors
      return providerError.status !== 401 && providerError.status !== 403;
    }
  }
  
  /**
   * Check if user is currently on cooldown
   */
  isUserOnCooldown(userId: string): boolean {
    const cooldown = this.cooldowns.get(userId);
    if (!cooldown) return false;
    
    if (Date.now() < cooldown.expires_at) {
      return true;
    }
    
    // Expired cooldown - remove it
    this.cooldowns.delete(userId);
    return false;
  }
  
  /**
   * Apply cooldown to user after 429 error
   */
  private applyCooldown(userId: string, error: ProviderError): void {
    // Default cooldown period (3-5 minutes as specified in TODO)
    const defaultCooldownMs = 3 * 60 * 1000; // 3 minutes
    
    // Try to extract retry-after from error if available
    let cooldownMs = defaultCooldownMs;
    
    // Check if error has retry-after information
    if (error.error.code && /retry.after/i.test(error.error.message)) {
      const match = error.error.message.match(/(\d+)\s*seconds?/i);
      if (match) {
        cooldownMs = parseInt(match[1]) * 1000;
      }
    }
    
    // Cap cooldown at 5 minutes
    cooldownMs = Math.min(cooldownMs, 5 * 60 * 1000);
    
    this.cooldowns.set(userId, {
      user_id: userId,
      expires_at: Date.now() + cooldownMs,
      retry_after: Math.floor(cooldownMs / 1000)
    });
    
    console.log(`Applied ${Math.floor(cooldownMs / 1000)}s cooldown to user ${userId}`);
  }
  
  /**
   * Get cooldown info for user
   */
  getCooldownInfo(userId: string): RateLimitCooldown | null {
    return this.cooldowns.get(userId) || null;
  }
  
  /**
   * Clear cooldown for user (admin function)
   */
  clearCooldown(userId: string): boolean {
    return this.cooldowns.delete(userId);
  }
  
  /**
   * Get all active cooldowns (monitoring)
   */
  getActiveCooldowns(): RateLimitCooldown[] {
    const now = Date.now();
    const active = Array.from(this.cooldowns.values())
      .filter(cooldown => cooldown.expires_at > now);
    
    // Clean up expired entries
    for (const [userId, cooldown] of Array.from(this.cooldowns.entries())) {
      if (cooldown.expires_at <= now) {
        this.cooldowns.delete(userId);
      }
    }
    
    return active;
  }
  
  private extractUserIdFromRequest(request: AnthropicRequest, credentials: AuthCredentials): string {
    // Try to get user ID from metadata first
    if (request.metadata?.user_id) {
      return request.metadata.user_id;
    }
    
    // Fallback to token-based ID
    return this.extractUserIdFromToken(credentials.token);
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
    return `user_${Math.abs(hash).toString()}`;
  }
  
  private convertToAnthropicFormat(messages: Array<{ role: string; content: string }>) {
    return messages.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content
    }));
  }
  
  private convertToStandardFormat(response: AnthropicResponse): ProviderResponse {
    const content = response.content[0]?.text || '';
    
    return {
      id: response.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: response.stop_reason
      }],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens
      }
    };
  }
  
  handleError(error: unknown): ProviderError {
    const baseError = super.handleError(error);
    
    // Add Anthropic-specific error handling
    if (typeof error === 'object' && error !== null) {
      const errorObj = error as any;
      
      // Anthropic API error structure
      if (errorObj.error && errorObj.error.type) {
        return {
          error: {
            message: errorObj.error.message || 'Anthropic API error',
            type: errorObj.error.type,
            code: errorObj.error.code
          },
          status: baseError.status
        };
      }
    }
    
    return baseError;
  }
  
  isRetryableError(error: ProviderError): boolean {
    // Don't retry auth errors or invalid requests
    if (error.status === 401 || error.status === 403 || error.status === 400) {
      return false;
    }
    
    // Don't retry on content policy violations
    if (error.error.type === 'invalid_request_error') {
      return false;
    }
    
    // Special handling for 429 - don't retry, let the router handle fallback
    if (this.isRateLimitError(error)) {
      return false;
    }
    
    return super.isRetryableError(error);
  }
  
  isRateLimitError(error: ProviderError): boolean {
    return super.isRateLimitError(error) || 
           error.error.type === 'rate_limit_error';
  }
}