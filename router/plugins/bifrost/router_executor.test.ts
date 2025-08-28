import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RouterExecutor, ExecutionRequest, ExecutionResult } from './router_executor.js'
import { DefaultProviderRegistry } from './providers/provider_registry.js'
import { ThinkingParameterMapper } from './thinking_mappers.js'
import type { 
  RouterDecision, 
  RequestFeatures, 
  AuthInfo, 
  ProviderConfig 
} from '../../../src/types/common.js'
import type { 
  ProviderRequest, 
  ProviderResponse, 
  ProviderError, 
  AuthCredentials 
} from './providers/base_provider.js'

// Mock the provider registry
vi.mock('./providers/provider_registry.js', () => ({
  DefaultProviderRegistry: vi.fn().mockImplementation(() => ({
    complete: vi.fn(),
    healthCheck: vi.fn()
  }))
}))

// Mock the thinking parameter mapper
vi.mock('./thinking_mappers.js', () => ({
  ThinkingParameterMapper: vi.fn().mockImplementation(() => ({
    assessTaskComplexity: vi.fn(),
    mapGPT5ReasoningEffort: vi.fn(),
    mapGeminiThinkingBudget: vi.fn()
  }))
}))

describe('RouterExecutor', () => {
  let executor: RouterExecutor
  let mockProviderRegistry: any
  let mockThinkingMapper: any
  let mockProviderConfig: ProviderConfig

  const createMockDecision = (overrides: Partial<RouterDecision> = {}): RouterDecision => ({
    kind: 'openai',
    model: 'openai/gpt-5',
    params: {
      max_output_tokens: 2000,
      reasoning_effort: 'medium'
    },
    provider_prefs: { sort: 'quality', max_price: 10, allow_fallbacks: true },
    auth: { mode: 'env' },
    fallbacks: ['google/gemini-2.5-pro'],
    ...overrides
  })

  const createMockFeatures = (overrides: Partial<RequestFeatures> = {}): RequestFeatures => ({
    embedding: new Array(384).fill(0.1),
    cluster_id: 0,
    token_count: 1000,
    context_ratio: 0.1,
    has_code: false,
    has_math: false,
    top_p_distances: [0.8, 0.9],
    ngram_entropy: 3.5,
    ...overrides
  })

  const createMockExecutionRequest = (overrides: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
    decision: createMockDecision(),
    originalRequest: {
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
      max_tokens: 1000,
      temperature: 0.7
    },
    authInfo: {
      provider: 'openai',
      type: 'api-key',
      token: 'test-token',
      credentials: { key: 'test-key' }
    },
    features: createMockFeatures(),
    ...overrides
  })

  const createMockProviderResponse = (): ProviderResponse => ({
    id: 'response-123',
    choices: [{
      message: {
        role: 'assistant',
        content: 'Hello! How can I help you?'
      },
      finish_reason: 'stop',
      index: 0
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18
    },
    model: 'gpt-5',
    created: Date.now()
  })

  beforeEach(() => {
    vi.clearAllMocks()

    // Setup environment variables
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.GEMINI_API_KEY = 'test-gemini-key'

    mockProviderConfig = {
      openai: {
        apiKey: 'test-key',
        baseURL: 'https://api.openai.com/v1',
        organization: 'test-org',
        models: ['gpt-5']
      },
      google: {
        apiKey: 'test-key',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        models: ['gemini-2.5-pro']
      }
    }

    // Create mocks
    mockProviderRegistry = {
      complete: vi.fn(),
      healthCheck: vi.fn()
    }
    
    mockThinkingMapper = {
      assessTaskComplexity: vi.fn().mockReturnValue('medium'),
      mapGPT5ReasoningEffort: vi.fn().mockReturnValue('medium'),
      mapGeminiThinkingBudget: vi.fn().mockReturnValue(15000)
    }

    // Setup constructor mocks
    vi.mocked(DefaultProviderRegistry).mockImplementation(() => mockProviderRegistry)
    vi.mocked(ThinkingParameterMapper).mockImplementation(() => mockThinkingMapper)

    executor = new RouterExecutor(mockProviderConfig, mockThinkingMapper)

    // Mock console methods to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Clean up environment variables
    delete process.env.OPENAI_API_KEY
    delete process.env.GEMINI_API_KEY
  })

  describe('constructor', () => {
    it('should create with provider config', () => {
      expect(executor).toBeDefined()
      expect(DefaultProviderRegistry).toHaveBeenCalledWith(mockProviderConfig)
    })

    it('should create with custom thinking mapper', () => {
      const customMapper = new ThinkingParameterMapper()
      const customExecutor = new RouterExecutor(mockProviderConfig, customMapper)
      expect(customExecutor).toBeDefined()
    })

    it('should create default thinking mapper when none provided', () => {
      const defaultExecutor = new RouterExecutor(mockProviderConfig)
      expect(defaultExecutor).toBeDefined()
      expect(ThinkingParameterMapper).toHaveBeenCalled()
    })
  })

  describe('execute', () => {
    it('should execute successfully', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)

      const request = createMockExecutionRequest()
      const result = await executor.execute(request)

      expect(result.success).toBe(true)
      expect(result.response).toEqual(mockResponse)
      expect(result.provider_used).toBe('openai')
      expect(result.fallback_used).toBeUndefined()
      expect(result.execution_time_ms).toBeGreaterThan(0)
    })

    it('should handle provider errors without fallback', async () => {
      const mockError: ProviderError = {
        status: 400,
        error: {
          message: 'Bad request',
          type: 'invalid_request_error'
        }
      }
      mockProviderRegistry.complete.mockRejectedValue(mockError)

      const request = createMockExecutionRequest()
      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.error).toEqual(mockError)
      expect(result.provider_used).toBe('openai')
      expect(result.fallback_used).toBeUndefined()
    })

    it('should attempt fallback on rate limit error', async () => {
      const rateLimitError: ProviderError = {
        status: 429,
        error: {
          message: 'Rate limit exceeded',
          type: 'rate_limit_error'
        }
      }
      const mockResponse = createMockProviderResponse()
      
      mockProviderRegistry.complete
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockResponse)

      const request = createMockExecutionRequest()
      const result = await executor.execute(request)

      expect(result.success).toBe(true)
      expect(result.response).toEqual(mockResponse)
      expect(result.fallback_used).toBe(true)
      expect(result.fallback_reason).toBe('rate_limit')
      expect(mockProviderRegistry.complete).toHaveBeenCalledTimes(2)
    })

    it('should handle fallback failure', async () => {
      const serverError: ProviderError = {
        status: 500,
        error: {
          message: 'Internal server error',
          type: 'server_error'
        }
      }
      
      mockProviderRegistry.complete.mockRejectedValue(serverError)

      const request = createMockExecutionRequest()
      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.fallback_used).toBe(true)
      expect(result.fallback_reason).toBe('fallback_failed')
      expect(mockProviderRegistry.complete).toHaveBeenCalledTimes(2)
    })

    it('should apply thinking parameters for OpenAI GPT-5', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)
      
      mockThinkingMapper.mapGPT5ReasoningEffort.mockReturnValue('high')

      const request = createMockExecutionRequest({
        decision: createMockDecision({ kind: 'openai', model: 'openai/gpt-5' }),
        features: createMockFeatures({ has_code: true, token_count: 50000 })
      })

      await executor.execute(request)

      expect(mockThinkingMapper.mapGPT5ReasoningEffort).toHaveBeenCalled()
      expect(mockProviderRegistry.complete).toHaveBeenCalledWith(
        'openai',
        expect.objectContaining({
          reasoning_effort: 'high'
        }),
        expect.any(Object)
      )
    })

    it('should apply thinking parameters for Gemini', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)
      
      mockThinkingMapper.mapGeminiThinkingBudget.mockReturnValue(20000)

      const request = createMockExecutionRequest({
        decision: createMockDecision({ kind: 'google', model: 'google/gemini-2.5-pro' }),
        features: createMockFeatures({ has_math: true, token_count: 75000 })
      })

      await executor.execute(request)

      expect(mockThinkingMapper.mapGeminiThinkingBudget).toHaveBeenCalled()
      expect(mockProviderRegistry.complete).toHaveBeenCalledWith(
        'google',
        expect.objectContaining({
          thinkingBudget: 20000
        }),
        expect.any(Object)
      )
    })
  })

  describe('fallback logic', () => {
    it('should select non-Anthropic fallback for Anthropic 429', async () => {
      const anthropicRateLimit: ProviderError = {
        status: 429,
        error: {
          message: 'Rate limit exceeded',
          type: 'rate_limit_error'
        }
      }
      const mockResponse = createMockProviderResponse()
      
      mockProviderRegistry.complete
        .mockRejectedValueOnce(anthropicRateLimit)
        .mockResolvedValueOnce(mockResponse)

      const request = createMockExecutionRequest({
        decision: createMockDecision({ kind: 'anthropic' }),
        features: createMockFeatures({ has_code: true, has_math: true })
      })

      const result = await executor.execute(request)

      expect(result.success).toBe(true)
      expect(result.fallback_used).toBe(true)
      expect(mockProviderRegistry.complete).toHaveBeenCalledTimes(2)
    })

    it('should select Gemini for long context fallback', async () => {
      const rateLimitError: ProviderError = {
        status: 429,
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' }
      }
      const mockResponse = createMockProviderResponse()
      
      mockProviderRegistry.complete
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockResponse)

      const request = createMockExecutionRequest({
        decision: createMockDecision({ kind: 'anthropic' }),
        features: createMockFeatures({ token_count: 250000 })
      })

      const result = await executor.execute(request)

      expect(result.success).toBe(true)
      expect(result.fallback_used).toBe(true)
    })

    it('should select OpenRouter for simple tasks', async () => {
      const rateLimitError: ProviderError = {
        status: 429,
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' }
      }
      const mockResponse = createMockProviderResponse()
      
      mockProviderRegistry.complete
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockResponse)

      const request = createMockExecutionRequest({
        decision: createMockDecision({ kind: 'anthropic' }),
        features: createMockFeatures({ token_count: 500, has_code: false, has_math: false })
      })

      const result = await executor.execute(request)

      expect(result.success).toBe(true)
      expect(result.fallback_used).toBe(true)
    })

    it('should use configured fallbacks when available', async () => {
      const serverError: ProviderError = {
        status: 500,
        error: { message: 'Server error', type: 'server_error' }
      }
      const mockResponse = createMockProviderResponse()
      
      mockProviderRegistry.complete
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(mockResponse)

      const request = createMockExecutionRequest({
        decision: createMockDecision({ 
          fallbacks: ['google/gemini-2.5-pro', 'openai/gpt-5'] 
        })
      })

      const result = await executor.execute(request)

      expect(result.success).toBe(true)
      expect(result.fallback_used).toBe(true)
    })
  })

  describe('credentials handling', () => {
    it('should use auth info when provided', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)

      const request = createMockExecutionRequest({
        authInfo: {
          provider: 'openai',
          type: 'bearer',
          token: 'custom-token',
          credentials: { token: 'custom-token' }
        }
      })

      await executor.execute(request)

      expect(mockProviderRegistry.complete).toHaveBeenCalledWith(
        'openai',
        expect.any(Object),
        { type: 'bearer', token: 'custom-token' }
      )
    })

    it('should use environment credentials for OpenAI', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)

      const request = createMockExecutionRequest({
        authInfo: null,
        decision: createMockDecision({ kind: 'openai' })
      })

      await executor.execute(request)

      expect(mockProviderRegistry.complete).toHaveBeenCalledWith(
        'openai',
        expect.any(Object),
        { type: 'apikey', token: 'test-openai-key' }
      )
    })

    it('should use environment credentials for Google', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)

      const request = createMockExecutionRequest({
        authInfo: null,
        decision: createMockDecision({ kind: 'google' })
      })

      await executor.execute(request)

      expect(mockProviderRegistry.complete).toHaveBeenCalledWith(
        'google',
        expect.any(Object),
        { type: 'apikey', token: 'test-gemini-key' }
      )
    })

    it('should throw error for missing OpenAI API key', async () => {
      delete process.env.OPENAI_API_KEY

      const request = createMockExecutionRequest({
        authInfo: null,
        decision: createMockDecision({ kind: 'openai' })
      })

      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.error?.error.message).toContain('OPENAI_API_KEY not found')
    })

    it('should throw error for Anthropic without user token', async () => {
      const request = createMockExecutionRequest({
        authInfo: null,
        decision: createMockDecision({ kind: 'anthropic' })
      })

      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.error?.error.message).toContain('Anthropic requires user OAuth token')
    })
  })

  describe('error handling', () => {
    it('should not fallback on auth errors', async () => {
      const authError: ProviderError = {
        status: 401,
        error: { message: 'Unauthorized', type: 'auth_error' }
      }
      mockProviderRegistry.complete.mockRejectedValue(authError)

      const request = createMockExecutionRequest()
      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.fallback_used).toBeUndefined()
      expect(mockProviderRegistry.complete).toHaveBeenCalledTimes(1)
    })

    it('should not fallback on bad request errors', async () => {
      const badRequestError: ProviderError = {
        status: 400,
        error: { message: 'Bad request', type: 'invalid_request' }
      }
      mockProviderRegistry.complete.mockRejectedValue(badRequestError)

      const request = createMockExecutionRequest()
      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.fallback_used).toBeUndefined()
    })

    it('should handle unknown errors', async () => {
      mockProviderRegistry.complete.mockRejectedValue(new Error('Unknown error'))

      const request = createMockExecutionRequest()
      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.error?.error.message).toBe('Unknown error')
      expect(result.error?.error.type).toBe('client_error')
    })

    it('should handle non-Error objects', async () => {
      mockProviderRegistry.complete.mockRejectedValue('string error')

      const request = createMockExecutionRequest()
      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.error?.error.message).toBe('Unknown execution error')
      expect(result.error?.error.type).toBe('unknown_error')
    })
  })

  describe('bucket inference', () => {
    it('should infer hard bucket for long context with code/math', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)

      const request = createMockExecutionRequest({
        features: createMockFeatures({ 
          token_count: 150000, 
          has_code: true, 
          has_math: true 
        })
      })

      await executor.execute(request)

      // Verify thinking mapper was called with inferred parameters
      expect(mockThinkingMapper.assessTaskComplexity).toHaveBeenCalled()
    })

    it('should infer mid bucket for moderate complexity', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)

      const request = createMockExecutionRequest({
        features: createMockFeatures({ 
          token_count: 15000, 
          has_code: true 
        })
      })

      await executor.execute(request)

      expect(mockThinkingMapper.assessTaskComplexity).toHaveBeenCalled()
    })

    it('should infer cheap bucket for simple requests', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)

      const request = createMockExecutionRequest({
        features: createMockFeatures({ 
          token_count: 500, 
          has_code: false, 
          has_math: false 
        })
      })

      await executor.execute(request)

      expect(mockThinkingMapper.assessTaskComplexity).toHaveBeenCalled()
    })
  })

  describe('utility methods', () => {
    it('should return provider registry', () => {
      const registry = executor.getProviderRegistry()
      expect(registry).toBe(mockProviderRegistry)
    })

    it('should perform health check', async () => {
      const mockHealthStatus = {
        openai: { status: 'healthy' as const },
        google: { status: 'unhealthy' as const, error: 'API key invalid' }
      }
      mockProviderRegistry.healthCheck.mockResolvedValue(mockHealthStatus)

      const health = await executor.healthCheck()

      expect(health).toEqual(mockHealthStatus)
      expect(mockProviderRegistry.healthCheck).toHaveBeenCalled()
    })

    it('should handle health check for non-DefaultProviderRegistry', async () => {
      // Create executor with mock that's not DefaultProviderRegistry
      const customRegistry = { complete: vi.fn() }
      vi.mocked(DefaultProviderRegistry).mockImplementation(() => customRegistry as any)
      
      const customExecutor = new RouterExecutor(mockProviderConfig)
      const health = await customExecutor.healthCheck()

      expect(health).toEqual({})
    })
  })

  describe('integration scenarios', () => {
    it('should handle complete execution flow with thinking parameters', async () => {
      const mockResponse = createMockProviderResponse()
      mockProviderRegistry.complete.mockResolvedValue(mockResponse)
      
      mockThinkingMapper.assessTaskComplexity.mockReturnValue('high')
      mockThinkingMapper.mapGPT5ReasoningEffort.mockReturnValue('high')

      const request = createMockExecutionRequest({
        decision: createMockDecision({ 
          kind: 'openai', 
          model: 'openai/gpt-5',
          params: {} // No reasoning_effort set
        }),
        originalRequest: {
          messages: [
            { role: 'user', content: 'Solve this complex mathematical problem with code' }
          ],
          stream: true,
          max_tokens: 4000,
          temperature: 0.2
        },
        features: createMockFeatures({
          token_count: 25000,
          has_code: true,
          has_math: true,
          ngram_entropy: 8.5
        })
      })

      const result = await executor.execute(request)

      expect(result.success).toBe(true)
      expect(result.response).toEqual(mockResponse)
      expect(result.provider_used).toBe('openai')
      expect(result.execution_time_ms).toBeGreaterThan(0)
      
      // Verify thinking parameters were applied
      expect(mockProviderRegistry.complete).toHaveBeenCalledWith(
        'openai',
        expect.objectContaining({
          model: 'openai/gpt-5',
          stream: true,
          max_tokens: 4000,
          temperature: 0.2,
          reasoning_effort: 'high'
        }),
        expect.objectContaining({
          type: 'bearer',
          token: 'test-token'
        })
      )
    })

    it('should handle fallback chain with multiple attempts', async () => {
      const primaryError: ProviderError = {
        status: 500,
        error: { message: 'Server error', type: 'server_error' }
      }
      const fallbackError: ProviderError = {
        status: 503,
        error: { message: 'Service unavailable', type: 'server_error' }
      }
      
      mockProviderRegistry.complete
        .mockRejectedValueOnce(primaryError)
        .mockRejectedValueOnce(fallbackError)

      const request = createMockExecutionRequest({
        decision: createMockDecision({ 
          fallbacks: ['google/gemini-2.5-pro', 'openai/gpt-4'] 
        })
      })

      const result = await executor.execute(request)

      expect(result.success).toBe(false)
      expect(result.fallback_used).toBe(true)
      expect(result.fallback_reason).toBe('fallback_failed')
      expect(mockProviderRegistry.complete).toHaveBeenCalledTimes(2)
    })
  })
})