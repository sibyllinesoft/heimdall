/**
 * Centralized error handling and fallback mechanisms for Bifrost Router
 */

export interface ErrorContext {
  component: string;
  operation: string;
  metadata?: Record<string, unknown>;
}

export interface FallbackOptions {
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
  fallbackValues?: unknown[];
}

/**
 * Circuit breaker for external services
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private threshold = 5,
    private resetTimeout = 60000 // 1 minute
  ) {}
  
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }
  
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
  
  getState(): string {
    return this.state;
  }
}

/**
 * Enhanced error handler with fallback support
 */
export class ErrorHandler {
  private static circuitBreakers = new Map<string, CircuitBreaker>();
  
  /**
   * Execute operation with fallback chain
   */
  static async withFallback<T>(
    operations: (() => Promise<T>)[],
    context: ErrorContext,
    options: FallbackOptions = {}
  ): Promise<T> {
    const { maxRetries = 2, retryDelay = 100, timeout = 30000 } = options;
    let lastError: Error | null = null;
    
    for (let i = 0; i < operations.length; i++) {
      const operation = operations[i];
      
      for (let retry = 0; retry <= maxRetries; retry++) {
        try {
          const result = await this.executeWithTimeout(operation, timeout);
          
          if (i > 0) {
            console.warn(`${context.component}.${context.operation}: Succeeded with fallback #${i}`);
          }
          
          return result;
        } catch (error) {
          lastError = error as Error;
          
          console.warn(
            `${context.component}.${context.operation}: Attempt ${retry + 1}/${maxRetries + 1} failed:`,
            error
          );
          
          // Wait before retry (unless it's the last retry)
          if (retry < maxRetries) {
            await this.sleep(retryDelay * Math.pow(2, retry)); // Exponential backoff
          }
        }
      }
      
      // All retries for this operation failed, try next fallback
      console.error(
        `${context.component}.${context.operation}: Operation ${i + 1} failed after ${maxRetries + 1} attempts`
      );
    }
    
    // All operations failed
    const error = new Error(
      `All fallback operations failed for ${context.component}.${context.operation}. Last error: ${lastError?.message}`
    );
    
    this.logError(error, context);
    throw error;
  }
  
  /**
   * Execute with circuit breaker protection
   */
  static async withCircuitBreaker<T>(
    operation: () => Promise<T>,
    context: ErrorContext
  ): Promise<T> {
    const key = `${context.component}.${context.operation}`;
    
    if (!this.circuitBreakers.has(key)) {
      this.circuitBreakers.set(key, new CircuitBreaker());
    }
    
    const breaker = this.circuitBreakers.get(key)!;
    return breaker.execute(operation);
  }
  
  /**
   * Execute operation with timeout
   */
  private static async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    
    return Promise.race([operation(), timeoutPromise]);
  }
  
  /**
   * Sleep helper
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Log error with context
   */
  private static logError(error: Error, context: ErrorContext): void {
    console.error('=== ERROR REPORT ===');
    console.error(`Component: ${context.component}`);
    console.error(`Operation: ${context.operation}`);
    console.error(`Error: ${error.message}`);
    if (context.metadata) {
      console.error('Metadata:', context.metadata);
    }
    console.error('Stack:', error.stack);
    console.error('==================');
  }
  
  /**
   * Get circuit breaker states for monitoring
   */
  static getCircuitBreakerStates(): Record<string, string> {
    const states: Record<string, string> = {};
    
    for (const [key, breaker] of this.circuitBreakers.entries()) {
      states[key] = breaker.getState();
    }
    
    return states;
  }
}

/**
 * Specific error types for better handling
 */
export class EmbeddingServiceError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'EmbeddingServiceError';
  }
}

export class FAISSError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'FAISSError';
  }
}

export class OpenRouterError extends Error {
  constructor(message: string, public readonly statusCode?: number, public readonly cause?: Error) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export class ArtifactLoadError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'ArtifactLoadError';
  }
}

/**
 * Utility functions for common error scenarios
 */
export class ErrorUtils {
  /**
   * Check if error is retryable
   */
  static isRetryable(error: Error): boolean {
    const retryablePatterns = [
      /timeout/i,
      /network/i,
      /connection/i,
      /503/,
      /502/,
      /500/,
      /429/ // Rate limit - can retry with backoff
    ];
    
    return retryablePatterns.some(pattern => pattern.test(error.message));
  }
  
  /**
   * Extract status code from error
   */
  static getStatusCode(error: Error): number | null {
    const statusMatch = error.message.match(/\b(\d{3})\b/);
    return statusMatch ? parseInt(statusMatch[1]) : null;
  }
  
  /**
   * Create degraded service response
   */
  static createDegradedResponse<T>(fallbackValue: T, reason: string): T {
    console.warn(`Using degraded response: ${reason}`);
    return fallbackValue;
  }
}