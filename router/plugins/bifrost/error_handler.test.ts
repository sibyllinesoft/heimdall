import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CircuitBreaker,
  ErrorHandler,
  ErrorContext,
  FallbackOptions,
  EmbeddingServiceError,
  FAISSError,
  OpenRouterError,
  ArtifactLoadError,
  ErrorUtils
} from './error_handler.js'

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker
  
  beforeEach(() => {
    circuitBreaker = new CircuitBreaker(3, 60000) // 3 failures, 1 minute reset
    vi.useFakeTimers()
  })
  
  afterEach(() => {
    vi.useRealTimers()
  })
  
  it('should start in closed state', () => {
    expect(circuitBreaker.getState()).toBe('closed')
  })
  
  it('should execute operation successfully when closed', async () => {
    const operation = vi.fn().mockResolvedValue('success')
    
    const result = await circuitBreaker.execute(operation)
    
    expect(result).toBe('success')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(circuitBreaker.getState()).toBe('closed')
  })
  
  it('should open circuit after threshold failures', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Operation failed'))
    
    // Fail 3 times to reach threshold
    for (let i = 0; i < 3; i++) {
      await expect(circuitBreaker.execute(operation)).rejects.toThrow('Operation failed')
    }
    
    expect(circuitBreaker.getState()).toBe('open')
    expect(operation).toHaveBeenCalledTimes(3)
  })
  
  it('should reject immediately when open', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Operation failed'))
    
    // Fail enough times to open circuit
    for (let i = 0; i < 3; i++) {
      await expect(circuitBreaker.execute(operation)).rejects.toThrow('Operation failed')
    }
    
    expect(circuitBreaker.getState()).toBe('open')
    
    // Next call should be rejected immediately
    await expect(circuitBreaker.execute(operation)).rejects.toThrow('Circuit breaker is open')
    expect(operation).toHaveBeenCalledTimes(3) // No additional calls
  })
  
  it('should transition to half-open after timeout', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Operation failed'))
    
    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await expect(circuitBreaker.execute(operation)).rejects.toThrow('Operation failed')
    }
    
    expect(circuitBreaker.getState()).toBe('open')
    
    // Fast forward past reset timeout
    vi.advanceTimersByTime(60001)
    
    // Next call should transition to half-open
    operation.mockResolvedValueOnce('success')
    const result = await circuitBreaker.execute(operation)
    
    expect(result).toBe('success')
    expect(circuitBreaker.getState()).toBe('closed')
  })
  
  it('should reset to closed on successful execution in half-open state', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockRejectedValueOnce(new Error('Fail 3'))
      .mockResolvedValueOnce('success')
    
    // Open circuit
    for (let i = 0; i < 3; i++) {
      await expect(circuitBreaker.execute(operation)).rejects.toThrow()
    }
    
    vi.advanceTimersByTime(60001)
    
    const result = await circuitBreaker.execute(operation)
    expect(result).toBe('success')
    expect(circuitBreaker.getState()).toBe('closed')
  })
})

describe('ErrorHandler', () => {
  let mockContext: ErrorContext
  
  beforeEach(() => {
    vi.clearAllMocks()
    mockContext = {
      component: 'TestComponent',
      operation: 'testOperation',
      metadata: { key: 'value' }
    }
    
    // Mock console methods
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  
  afterEach(() => {
    vi.restoreAllMocks()
  })
  
  describe('withFallback', () => {
    it('should succeed with first operation', async () => {
      const operation1 = vi.fn().mockResolvedValue('success1')
      const operation2 = vi.fn().mockResolvedValue('success2')
      
      const result = await ErrorHandler.withFallback(
        [operation1, operation2],
        mockContext
      )
      
      expect(result).toBe('success1')
      expect(operation1).toHaveBeenCalledTimes(1)
      expect(operation2).not.toHaveBeenCalled()
    })
    
    it('should fallback to second operation when first fails', async () => {
      const operation1 = vi.fn().mockRejectedValue(new Error('Operation 1 failed'))
      const operation2 = vi.fn().mockResolvedValue('success2')
      
      const result = await ErrorHandler.withFallback(
        [operation1, operation2],
        mockContext
      )
      
      expect(result).toBe('success2')
      expect(operation1).toHaveBeenCalledTimes(1)
      expect(operation2).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Succeeded with fallback #1')
      )
    })
    
    it('should retry failed operations with exponential backoff', async () => {
      vi.useFakeTimers()
      
      const operation1 = vi.fn()
        .mockRejectedValueOnce(new Error('Retry 1'))
        .mockRejectedValueOnce(new Error('Retry 2'))
        .mockResolvedValueOnce('success')
      
      const promise = ErrorHandler.withFallback(
        [operation1],
        mockContext,
        { maxRetries: 2, retryDelay: 100 }
      )
      
      // Fast forward timers to handle retries
      vi.runAllTimersAsync()
      
      const result = await promise
      
      expect(result).toBe('success')
      expect(operation1).toHaveBeenCalledTimes(3)
      
      vi.useRealTimers()
    })
    
    it('should throw error when all operations fail', async () => {
      const operation1 = vi.fn().mockRejectedValue(new Error('Operation 1 failed'))
      const operation2 = vi.fn().mockRejectedValue(new Error('Operation 2 failed'))
      
      await expect(
        ErrorHandler.withFallback([operation1, operation2], mockContext)
      ).rejects.toThrow('All fallback operations failed')
      
      expect(operation1).toHaveBeenCalled()
      expect(operation2).toHaveBeenCalled()
    })
    
    it('should handle timeout', async () => {
      const operation = vi.fn().mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 1000))
      )
      
      await expect(
        ErrorHandler.withFallback(
          [operation],
          mockContext,
          { timeout: 100 }
        )
      ).rejects.toThrow('Operation timeout after 100ms')
    })
    
    it('should use custom retry settings', async () => {
      vi.useFakeTimers()
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockRejectedValueOnce(new Error('Fail 3'))
        .mockRejectedValueOnce(new Error('Fail 4'))
        .mockResolvedValueOnce('success')
      
      const options: FallbackOptions = {
        maxRetries: 4,
        retryDelay: 200,
        timeout: 5000
      }
      
      const promise = ErrorHandler.withFallback([operation], mockContext, options)
      
      vi.runAllTimersAsync()
      
      const result = await promise
      
      expect(result).toBe('success')
      expect(operation).toHaveBeenCalledTimes(5)
      
      vi.useRealTimers()
    })
  })
  
  describe('withCircuitBreaker', () => {
    it('should execute operation successfully', async () => {
      const operation = vi.fn().mockResolvedValue('success')
      
      const result = await ErrorHandler.withCircuitBreaker(operation, mockContext)
      
      expect(result).toBe('success')
      expect(operation).toHaveBeenCalledTimes(1)
    })
    
    it('should create circuit breaker per context', async () => {
      const operation1 = vi.fn().mockResolvedValue('success1')
      const operation2 = vi.fn().mockResolvedValue('success2')
      
      const context1 = { component: 'Component1', operation: 'op1' }
      const context2 = { component: 'Component2', operation: 'op2' }
      
      await ErrorHandler.withCircuitBreaker(operation1, context1)
      await ErrorHandler.withCircuitBreaker(operation2, context2)
      
      const states = ErrorHandler.getCircuitBreakerStates()
      
      expect(states['Component1.op1']).toBe('closed')
      expect(states['Component2.op2']).toBe('closed')
    })
    
    it('should reuse existing circuit breaker', async () => {
      const operation = vi.fn().mockResolvedValue('success')
      
      await ErrorHandler.withCircuitBreaker(operation, mockContext)
      await ErrorHandler.withCircuitBreaker(operation, mockContext)
      
      const states = ErrorHandler.getCircuitBreakerStates()
      
      expect(Object.keys(states)).toHaveLength(1)
    })
    
    it('should handle circuit breaker failures', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Operation failed'))
      
      await expect(
        ErrorHandler.withCircuitBreaker(operation, mockContext)
      ).rejects.toThrow('Operation failed')
    })
  })
  
  describe('circuit breaker states', () => {
    it('should return empty states initially', () => {
      const states = ErrorHandler.getCircuitBreakerStates()
      expect(states).toEqual({})
    })
    
    it('should track multiple circuit breakers', async () => {
      const op1 = vi.fn().mockResolvedValue('success')
      const op2 = vi.fn().mockResolvedValue('success')
      
      const context1 = { component: 'Service1', operation: 'method1' }
      const context2 = { component: 'Service2', operation: 'method2' }
      
      await ErrorHandler.withCircuitBreaker(op1, context1)
      await ErrorHandler.withCircuitBreaker(op2, context2)
      
      const states = ErrorHandler.getCircuitBreakerStates()
      
      expect(states).toEqual({
        'Service1.method1': 'closed',
        'Service2.method2': 'closed'
      })
    })
  })
})

describe('Custom Error Classes', () => {
  describe('EmbeddingServiceError', () => {
    it('should create with message', () => {
      const error = new EmbeddingServiceError('Embedding failed')
      
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('EmbeddingServiceError')
      expect(error.message).toBe('Embedding failed')
      expect(error.cause).toBeUndefined()
    })
    
    it('should create with cause', () => {
      const cause = new Error('Network error')
      const error = new EmbeddingServiceError('Embedding failed', cause)
      
      expect(error.cause).toBe(cause)
    })
  })
  
  describe('FAISSError', () => {
    it('should create with message and cause', () => {
      const cause = new Error('Index not found')
      const error = new FAISSError('FAISS operation failed', cause)
      
      expect(error.name).toBe('FAISSError')
      expect(error.message).toBe('FAISS operation failed')
      expect(error.cause).toBe(cause)
    })
  })
  
  describe('OpenRouterError', () => {
    it('should create with status code', () => {
      const error = new OpenRouterError('Rate limit exceeded', 429)
      
      expect(error.name).toBe('OpenRouterError')
      expect(error.message).toBe('Rate limit exceeded')
      expect(error.statusCode).toBe(429)
    })
    
    it('should create with status code and cause', () => {
      const cause = new Error('HTTP error')
      const error = new OpenRouterError('Server error', 500, cause)
      
      expect(error.statusCode).toBe(500)
      expect(error.cause).toBe(cause)
    })
  })
  
  describe('ArtifactLoadError', () => {
    it('should create with message and cause', () => {
      const cause = new Error('File not found')
      const error = new ArtifactLoadError('Failed to load artifact', cause)
      
      expect(error.name).toBe('ArtifactLoadError')
      expect(error.message).toBe('Failed to load artifact')
      expect(error.cause).toBe(cause)
    })
  })
})

describe('ErrorUtils', () => {
  describe('isRetryable', () => {
    it('should identify retryable errors', () => {
      const retryableErrors = [
        new Error('Connection timeout'),
        new Error('Network error occurred'),
        new Error('HTTP 503 Service Unavailable'),
        new Error('HTTP 502 Bad Gateway'),
        new Error('HTTP 500 Internal Server Error'),
        new Error('HTTP 429 Too Many Requests')
      ]
      
      retryableErrors.forEach(error => {
        expect(ErrorUtils.isRetryable(error)).toBe(true)
      })
    })
    
    it('should identify non-retryable errors', () => {
      const nonRetryableErrors = [
        new Error('Invalid request format'),
        new Error('Unauthorized access'),
        new Error('HTTP 404 Not Found'),
        new Error('Validation failed')
      ]
      
      nonRetryableErrors.forEach(error => {
        expect(ErrorUtils.isRetryable(error)).toBe(false)
      })
    })
  })
  
  describe('getStatusCode', () => {
    it('should extract status codes from error messages', () => {
      const testCases = [
        { message: 'HTTP 404 Not Found', expected: 404 },
        { message: 'Server returned 500', expected: 500 },
        { message: 'Status: 429', expected: 429 },
        { message: 'Error 503 occurred', expected: 503 }
      ]
      
      testCases.forEach(({ message, expected }) => {
        const error = new Error(message)
        expect(ErrorUtils.getStatusCode(error)).toBe(expected)
      })
    })
    
    it('should return null for messages without status codes', () => {
      const error = new Error('Network connection failed')
      expect(ErrorUtils.getStatusCode(error)).toBeNull()
    })
  })
  
  describe('createDegradedResponse', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    
    it('should create degraded response with fallback value', () => {
      const fallbackValue = { status: 'degraded', data: null }
      const reason = 'Primary service unavailable'
      
      const result = ErrorUtils.createDegradedResponse(fallbackValue, reason)
      
      expect(result).toBe(fallbackValue)
      expect(console.warn).toHaveBeenCalledWith('Using degraded response: Primary service unavailable')
    })
    
    it('should work with different data types', () => {
      expect(ErrorUtils.createDegradedResponse('fallback', 'test')).toBe('fallback')
      expect(ErrorUtils.createDegradedResponse(42, 'test')).toBe(42)
      expect(ErrorUtils.createDegradedResponse([], 'test')).toEqual([])
    })
  })
})

describe('Integration scenarios', () => {
  let mockContext: ErrorContext
  
  beforeEach(() => {
    mockContext = {
      component: 'IntegrationTest',
      operation: 'complexOperation'
    }
    
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  
  it('should handle mixed fallback and circuit breaker scenario', async () => {
    const primaryOperation = vi.fn().mockRejectedValue(new Error('Primary failed'))
    const fallbackOperation = vi.fn().mockResolvedValue('fallback success')
    
    // First, use circuit breaker with primary operation
    await expect(
      ErrorHandler.withCircuitBreaker(primaryOperation, mockContext)
    ).rejects.toThrow('Primary failed')
    
    // Then use fallback chain
    const result = await ErrorHandler.withFallback(
      [primaryOperation, fallbackOperation],
      mockContext
    )
    
    expect(result).toBe('fallback success')
  })
  
  it('should handle retryable vs non-retryable error classification', async () => {
    const retryableError = new Error('Connection timeout occurred')
    const nonRetryableError = new Error('Invalid authentication token')
    
    expect(ErrorUtils.isRetryable(retryableError)).toBe(true)
    expect(ErrorUtils.isRetryable(nonRetryableError)).toBe(false)
    
    // Could be used to decide retry strategy
    const operation1 = vi.fn().mockRejectedValue(retryableError)
    const operation2 = vi.fn().mockRejectedValue(nonRetryableError)
    
    // Retryable error should be retried
    await expect(
      ErrorHandler.withFallback([operation1], mockContext, { maxRetries: 1 })
    ).rejects.toThrow()
    expect(operation1).toHaveBeenCalledTimes(2) // Initial + 1 retry
    
    // Non-retryable could skip retries (though current implementation doesn't distinguish)
  })
  
  it('should demonstrate comprehensive error handling flow', async () => {
    // Simulate a complex service that might fail
    let attemptCount = 0
    const complexOperation = vi.fn().mockImplementation(() => {
      attemptCount++
      if (attemptCount === 1) {
        throw new EmbeddingServiceError('Embedding service temporarily unavailable')
      } else if (attemptCount === 2) {
        throw new FAISSError('Index corrupted')
      } else if (attemptCount === 3) {
        return 'success after multiple failures'
      }
      throw new Error('Unexpected error')
    })
    
    const fallbackOperation = vi.fn().mockResolvedValue('degraded fallback response')
    
    const result = await ErrorHandler.withFallback(
      [complexOperation, fallbackOperation],
      mockContext,
      { maxRetries: 2 }
    )
    
    expect(result).toBe('success after multiple failures')
    expect(complexOperation).toHaveBeenCalledTimes(3)
    expect(fallbackOperation).not.toHaveBeenCalled()
  })
})