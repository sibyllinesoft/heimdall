/**
 * OpenAI Key Adapter
 * Uses OPENAI_API_KEY from environment (no official OAuth for model API)
 * Supports optional user-key storage for BYOK scenarios
 */

import { AuthAdapter } from './auth_adapter.js';
import { AuthInfo } from '../../../../src/types/common.js';

export class OpenAIKeyAdapter implements AuthAdapter {
  readonly id = 'openai-key';
  
  constructor(private apiKey?: string) {
    // Default to environment API key
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
  }
  
  matches(reqHeaders: Record<string, string | string[]>): boolean {
    // Check for OpenAI API key in headers (user-provided)
    const apiKey = this.getHeader(reqHeaders, 'x-openai-api-key') ||
                   this.getHeader(reqHeaders, 'openai-api-key');
    
    if (apiKey && this.looksLikeOpenAIKey(apiKey)) {
      return true;
    }
    
    // Check for Bearer token that might be an OpenAI key (legacy support)
    const authorization = this.getHeader(reqHeaders, 'authorization');
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.substring(7);
      if (this.looksLikeOpenAIKey(token)) {
        return true;
      }
    }
    
    // Fallback to environment key
    return !!this.apiKey;
  }
  
  extract(reqHeaders: Record<string, string | string[]>): AuthInfo | null {
    // Try explicit API key headers first
    const explicitKey = this.getHeader(reqHeaders, 'x-openai-api-key') ||
                       this.getHeader(reqHeaders, 'openai-api-key');
    
    if (explicitKey && this.looksLikeOpenAIKey(explicitKey)) {
      return {
        provider: 'openai',
        type: 'apikey',
        token: explicitKey
      };
    }
    
    // Check Bearer token (some clients send API key as Bearer)
    const authorization = this.getHeader(reqHeaders, 'authorization');
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.substring(7);
      if (this.looksLikeOpenAIKey(token)) {
        return {
          provider: 'openai',
          type: 'apikey',
          token
        };
      }
    }
    
    // Fallback to environment key
    if (this.apiKey) {
      return {
        provider: 'openai',
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
    // Extract the API key from the auth info
    let apiKey = this.apiKey;
    
    // Check if there's an explicit key in the outgoing headers
    const explicitKey = outgoing.headers['x-openai-api-key'] || 
                       outgoing.headers['openai-api-key'];
    if (explicitKey) {
      apiKey = explicitKey;
    }
    
    // Check if the authorization header has the API key
    const authHeader = outgoing.headers['authorization'] || outgoing.headers['Authorization'];
    if (authHeader?.startsWith('Bearer ') && this.looksLikeOpenAIKey(authHeader.substring(7))) {
      apiKey = authHeader.substring(7);
    }
    
    if (!apiKey) {
      throw new Error('No OpenAI API key available');
    }
    
    return {
      ...outgoing,
      headers: {
        ...outgoing.headers,
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Bifrost-Router/1.0'
      }
    };
  }
  
  async validate(token: string): Promise<boolean> {
    try {
      // Make a lightweight request to verify the API key
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
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
  
  private looksLikeOpenAIKey(key: string): boolean {
    // OpenAI API keys typically start with 'sk-' and have specific length/format
    return key.startsWith('sk-') && key.length >= 40;
  }
}