/**
 * Structured Logger utility class
 * 
 * Provides static logging methods with consistent formatting, emoji prefixes,
 * and proper error handling for different log levels.
 * 
 * @example
 * ```typescript
 * Logger.info('User logged in', { userId: '123', timestamp: Date.now() });
 * Logger.warn('Rate limit approaching', { current: 95, limit: 100 });
 * Logger.error('authenticate user', new Error('Invalid token'), { userId: '123' });
 * ```
 */
export class Logger {
  /**
   * Logs error messages with structured formatting
   * 
   * @param operation - Description of the operation that failed
   * @param error - The error object or message that occurred
   * @param context - Optional additional context information
   * 
   * @example
   * ```typescript
   * try {
   *   await authenticateUser(token);
   * } catch (error) {
   *   Logger.error('authenticate user', error, { userId: '123', endpoint: '/auth' });
   * }
   * ```
   */
  static error(operation: string, error: unknown, context?: Record<string, any>): void {
    const errorInfo = Logger.extractErrorInfo(error);
    const contextStr = context ? ` | Context: ${JSON.stringify(context, null, 2)}` : '';
    
    console.error(`❌ Failed to ${operation}:`, {
      message: errorInfo.message,
      stack: errorInfo.stack,
      ...(context && { context })
    });
  }

  /**
   * Logs informational messages
   * 
   * @param message - The informational message to log
   * @param context - Optional additional context information
   * 
   * @example
   * ```typescript
   * Logger.info('Database connection established', { 
   *   host: 'localhost', 
   *   port: 5432,
   *   duration: '120ms' 
   * });
   * ```
   */
  static info(message: string, context?: Record<string, any>): void {
    const logData: Record<string, any> = { message };
    if (context) {
      logData.context = context;
    }
    
    console.log(`ℹ️ ${message}`, context ? logData : '');
  }

  /**
   * Logs warning messages
   * 
   * @param message - The warning message to log
   * @param context - Optional additional context information
   * 
   * @example
   * ```typescript
   * Logger.warn('Memory usage is high', { 
   *   currentUsage: '85%', 
   *   threshold: '80%',
   *   processId: process.pid 
   * });
   * ```
   */
  static warn(message: string, context?: Record<string, any>): void {
    const logData: Record<string, any> = { message };
    if (context) {
      logData.context = context;
    }
    
    console.warn(`⚠️ ${message}`, context ? logData : '');
  }

  /**
   * Extracts error information from various error types
   * 
   * @private
   * @param error - The error to extract information from
   * @returns Structured error information with message and stack
   */
  private static extractErrorInfo(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
      return {
        message: error.message,
        stack: error.stack
      };
    }
    
    if (typeof error === 'string') {
      return { message: error };
    }
    
    if (error && typeof error === 'object') {
      // Handle error-like objects
      const errorObj = error as Record<string, any>;
      return {
        message: errorObj.message || errorObj.error || JSON.stringify(error),
        stack: errorObj.stack
      };
    }
    
    // Fallback for unknown error types
    return {
      message: `Unknown error: ${String(error)}`
    };
  }
}