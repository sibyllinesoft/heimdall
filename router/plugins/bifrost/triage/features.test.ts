import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FeatureExtractor, EmbeddingService, ANNIndex, EmbeddingCache } from './features.js'
import type { PreHookRequest, AvengersArtifact, RequestFeatures } from './features.js'

// Mock crypto module
vi.mock('crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => Buffer.from(Array.from({ length: 32 }, (_, i) => i)))
    }))
  }))
}))

// Mock embedding service
class MockEmbeddingService implements EmbeddingService {
  async embed(text: string): Promise<number[]> {
    // Return deterministic embedding based on text length
    const embedding = new Array(384)
    for (let i = 0; i < 384; i++) {
      embedding[i] = (text.length + i) % 10 / 10 - 0.5
    }
    return embedding
  }
}

// Mock ANN index
class MockANNIndex implements ANNIndex {
  async search(embedding: number[], k: number): Promise<{ id: number; distance: number }[]> {
    // Return mock clusters based on embedding values
    const baseDistance = Math.abs(embedding[0] || 0)
    return Array.from({ length: k }, (_, i) => ({
      id: i,
      distance: baseDistance + i * 0.1
    }))
  }
}

// Failing embedding service for error testing
class FailingEmbeddingService implements EmbeddingService {
  async embed(text: string): Promise<number[]> {
    throw new Error('Embedding service failed')
  }
}

// Slow embedding service for timeout testing
class SlowEmbeddingService implements EmbeddingService {
  async embed(text: string): Promise<number[]> {
    await new Promise(resolve => setTimeout(resolve, 100))
    return new Array(384).fill(0.5)
  }
}

describe('FeatureExtractor', () => {
  let extractor: FeatureExtractor
  let mockEmbeddingService: MockEmbeddingService
  let mockANNIndex: MockANNIndex
  let mockArtifact: AvengersArtifact

  beforeEach(() => {
    mockEmbeddingService = new MockEmbeddingService()
    mockANNIndex = new MockANNIndex()
    extractor = new FeatureExtractor(mockEmbeddingService, mockANNIndex)
    
    mockArtifact = {
      version: '2024-01-01',
      centroids: '',
      alpha: 3, // Top 3 clusters
      thresholds: { cheap: 0.62, hard: 0.58 },
      penalties: { latency_sd: 0.05, ctx_over_80pct: 0.15 },
      qhat: {},
      chat: {},
      gbdt: { framework: 'test', model_path: '', feature_schema: {} }
    }

    // Mock console methods to reduce noise
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should create with default services when none provided', () => {
      const defaultExtractor = new FeatureExtractor()
      expect(defaultExtractor).toBeDefined()
    })

    it('should use provided services', () => {
      const customExtractor = new FeatureExtractor(mockEmbeddingService, mockANNIndex)
      expect(customExtractor).toBeDefined()
    })
  })

  describe('extract', () => {
    const createMockRequest = (content: string): PreHookRequest => ({
      url: '/v1/chat/completions',
      method: 'POST',
      headers: { 'authorization': 'Bearer test' },
      body: {
        messages: [{ role: 'user', content }]
      }
    })

    it('should extract basic features successfully', async () => {
      const request = createMockRequest('Hello, how are you?')
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features).toBeDefined()
      expect(features.embedding).toHaveLength(384)
      expect(features.cluster_id).toBeTypeOf('number')
      expect(features.token_count).toBeGreaterThan(0)
      expect(features.context_ratio).toBeGreaterThanOrEqual(0)
      expect(features.context_ratio).toBeLessThanOrEqual(1)
      expect(Array.isArray(features.top_p_distances)).toBe(true)
    })

    it('should detect code in content', async () => {
      const request = createMockRequest('Write a function:\n```python\ndef hello():\n    print("Hello")\n```')
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.has_code).toBe(true)
    })

    it('should detect inline code', async () => {
      const request = createMockRequest('Use the `console.log()` function to debug')
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.has_code).toBe(true)
    })

    it('should detect math content', async () => {
      const request = createMockRequest('Calculate the integral ∫x²dx')
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.has_math).toBe(true)
    })

    it('should detect LaTeX math', async () => {
      const request = createMockRequest('The equation is $E = mc^2$')
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.has_math).toBe(true)
    })

    it('should calculate n-gram entropy', async () => {
      const request = createMockRequest('This is a test message with some variety in the text')
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.ngram_entropy).toBeGreaterThan(0)
      expect(features.ngram_entropy).toBeLessThan(20) // Reasonable upper bound
    })

    it('should calculate context ratio correctly', async () => {
      const longText = 'word '.repeat(30000) // ~120,000 characters = ~30k tokens
      const request = createMockRequest(longText)
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.context_ratio).toBeGreaterThan(0.2)
      expect(features.context_ratio).toBeLessThanOrEqual(1)
    })

    it('should handle empty content', async () => {
      const request = createMockRequest('')
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.token_count).toBe(0)
      expect(features.context_ratio).toBe(0)
      expect(features.has_code).toBe(false)
      expect(features.has_math).toBe(false)
    })

    it('should handle multiple messages', async () => {
      const request: PreHookRequest = {
        url: '/v1/chat/completions',
        method: 'POST',
        headers: { 'authorization': 'Bearer test' },
        body: {
          messages: [
            { role: 'user', content: 'First message' },
            { role: 'assistant', content: 'Assistant response' },
            { role: 'user', content: 'Second user message' }
          ]
        }
      }
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.token_count).toBeGreaterThan(10) // Multiple messages combined
    })

    it('should respect timeout budget', async () => {
      const slowExtractor = new FeatureExtractor(new SlowEmbeddingService(), mockANNIndex)
      const request = createMockRequest('Test message')
      
      const startTime = Date.now()
      await slowExtractor.extract(request, mockArtifact, 50) // 50ms timeout
      const elapsed = Date.now() - startTime
      
      // Should finish relatively quickly even with slow embedding service
      expect(elapsed).toBeLessThan(200)
    })

    it('should return fallback features on error', async () => {
      const failingExtractor = new FeatureExtractor(new FailingEmbeddingService(), mockANNIndex)
      const request = createMockRequest('Test message')
      
      const features = await failingExtractor.extract(request, mockArtifact)
      
      // Should still return valid features structure
      expect(features).toBeDefined()
      expect(features.embedding).toHaveLength(384)
      expect(features.cluster_id).toBe(0) // Fallback cluster
    })

    it('should limit top_p_distances based on alpha', async () => {
      const smallAlphaArtifact = { ...mockArtifact, alpha: 2 }
      const request = createMockRequest('Test message')
      
      const features = await extractor.extract(request, smallAlphaArtifact)
      
      expect(features.top_p_distances.length).toBeLessThanOrEqual(2)
    })

    it('should handle malformed request body', async () => {
      const request: PreHookRequest = {
        url: '/v1/chat/completions',
        method: 'POST',
        headers: { 'authorization': 'Bearer test' },
        body: null
      }
      
      const features = await extractor.extract(request, mockArtifact)
      
      expect(features.token_count).toBe(0)
      expect(features.has_code).toBe(false)
    })
  })

  describe('extractPromptText', () => {
    it('should extract text from messages', () => {
      const request: PreHookRequest = {
        url: '/test',
        method: 'POST',
        headers: {},
        body: {
          messages: [
            { role: 'user', content: 'Message 1' },
            { role: 'assistant', content: 'Message 2' }
          ]
        }
      }
      
      // Access private method through any cast for testing
      const result = (extractor as any).extractPromptText(request)
      
      expect(result).toBe('Message 1\nMessage 2')
    })

    it('should handle empty messages array', () => {
      const request: PreHookRequest = {
        url: '/test',
        method: 'POST',
        headers: {},
        body: { messages: [] }
      }
      
      const result = (extractor as any).extractPromptText(request)
      
      expect(result).toBe('')
    })

    it('should handle missing body', () => {
      const request: PreHookRequest = {
        url: '/test',
        method: 'POST',
        headers: {},
        body: null
      }
      
      const result = (extractor as any).extractPromptText(request)
      
      expect(result).toBe('')
    })
  })

  describe('estimateTokens', () => {
    it('should estimate tokens correctly', () => {
      const text = 'Hello world'
      const tokens = (extractor as any).estimateTokens(text)
      
      expect(tokens).toBe(Math.ceil(text.length / 4))
    })

    it('should handle empty text', () => {
      const tokens = (extractor as any).estimateTokens('')
      
      expect(tokens).toBe(0)
    })
  })

  describe('calculateContextRatio', () => {
    it('should calculate ratio correctly for normal text', () => {
      const ratio = (extractor as any).calculateContextRatio(1000)
      
      expect(ratio).toBeCloseTo(1000 / 128000)
    })

    it('should cap ratio at 1.0', () => {
      const ratio = (extractor as any).calculateContextRatio(200000)
      
      expect(ratio).toBe(1.0)
    })

    it('should handle zero tokens', () => {
      const ratio = (extractor as any).calculateContextRatio(0)
      
      expect(ratio).toBe(0)
    })
  })

  describe('calculateNgramEntropy', () => {
    it('should calculate entropy for text with variety', () => {
      const entropy = (extractor as any).calculateNgramEntropy('abcdefghijk')
      
      expect(entropy).toBeGreaterThan(0)
    })

    it('should return low entropy for repetitive text', () => {
      const entropy = (extractor as any).calculateNgramEntropy('aaaaaaaaaa')
      
      expect(entropy).toBeCloseTo(0, 1)
    })

    it('should handle empty text', () => {
      const entropy = (extractor as any).calculateNgramEntropy('')
      
      expect(entropy).toBe(0)
    })
  })

  describe('getFallbackFeatures', () => {
    it('should return valid fallback features', () => {
      const request = createMockRequest('Test with ```code``` and $math$')
      
      const features = (extractor as any).getFallbackFeatures(request)
      
      expect(features.embedding).toHaveLength(384)
      expect(features.cluster_id).toBe(0)
      expect(features.top_p_distances).toEqual([1.0])
      expect(features.has_code).toBe(true)
      expect(features.has_math).toBe(true)
      expect(features.ngram_entropy).toBe(5.0)
    })

    function createMockRequest(content: string): PreHookRequest {
      return {
        url: '/v1/chat/completions',
        method: 'POST',
        headers: { 'authorization': 'Bearer test' },
        body: {
          messages: [{ role: 'user', content }]
        }
      }
    }
  })

  describe('getStats', () => {
    it('should return embedding cache statistics', () => {
      const stats = extractor.getStats()
      
      expect(stats).toHaveProperty('embeddingCacheStats')
      expect(stats.embeddingCacheStats).toHaveProperty('size')
      expect(stats.embeddingCacheStats).toHaveProperty('hitRate')
    })
  })

  describe('EmbeddingCache', () => {
    let cache: EmbeddingCache

    beforeEach(() => {
      cache = new EmbeddingCache()
    })

    it('should cache and retrieve embeddings', () => {
      const text = 'test text'
      const embedding = [1, 2, 3]
      
      cache.set(text, embedding)
      const retrieved = cache.get(text)
      
      expect(retrieved).toEqual(embedding)
    })

    it('should return undefined for non-existent keys', () => {
      const retrieved = cache.get('non-existent')
      
      expect(retrieved).toBeUndefined()
    })

    it('should track hit rate', () => {
      const text = 'test text'
      const embedding = [1, 2, 3]
      
      cache.set(text, embedding)
      cache.get(text) // Hit
      cache.get('non-existent') // Miss
      
      const stats = cache.getStats()
      expect(stats.hitRate).toBeCloseTo(0.5) // 1 hit out of 2 attempts
    })

    it('should evict old entries when size limit reached', () => {
      // Fill cache to capacity (assuming 1000 limit)
      for (let i = 0; i < 1001; i++) {
        cache.set(`text-${i}`, [i])
      }
      
      // First entry should be evicted
      expect(cache.get('text-0')).toBeUndefined()
      expect(cache.get('text-1000')).toEqual([1000])
    })
  })

  describe('integration scenarios', () => {
    it('should handle complete feature extraction pipeline', async () => {
      const request: PreHookRequest = {
        url: '/v1/chat/completions',
        method: 'POST',
        headers: { 'authorization': 'Bearer test' },
        body: {
          messages: [
            {
              role: 'user',
              content: `Write a Python function to solve this math problem:
              
Calculate the derivative of f(x) = x² + 2x + 1

\`\`\`python
def derivative(x):
    # Your code here
    pass
\`\`\``
            }
          ]
        }
      }
      
      const features = await extractor.extract(request, mockArtifact)
      
      // Should detect both code and math
      expect(features.has_code).toBe(true)
      expect(features.has_math).toBe(true)
      
      // Should have reasonable token count
      expect(features.token_count).toBeGreaterThan(20)
      
      // Should have valid embedding
      expect(features.embedding).toHaveLength(384)
      expect(features.embedding.every(x => typeof x === 'number')).toBe(true)
      
      // Should have cluster information
      expect(features.cluster_id).toBeGreaterThanOrEqual(0)
      expect(features.top_p_distances.length).toBeGreaterThan(0)
      
      // Should have positive entropy
      expect(features.ngram_entropy).toBeGreaterThan(0)
    })

    it('should handle caching across multiple extractions', async () => {
      const request1 = createMockRequest('Same message')
      const request2 = createMockRequest('Same message')
      
      // First extraction
      const features1 = await extractor.extract(request1, mockArtifact)
      
      // Second extraction should use cached embedding
      const features2 = await extractor.extract(request2, mockArtifact)
      
      expect(features1.embedding).toEqual(features2.embedding)
      
      const stats = extractor.getStats()
      expect(stats.embeddingCacheStats.hitRate).toBeGreaterThan(0)
    })

    function createMockRequest(content: string): PreHookRequest {
      return {
        url: '/v1/chat/completions',
        method: 'POST',
        headers: { 'authorization': 'Bearer test' },
        body: {
          messages: [{ role: 'user', content }]
        }
      }
    }
  })
})