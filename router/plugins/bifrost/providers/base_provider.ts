/**
 * Base provider interface for direct API integrations
 * Common interface for OpenAI, Gemini, and Anthropic direct clients
 */

export interface ProviderRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  // Provider-specific parameters
  [key: string]: unknown;
}

export interface ProviderResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ProviderError {
  error: {
    message: string;
    type: string;
    code?: string;
  };
  status?: number;
}

export interface AuthCredentials {
  type: 'bearer' | 'apikey';
  token: string;
  refresh_token?: string;
}

/**
 * Base provider client interface
 */
export interface ProviderClient {
  readonly provider: string;
  
  /**
   * Make a completion request to the provider
   */
  complete(
    request: ProviderRequest, 
    credentials: AuthCredentials
  ): Promise<ProviderResponse>;
  
  /**
   * Validate credentials
   */
  validateCredentials(credentials: AuthCredentials): Promise<boolean>;
  
  /**
   * Handle provider-specific error responses
   */
  handleError(error: unknown): ProviderError;
  
  /**
   * Check if error is retryable (e.g., rate limits)
   */
  isRetryableError(error: ProviderError): boolean;
  
  /**
   * Check if error is a 429 rate limit
   */
  isRateLimitError(error: ProviderError): boolean;
}

/**
 * Base implementation with common functionality
 */
export abstract class BaseProviderClient implements ProviderClient {
  abstract readonly provider: string;
  protected abstract baseUrl: string;
  
  constructor(
    protected defaultTimeout = 30000,
    protected maxRetries = 3
  ) {}
  
  abstract complete(
    request: ProviderRequest, 
    credentials: AuthCredentials
  ): Promise<ProviderResponse>;
  
  abstract validateCredentials(credentials: AuthCredentials): Promise<boolean>;
  
  handleError(error: unknown): ProviderError {
    if (error instanceof Error) {
      return {
        error: {
          message: error.message,
          type: 'client_error',
          code: 'unknown'
        }
      };
    }
    
    // Try to parse as HTTP error response
    if (typeof error === 'object' && error !== null) {
      const errorObj = error as any;
      if (errorObj.status && errorObj.error) {
        return {
          error: errorObj.error,
          status: errorObj.status
        };
      }
    }
    
    return {
      error: {
        message: 'Unknown error occurred',
        type: 'unknown_error'
      }
    };
  }
  
  isRetryableError(error: ProviderError): boolean {
    // Generally retry on 5xx errors and certain client errors
    if (error.status) {
      return error.status >= 500 || 
             error.status === 429 || 
             error.status === 408; // Request timeout
    }
    
    // Check error message for retryable conditions
    const message = error.error.message.toLowerCase();
    return message.includes('timeout') || 
           message.includes('connection') ||
           message.includes('rate limit');
  }
  
  isRateLimitError(error: ProviderError): boolean {
    return error.status === 429 || 
           error.error.type === 'rate_limit_error' ||
           error.error.message.toLowerCase().includes('rate limit');
  }
  
  /**
   * Common HTTP request helper with timeout and retry logic
   */
  protected async makeRequest<T>(
    url: string,
    options: RequestInit,
    retries = this.maxRetries
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeout);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const providerError: ProviderError = {
          error: errorBody.error || {
            message: `HTTP ${response.status}: ${response.statusText}`,
            type: 'http_error',
            code: response.status.toString()
          },
          status: response.status
        };
        
        // Retry logic
        if (retries > 0 && this.isRetryableError(providerError) && !this.isRateLimitError(providerError)) {
          const delay = Math.pow(2, this.maxRetries - retries) * 1000; // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.makeRequest(url, options, retries - 1);
        }
        
        throw providerError;
      }
      
      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw {
          error: {
            message: 'Request timeout',
            type: 'timeout_error'
          }
        } as ProviderError;
      }
      
      throw error;
    }
  }
}