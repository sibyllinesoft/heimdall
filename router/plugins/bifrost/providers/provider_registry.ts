/**
 * Provider Registry
 * Manages direct provider clients and handles routing to appropriate client
 */

import { ProviderClient, AuthCredentials, ProviderRequest, ProviderResponse } from './base_provider.js';
import { OpenAIClient } from './openai_client.js';
import { GeminiClient } from './gemini_client.js';
import { AnthropicClient } from './anthropic_client.js';

export interface ProviderRegistry {
  /**
   * Get provider client by name
   */
  getClient(provider: string): ProviderClient | null;
  
  /**
   * Make a completion request through appropriate provider
   */
  complete(
    provider: string,
    request: ProviderRequest,
    credentials: AuthCredentials
  ): Promise<ProviderResponse>;
  
  /**
   * Validate credentials for a provider
   */
  validateCredentials(provider: string, credentials: AuthCredentials): Promise<boolean>;
  
  /**
   * Check if provider supports specific features
   */
  supportsFeature(provider: string, feature: string): boolean;
}

/**
 * Configuration for provider clients
 */
export interface ProviderConfig {
  openai?: {
    enabled: boolean;
  };
  google?: {
    enabled: boolean;
    oauth?: {
      client_id: string;
      client_secret: string;
      redirect_uri: string;
    };
  };
  anthropic?: {
    enabled: boolean;
    cooldown_duration_ms?: number;
  };
}

/**
 * Registry implementation managing all provider clients
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  private clients = new Map<string, ProviderClient>();
  
  constructor(private config: ProviderConfig) {
    this.initializeClients();
  }
  
  private initializeClients(): void {
    // Initialize OpenAI client
    if (this.config.openai?.enabled !== false) {
      this.clients.set('openai', new OpenAIClient());
    }
    
    // Initialize Gemini client
    if (this.config.google?.enabled !== false) {
      const oauth = this.config.google?.oauth;
      this.clients.set('google', new GeminiClient(
        oauth?.client_id,
        oauth?.client_secret,
        oauth?.redirect_uri
      ));
    }
    
    // Initialize Anthropic client
    if (this.config.anthropic?.enabled !== false) {
      this.clients.set('anthropic', new AnthropicClient());
    }
  }
  
  getClient(provider: string): ProviderClient | null {
    return this.clients.get(provider) || null;
  }
  
  async complete(
    provider: string,
    request: ProviderRequest,
    credentials: AuthCredentials
  ): Promise<ProviderResponse> {
    const client = this.getClient(provider);
    if (!client) {
      throw new Error(`Provider client not found: ${provider}`);
    }
    
    return client.complete(request, credentials);
  }
  
  async validateCredentials(provider: string, credentials: AuthCredentials): Promise<boolean> {
    const client = this.getClient(provider);
    if (!client) {
      return false;
    }
    
    return client.validateCredentials(credentials);
  }
  
  supportsFeature(provider: string, feature: string): boolean {
    const client = this.getClient(provider);
    if (!client) {
      return false;
    }
    
    switch (provider) {
      case 'openai':
        return this.openAISupportsFeature(feature);
      case 'google':
        return this.geminiSupportsFeature(feature);
      case 'anthropic':
        return this.anthropicSupportsFeature(feature);
      default:
        return false;
    }
  }
  
  private openAISupportsFeature(feature: string): boolean {
    const supportedFeatures = [
      'reasoning_effort',
      'tools',
      'json_mode',
      'streaming',
      'function_calling'
    ];
    return supportedFeatures.includes(feature);
  }
  
  private geminiSupportsFeature(feature: string): boolean {
    const supportedFeatures = [
      'thinking_budget',
      'tools',
      'json_mode',
      'streaming',
      'safety_settings',
      'long_context', // 1M tokens
      'oauth'
    ];
    return supportedFeatures.includes(feature);
  }
  
  private anthropicSupportsFeature(feature: string): boolean {
    const supportedFeatures = [
      'system_prompts',
      'streaming',
      'oauth',
      'rate_limit_handling'
    ];
    return supportedFeatures.includes(feature);
  }
  
  /**
   * Get provider-specific clients for advanced operations
   */
  getOpenAIClient(): OpenAIClient | null {
    return this.getClient('openai') as OpenAIClient | null;
  }
  
  getGeminiClient(): GeminiClient | null {
    return this.getClient('google') as GeminiClient | null;
  }
  
  getAnthropicClient(): AnthropicClient | null {
    return this.getClient('anthropic') as AnthropicClient | null;
  }
  
  /**
   * Check rate limit status for Anthropic users
   */
  getAnthropicCooldownInfo(userId: string): { on_cooldown: boolean; expires_at?: number } {
    const client = this.getAnthropicClient();
    if (!client) {
      return { on_cooldown: false };
    }
    
    const cooldown = client.getCooldownInfo(userId);
    return {
      on_cooldown: cooldown !== null,
      expires_at: cooldown?.expires_at
    };
  }
  
  /**
   * Health check for all providers
   */
  async healthCheck(): Promise<Record<string, { status: 'healthy' | 'unhealthy'; error?: string }>> {
    const results: Record<string, { status: 'healthy' | 'unhealthy'; error?: string }> = {};
    
    for (const [provider, client] of Array.from(this.clients.entries())) {
      try {
        // Use environment credentials for health check
        const credentials = this.getDefaultCredentials(provider);
        if (credentials) {
          const isValid = await client.validateCredentials(credentials);
          results[provider] = {
            status: isValid ? 'healthy' : 'unhealthy',
            error: isValid ? undefined : 'Credential validation failed'
          };
        } else {
          results[provider] = {
            status: 'unhealthy',
            error: 'No default credentials available'
          };
        }
      } catch (error) {
        results[provider] = {
          status: 'unhealthy',
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
    
    return results;
  }
  
  private getDefaultCredentials(provider: string): AuthCredentials | null {
    switch (provider) {
      case 'openai':
        return process.env.OPENAI_API_KEY ? {
          type: 'apikey',
          token: process.env.OPENAI_API_KEY
        } : null;
        
      case 'google':
        return process.env.GEMINI_API_KEY ? {
          type: 'apikey',
          token: process.env.GEMINI_API_KEY
        } : null;
        
      case 'anthropic':
        // Anthropic requires user tokens, no default available
        return null;
        
      default:
        return null;
    }
  }
}