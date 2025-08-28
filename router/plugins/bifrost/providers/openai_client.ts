/**
 * OpenAI Direct Client for GPT-5 with reasoning_effort support
 * Implements direct API calls with environment key authentication
 */

import { BaseProviderClient, ProviderRequest, ProviderResponse, AuthCredentials, ProviderError } from './base_provider.js';

export interface OpenAIRequest extends ProviderRequest {
  reasoning_effort?: 'low' | 'medium' | 'high';
  response_format?: {
    type: 'json_object' | 'text';
  };
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: object;
    };
  }>;
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
}

export interface OpenAIResponse extends ProviderResponse {
  system_fingerprint?: string;
  reasoning_effort?: {
    effort_level: string;
    reasoning_tokens: number;
  };
}

/**
 * OpenAI Direct API Client
 * Supports GPT-5 with reasoning_effort parameter
 */
export class OpenAIClient extends BaseProviderClient {
  readonly provider = 'openai';
  protected baseUrl = 'https://api.openai.com/v1';
  
  constructor() {
    super(30000, 3); // 30s timeout, 3 retries
  }
  
  async complete(
    request: OpenAIRequest, 
    credentials: AuthCredentials
  ): Promise<OpenAIResponse> {
    if (credentials.type !== 'apikey') {
      throw new Error('OpenAI client requires API key authentication');
    }
    
    const body = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream: request.stream || false,
      // GPT-5 specific parameters
      reasoning_effort: request.reasoning_effort,
      response_format: request.response_format,
      tools: request.tools,
      tool_choice: request.tool_choice
    };
    
    // Remove undefined values
    Object.keys(body).forEach(key => {
      if (body[key as keyof typeof body] === undefined) {
        delete body[key as keyof typeof body];
      }
    });
    
    const url = `${this.baseUrl}/chat/completions`;
    const response = await this.makeRequest<OpenAIResponse>(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Bifrost-Router/1.0'
      },
      body: JSON.stringify(body)
    });
    
    return response;
  }
  
  async validateCredentials(credentials: AuthCredentials): Promise<boolean> {
    if (credentials.type !== 'apikey') {
      return false;
    }
    
    try {
      const response = await this.makeRequest<{ data: any[] }>(
        `${this.baseUrl}/models`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return Array.isArray(response.data);
    } catch (error) {
      const providerError = this.handleError(error);
      // Only return false for auth errors, not network errors
      return providerError.status !== 401 && providerError.status !== 403;
    }
  }
  
  handleError(error: unknown): ProviderError {
    // First try parent handling
    const baseError = super.handleError(error);
    
    // Add OpenAI-specific error handling
    if (typeof error === 'object' && error !== null) {
      const errorObj = error as any;
      
      // OpenAI-specific error structure
      if (errorObj.error && errorObj.error.type) {
        return {
          error: {
            message: errorObj.error.message || 'OpenAI API error',
            type: errorObj.error.type,
            code: errorObj.error.code || errorObj.error.param
          },
          status: baseError.status
        };
      }
    }
    
    return baseError;
  }
  
  isRetryableError(error: ProviderError): boolean {
    // Don't retry on auth errors or invalid request errors
    if (error.status === 401 || error.status === 403 || error.status === 400) {
      return false;
    }
    
    // Don't retry on content policy violations
    if (error.error.type === 'content_filter') {
      return false;
    }
    
    return super.isRetryableError(error);
  }
  
  isRateLimitError(error: ProviderError): boolean {
    return super.isRateLimitError(error) || 
           error.error.type === 'rate_limit_exceeded';
  }
  
  /**
   * Get supported reasoning effort levels for a model
   */
  getSupportedReasoningEfforts(model: string): Array<'low' | 'medium' | 'high'> {
    // GPT-5 supports all levels
    if (model.includes('gpt-5')) {
      return ['low', 'medium', 'high'];
    }
    
    // Future models might have different support
    return [];
  }
  
  /**
   * Validate reasoning effort parameter
   */
  validateReasoningEffort(model: string, effort: string): boolean {
    const supported = this.getSupportedReasoningEfforts(model);
    return supported.includes(effort as 'low' | 'medium' | 'high');
  }
}