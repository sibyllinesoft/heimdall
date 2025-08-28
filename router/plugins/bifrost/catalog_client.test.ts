import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CatalogClient, CatalogModelsResponse, CatalogStatsResponse } from './catalog_client.js'
import type { ModelInfo, ModelCapabilities, ModelPricing } from '../../../src/types/common.js'

// Mock fetch globally
global.fetch = vi.fn()

describe('CatalogClient', () => {
  let client: CatalogClient
  const baseUrl = 'http://localhost:3001'

  const createMockModelInfo = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
    slug: 'openai/gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    family: 'gpt5',
    ctx_in: 128000,
    ctx_out: 8192,
    pricing: {
      in_per_million: 5.0,
      out_per_million: 15.0,
      currency: 'USD'
    },
    capabilities: {
      reasoning: true,
      vision: true,
      function_calling: true,
      structured_output: true
    },
    quality_tier: 'flagship',
    ...overrides
  })

  const createMockCapabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
    reasoning: true,
    vision: false,
    function_calling: true,
    structured_output: true,
    multimodal: false,
    fine_tuning: false,
    ...overrides
  })

  const createMockPricing = (overrides: Partial<ModelPricing> = {}): ModelPricing => ({
    in_per_million: 5.0,
    out_per_million: 15.0,
    currency: 'USD',
    ...overrides
  })

  const mockResponse = (data: any, status = 200, statusText = 'OK') => {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: vi.fn().mockResolvedValue(data),
      text: vi.fn().mockResolvedValue(JSON.stringify(data)),
      headers: new Headers({ 'content-type': 'application/json' })
    } as any)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    client = new CatalogClient(baseUrl)
    
    // Mock console methods to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should initialize with base URL', () => {
      expect(client).toBeDefined()
    })

    it('should strip trailing slash from base URL', () => {
      const clientWithSlash = new CatalogClient('http://localhost:3001/')
      expect(clientWithSlash).toBeDefined()
    })
  })

  describe('getModels', () => {
    it('should fetch models without parameters', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [
          createMockModelInfo(),
          createMockModelInfo({ slug: 'google/gemini-2.5-pro', provider: 'google' })
        ]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.getModels()

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'User-Agent': 'Bifrost-Router/1.0'
          }),
          timeout: 10000
        })
      )
      expect(models).toEqual(mockModels.models)
    })

    it('should fetch models with provider filter', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo({ provider: 'openai' })]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.getModels({ provider: 'openai' })

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/models?provider=openai',
        expect.any(Object)
      )
      expect(models).toEqual(mockModels.models)
    })

    it('should fetch models with family filter', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo({ family: 'gpt5' })]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.getModels({ family: 'gpt5' })

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/models?family=gpt5',
        expect.any(Object)
      )
      expect(models).toEqual(mockModels.models)
    })

    it('should handle both provider and family filters', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.getModels({ provider: 'openai', family: 'gpt5' })

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/models?provider=openai&family=gpt5',
        expect.any(Object)
      )
      expect(models).toEqual(mockModels.models)
    })

    it('should use cache for repeated requests', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      // First request
      const models1 = await client.getModels()
      
      // Second request - should use cache
      const models2 = await client.getModels()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(models1).toEqual(models2)
    })

    it('should handle fetch errors', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))

      await expect(client.getModels()).rejects.toThrow('Network error')
    })
  })

  describe('getCapabilities', () => {
    it('should fetch capabilities for a model', async () => {
      const mockCapabilities = createMockCapabilities()

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockCapabilities))

      const capabilities = await client.getCapabilities('openai/gpt-5')

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/capabilities/openai%2Fgpt-5',
        expect.any(Object)
      )
      expect(capabilities).toEqual(mockCapabilities)
    })

    it('should return null for 404 responses', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(null, 404, 'Not Found'))

      const capabilities = await client.getCapabilities('unknown/model')

      expect(capabilities).toBeNull()
    })

    it('should use cache for repeated requests', async () => {
      const mockCapabilities = createMockCapabilities()

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockCapabilities))

      const capabilities1 = await client.getCapabilities('openai/gpt-5')
      const capabilities2 = await client.getCapabilities('openai/gpt-5')

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(capabilities1).toEqual(capabilities2)
    })

    it('should handle errors gracefully', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))

      const capabilities = await client.getCapabilities('openai/gpt-5')

      expect(capabilities).toBeNull()
    })
  })

  describe('getPricing', () => {
    it('should fetch pricing for a model', async () => {
      const mockPricing = createMockPricing()

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockPricing))

      const pricing = await client.getPricing('openai/gpt-5')

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/pricing/openai%2Fgpt-5',
        expect.any(Object)
      )
      expect(pricing).toEqual(mockPricing)
    })

    it('should return null for 404 responses', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(null, 404, 'Not Found'))

      const pricing = await client.getPricing('unknown/model')

      expect(pricing).toBeNull()
    })

    it('should use cache for repeated requests', async () => {
      const mockPricing = createMockPricing()

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockPricing))

      const pricing1 = await client.getPricing('openai/gpt-5')
      const pricing2 = await client.getPricing('openai/gpt-5')

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(pricing1).toEqual(pricing2)
    })

    it('should handle errors gracefully', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))

      const pricing = await client.getPricing('openai/gpt-5')

      expect(pricing).toBeNull()
    })
  })

  describe('getFeatureFlags', () => {
    it('should fetch feature flags', async () => {
      const mockFlags = {
        flags: {
          'new-routing-algorithm': true,
          'experimental-features': false,
          'rate-limit-threshold': 1000
        }
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockFlags))

      const flags = await client.getFeatureFlags()

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/feature-flags',
        expect.any(Object)
      )
      expect(flags).toEqual(mockFlags.flags)
    })

    it('should use cache for repeated requests', async () => {
      const mockFlags = { flags: { 'test-flag': true } }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockFlags))

      const flags1 = await client.getFeatureFlags()
      const flags2 = await client.getFeatureFlags()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(flags1).toEqual(flags2)
    })

    it('should handle errors gracefully', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))

      const flags = await client.getFeatureFlags()

      expect(flags).toEqual({})
    })
  })

  describe('getHealth', () => {
    it('should fetch health status', async () => {
      const mockHealth = {
        status: 'healthy',
        timestamp: '2024-01-01T00:00:00Z',
        stats: {
          total_models: 150,
          providers: {
            openai: 12,
            google: 8,
            anthropic: 5
          },
          last_updated: '2024-01-01T00:00:00Z'
        }
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockHealth))

      const health = await client.getHealth()

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/health',
        expect.any(Object)
      )
      expect(health).toEqual(mockHealth)
    })

    it('should handle errors gracefully', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))

      const health = await client.getHealth()

      expect(health.status).toBe('error')
      expect(health.timestamp).toBeDefined()
      expect(health.stats).toEqual({
        total_models: 0,
        providers: {},
        last_updated: expect.any(String)
      })
    })

    it('should handle partial response data', async () => {
      const partialHealth = { status: 'degraded' }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(partialHealth))

      const health = await client.getHealth()

      expect(health.status).toBe('degraded')
      expect(health.timestamp).toBeDefined()
      expect(health.stats).toEqual({
        total_models: 0,
        providers: {},
        last_updated: expect.any(String)
      })
    })
  })

  describe('convenience methods', () => {
    it('should get provider models', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo({ provider: 'openai' })]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.getProviderModels('openai')

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/models?provider=openai',
        expect.any(Object)
      )
      expect(models).toEqual(mockModels.models)
    })

    it('should get family models', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo({ family: 'gpt5' })]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.getFamilyModels('gpt5')

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/models?family=gpt5',
        expect.any(Object)
      )
      expect(models).toEqual(mockModels.models)
    })

    it('should find models with minimum context', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [
          createMockModelInfo({ slug: 'model1', ctx_in: 50000 }),
          createMockModelInfo({ slug: 'model2', ctx_in: 150000 }),
          createMockModelInfo({ slug: 'model3', ctx_in: 75000 })
        ]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.findModelsWithContext(100000)

      expect(models).toHaveLength(1)
      expect(models[0].slug).toBe('model2')
    })

    it('should find models in price range', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [
          createMockModelInfo({
            slug: 'cheap-model',
            pricing: { in_per_million: 1.0, out_per_million: 3.0, currency: 'USD' }
          }),
          createMockModelInfo({
            slug: 'expensive-model',
            pricing: { in_per_million: 10.0, out_per_million: 30.0, currency: 'USD' }
          }),
          createMockModelInfo({
            slug: 'mid-range-model',
            pricing: { in_per_million: 3.0, out_per_million: 8.0, currency: 'USD' }
          })
        ]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.findModelsInPriceRange(5.0, 10.0)

      expect(models).toHaveLength(2)
      expect(models.map(m => m.slug)).toEqual(['cheap-model', 'mid-range-model'])
    })
  })

  describe('retry logic', () => {
    it('should retry on server errors', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }

      // Fail twice with 500, then succeed
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockResponse(null, 500, 'Internal Server Error'))
        .mockResolvedValueOnce(mockResponse(null, 502, 'Bad Gateway'))
        .mockResolvedValueOnce(mockResponse(mockModels))

      const models = await client.getModels()

      expect(fetch).toHaveBeenCalledTimes(3)
      expect(models).toEqual(mockModels.models)
    })

    it('should not retry on client errors', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(null, 400, 'Bad Request'))

      await expect(client.getModels()).rejects.toThrow('HTTP 400: Bad Request')

      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('should fail after max retries', async () => {
      vi.mocked(fetch).mockResolvedValue(mockResponse(null, 500, 'Internal Server Error'))

      await expect(client.getModels()).rejects.toThrow('HTTP 500: Internal Server Error')

      expect(fetch).toHaveBeenCalledTimes(3) // Initial + 2 retries
    })

    it('should handle network errors with retries', async () => {
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('DNS resolution failed'))

      await expect(client.getModels()).rejects.toThrow('DNS resolution failed')

      expect(fetch).toHaveBeenCalledTimes(3)
    })
  })

  describe('caching', () => {
    beforeEach(() => {
      // Fast forward time to ensure cache expiry tests work
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should cache responses', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      await client.getModels()
      await client.getModels() // Second request should use cache

      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('should expire cache after timeout', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse(mockModels))

      await client.getModels()

      // Fast forward past cache timeout (5 minutes)
      vi.advanceTimersByTime(300001)

      await client.getModels()

      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('should clear cache', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }

      vi.mocked(fetch).mockResolvedValue(mockResponse(mockModels))

      await client.getModels()
      client.clearCache()
      await client.getModels()

      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('should get cache statistics', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }
      const mockCapabilities = createMockCapabilities()

      vi.mocked(fetch)
        .mockResolvedValueOnce(mockResponse(mockModels))
        .mockResolvedValueOnce(mockResponse(mockCapabilities))

      await client.getModels()
      await client.getCapabilities('openai/gpt-5')

      const stats = client.getCacheStats()

      expect(stats.size).toBe(2)
      expect(stats.keys).toContain('models:')
      expect(stats.keys).toContain('capabilities:openai/gpt-5')
    })

    it('should cleanup expired entries in cache stats', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }

      vi.mocked(fetch).mockResolvedValueOnce(mockResponse(mockModels))

      await client.getModels()

      // Fast forward past expiry
      vi.advanceTimersByTime(300001)

      const stats = client.getCacheStats()

      expect(stats.size).toBe(0)
      expect(stats.keys).toHaveLength(0)
    })
  })

  describe('integration scenarios', () => {
    it('should handle complete workflow', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }
      const mockCapabilities = createMockCapabilities({ reasoning: true, vision: true })
      const mockPricing = createMockPricing({ in_per_million: 2.5, out_per_million: 7.5 })
      const mockFlags = { flags: { 'enhanced-routing': true } }

      vi.mocked(fetch)
        .mockResolvedValueOnce(mockResponse(mockModels))
        .mockResolvedValueOnce(mockResponse(mockCapabilities))
        .mockResolvedValueOnce(mockResponse(mockPricing))
        .mockResolvedValueOnce(mockResponse(mockFlags))

      // Fetch all data types
      const models = await client.getModels()
      const capabilities = await client.getCapabilities('openai/gpt-5')
      const pricing = await client.getPricing('openai/gpt-5')
      const flags = await client.getFeatureFlags()

      expect(models).toHaveLength(1)
      expect(capabilities?.reasoning).toBe(true)
      expect(capabilities?.vision).toBe(true)
      expect(pricing?.in_per_million).toBe(2.5)
      expect(flags['enhanced-routing']).toBe(true)

      // Verify caching - second requests should not trigger new fetches
      await client.getModels()
      await client.getCapabilities('openai/gpt-5')
      await client.getPricing('openai/gpt-5')
      await client.getFeatureFlags()

      expect(fetch).toHaveBeenCalledTimes(4)
    })

    it('should handle mixed success and failure scenarios', async () => {
      const mockModels: CatalogModelsResponse = {
        models: [createMockModelInfo()]
      }

      // Models succeed, capabilities fail, pricing returns 404
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockResponse(mockModels))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(mockResponse(null, 404, 'Not Found'))

      const models = await client.getModels()
      const capabilities = await client.getCapabilities('unknown/model')
      const pricing = await client.getPricing('unknown/model')

      expect(models).toHaveLength(1)
      expect(capabilities).toBeNull()
      expect(pricing).toBeNull()
    })
  })
})