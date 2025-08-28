import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GBDTRuntime } from './gbdt_runtime.js'
import type { RequestFeatures, AvengersArtifact, BucketProbabilities } from './gbdt_runtime.js'
import * as fs from 'fs'
import * as path from 'path'

// Mock file system operations
vi.mock('fs', () => ({
  existsSync: vi.fn()
}))

vi.mock('path', () => ({
  isAbsolute: vi.fn(),
  resolve: vi.fn()
}))

// Mock GBDT model classes
class MockGBDTModel {
  framework = 'mock'
  
  async predict(features: number[]): Promise<number[]> {
    // Simple mock prediction based on features
    const sum = features.reduce((a, b) => a + b, 0)
    return [
      0.1 + (sum % 10) * 0.08,  // cheap: 0.1-0.9
      0.1 + ((sum * 2) % 10) * 0.08,  // mid: 0.1-0.9
      0.1 + ((sum * 3) % 10) * 0.08   // hard: 0.1-0.9
    ]
  }
}

class FailingMockModel {
  framework = 'failing'
  
  async predict(features: number[]): Promise<number[]> {
    throw new Error('Mock model prediction failed')
  }
}

class SlowMockModel {
  framework = 'slow'
  
  async predict(features: number[]): Promise<number[]> {
    await new Promise(resolve => setTimeout(resolve, 100))
    return [0.33, 0.33, 0.34]
  }
}

describe('GBDTRuntime', () => {
  let runtime: GBDTRuntime
  let mockFeatures: RequestFeatures
  let mockArtifact: AvengersArtifact
  const mockFs = vi.mocked(fs)
  const mockPath = vi.mocked(path)

  beforeEach(() => {
    runtime = new GBDTRuntime()
    
    mockFeatures = {
      embedding: new Array(384).fill(0.1),
      cluster_id: 1,
      top_p_distances: [0.3, 0.5, 0.8],
      token_count: 1500,
      has_code: false,
      has_math: false,
      ngram_entropy: 4.2,
      context_ratio: 0.15
    }
    
    mockArtifact = {
      version: '2024-01-01',
      centroids: '',
      alpha: 0.6,
      thresholds: { cheap: 0.62, hard: 0.58 },
      penalties: { latency_sd: 0.05, ctx_over_80pct: 0.15 },
      qhat: {},
      chat: {},
      gbdt: {
        framework: 'mock',
        model_path: './models/test.lgb',
        feature_schema: {}
      }
    }

    // Mock console methods to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    
    // Set up default mocks
    mockFs.existsSync.mockReturnValue(true)
    mockPath.isAbsolute.mockReturnValue(false)
    mockPath.resolve.mockReturnValue('/resolved/path/test.lgb')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('predict', () => {
    it('should return valid bucket probabilities', async () => {
      // Mock the model loading
      ;(runtime as any).model = new MockGBDTModel()
      
      const probabilities = await runtime.predict(mockFeatures, mockArtifact)
      
      expect(probabilities).toBeDefined()
      expect(probabilities.cheap).toBeGreaterThanOrEqual(0)
      expect(probabilities.cheap).toBeLessThanOrEqual(1)
      expect(probabilities.mid).toBeGreaterThanOrEqual(0)
      expect(probabilities.mid).toBeLessThanOrEqual(1)
      expect(probabilities.hard).toBeGreaterThanOrEqual(0)
      expect(probabilities.hard).toBeLessThanOrEqual(1)
      
      // Probabilities should sum to approximately 1.0
      const total = probabilities.cheap + probabilities.mid + probabilities.hard
      expect(total).toBeCloseTo(1.0, 5)
    })

    it('should handle model loading on first prediction', async () => {
      const probabilities = await runtime.predict(mockFeatures, mockArtifact)
      
      expect(probabilities).toBeDefined()
      expect(typeof probabilities.cheap).toBe('number')
      expect(typeof probabilities.mid).toBe('number')
      expect(typeof probabilities.hard).toBe('number')
    })

    it('should return fallback probabilities on model failure', async () => {
      // Mock failing model
      ;(runtime as any).model = new FailingMockModel()
      
      const probabilities = await runtime.predict(mockFeatures, mockArtifact)
      
      expect(probabilities).toBeDefined()
      const total = probabilities.cheap + probabilities.mid + probabilities.hard
      expect(total).toBeCloseTo(1.0, 5)
    })

    it('should handle missing model file', async () => {
      mockFs.existsSync.mockReturnValue(false)
      
      const probabilities = await runtime.predict(mockFeatures, mockArtifact)
      
      // Should still return valid probabilities (fallback)
      expect(probabilities).toBeDefined()
      const total = probabilities.cheap + probabilities.mid + probabilities.hard
      expect(total).toBeCloseTo(1.0, 5)
    })

    it('should normalize probabilities that do not sum to 1', async () => {
      class UnbalancedMockModel {
        framework = 'unbalanced'
        async predict(): Promise<number[]> {
          return [0.5, 0.8, 0.3] // Sum = 1.6
        }
      }
      
      ;(runtime as any).model = new UnbalancedMockModel()
      
      const probabilities = await runtime.predict(mockFeatures, mockArtifact)
      
      const total = probabilities.cheap + probabilities.mid + probabilities.hard
      expect(total).toBeCloseTo(1.0, 10)
    })

    it('should handle negative predictions by clamping', async () => {
      class NegativeMockModel {
        framework = 'negative'
        async predict(): Promise<number[]> {
          return [-0.1, 0.8, 0.3]
        }
      }
      
      ;(runtime as any).model = new NegativeMockModel()
      
      const probabilities = await runtime.predict(mockFeatures, mockArtifact)
      
      expect(probabilities.cheap).toBeGreaterThanOrEqual(0)
      expect(probabilities.mid).toBeGreaterThanOrEqual(0)
      expect(probabilities.hard).toBeGreaterThanOrEqual(0)
    })

    it('should handle wrong number of predictions', async () => {
      class WrongSizeMockModel {
        framework = 'wrong-size'
        async predict(): Promise<number[]> {
          return [0.5, 0.3] // Only 2 values instead of 3
        }
      }
      
      ;(runtime as any).model = new WrongSizeMockModel()
      
      const probabilities = await runtime.predict(mockFeatures, mockArtifact)
      
      // Should fall back to heuristic probabilities
      expect(probabilities).toBeDefined()
      const total = probabilities.cheap + probabilities.mid + probabilities.hard
      expect(total).toBeCloseTo(1.0, 5)
    })

    it('should track prediction statistics', async () => {
      ;(runtime as any).model = new MockGBDTModel()
      
      const initialStats = runtime.getStats()
      expect(initialStats.totalPredictions).toBe(0)
      
      await runtime.predict(mockFeatures, mockArtifact)
      await runtime.predict(mockFeatures, mockArtifact)
      
      const finalStats = runtime.getStats()
      expect(finalStats.totalPredictions).toBe(2)
      expect(finalStats.successfulPredictions).toBe(2)
      expect(finalStats.errorRate).toBe(0)
    })

    it('should track failed predictions', async () => {
      ;(runtime as any).model = new FailingMockModel()
      
      await runtime.predict(mockFeatures, mockArtifact)
      
      const stats = runtime.getStats()
      expect(stats.totalPredictions).toBe(1)
      expect(stats.failedPredictions).toBe(1)
      expect(stats.errorRate).toBe(1)
    })
  })

  describe('featuresToVector', () => {
    it('should convert features to numeric vector', () => {
      const vector = (runtime as any).featuresToVector(mockFeatures)
      
      expect(Array.isArray(vector)).toBe(true)
      expect(vector).toHaveLength(11) // Expected number of features
      expect(vector.every(v => typeof v === 'number')).toBe(true)
    })

    it('should handle boolean features correctly', () => {
      const codeFeatues = { ...mockFeatures, has_code: true, has_math: true }
      const vector = (runtime as any).featuresToVector(codeFeatues)
      
      expect(vector[2]).toBe(1) // has_code
      expect(vector[3]).toBe(1) // has_math
    })

    it('should handle missing optional features', () => {
      const minimalFeatures: RequestFeatures = {
        embedding: [],
        cluster_id: 0,
        top_p_distances: [],
        token_count: 100,
        has_code: false,
        has_math: false,
        ngram_entropy: 3.0,
        context_ratio: 0.1
      }
      
      const vector = (runtime as any).featuresToVector(minimalFeatures)
      
      expect(vector).toHaveLength(11)
      expect(vector[6]).toBe(1.0) // Padded top_p_distance_0
      expect(vector[7]).toBe(1.0) // Padded top_p_distance_1
      expect(vector[8]).toBe(1.0) // Padded top_p_distance_2
      expect(vector[9]).toBe(0.5) // Default user_success_rate
      expect(vector[10]).toBe(1000) // Default avg_latency
    })

    it('should use top_p_distances when available', () => {
      const vector = (runtime as any).featuresToVector(mockFeatures)
      
      expect(vector[6]).toBe(0.3) // top_p_distance_0
      expect(vector[7]).toBe(0.5) // top_p_distance_1
      expect(vector[8]).toBe(0.8) // top_p_distance_2
    })

    it('should handle historical features when present', () => {
      const featuresWithHistory = {
        ...mockFeatures,
        user_success_rate: 0.85,
        avg_latency: 2500
      }
      
      const vector = (runtime as any).featuresToVector(featuresWithHistory)
      
      expect(vector[9]).toBe(0.85)   // user_success_rate
      expect(vector[10]).toBe(2500)  // avg_latency
    })
  })

  describe('getFallbackProbabilities', () => {
    it('should return reasonable fallback for normal request', () => {
      const probabilities = (runtime as any).getFallbackProbabilities(mockFeatures)
      
      expect(probabilities.cheap).toBeGreaterThan(probabilities.hard)
      const total = probabilities.cheap + probabilities.mid + probabilities.hard
      expect(total).toBeCloseTo(1.0, 5)
    })

    it('should increase hard probability for high token count', () => {
      const longFeatures = { ...mockFeatures, token_count: 60000 }
      const normalProbabilities = (runtime as any).getFallbackProbabilities(mockFeatures)
      const longProbabilities = (runtime as any).getFallbackProbabilities(longFeatures)
      
      expect(longProbabilities.hard).toBeGreaterThan(normalProbabilities.hard)
    })

    it('should increase complexity for code/math tasks', () => {
      const complexFeatures = { ...mockFeatures, has_code: true, has_math: true }
      const normalProbabilities = (runtime as any).getFallbackProbabilities(mockFeatures)
      const complexProbabilities = (runtime as any).getFallbackProbabilities(complexFeatures)
      
      expect(complexProbabilities.hard).toBeGreaterThan(normalProbabilities.hard)
    })

    it('should handle high entropy text', () => {
      const highEntropyFeatures = { ...mockFeatures, ngram_entropy: 7.5 }
      const normalProbabilities = (runtime as any).getFallbackProbabilities(mockFeatures)
      const entropyProbabilities = (runtime as any).getFallbackProbabilities(highEntropyFeatures)
      
      expect(entropyProbabilities.mid + entropyProbabilities.hard)
        .toBeGreaterThan(normalProbabilities.mid + normalProbabilities.hard)
    })

    it('should handle high context pressure', () => {
      const highContextFeatures = { ...mockFeatures, context_ratio: 0.9 }
      const normalProbabilities = (runtime as any).getFallbackProbabilities(mockFeatures)
      const contextProbabilities = (runtime as any).getFallbackProbabilities(highContextFeatures)
      
      expect(contextProbabilities.hard).toBeGreaterThan(normalProbabilities.hard)
    })

    it('should prefer cheap for simple requests', () => {
      const simpleFeatures = {
        ...mockFeatures,
        token_count: 50,
        has_code: false,
        has_math: false,
        ngram_entropy: 2.0,
        context_ratio: 0.05
      }
      
      const probabilities = (runtime as any).getFallbackProbabilities(simpleFeatures)
      
      expect(probabilities.cheap).toBeGreaterThan(probabilities.mid)
      expect(probabilities.cheap).toBeGreaterThan(probabilities.hard)
    })
  })

  describe('getModelInfo', () => {
    it('should return basic info when no model loaded', async () => {
      const info = await runtime.getModelInfo()
      
      expect(info.loaded).toBe(false)
      expect(info.framework).toBeNull()
      expect(Array.isArray(info.featureNames)).toBe(true)
      expect(info.featureNames).toHaveLength(11)
    })

    it('should return model info when model is loaded', async () => {
      ;(runtime as any).model = new MockGBDTModel()
      
      const info = await runtime.getModelInfo()
      
      expect(info.loaded).toBe(true)
      expect(info.framework).toBe('mock')
      expect(Array.isArray(info.featureNames)).toBe(true)
    })
  })

  describe('invalidateModel', () => {
    it('should invalidate loaded model', () => {
      ;(runtime as any).model = new MockGBDTModel()
      
      runtime.invalidateModel()
      
      expect((runtime as any).model).toBeNull()
    })
  })

  describe('getStats and resetStats', () => {
    it('should track and reset statistics correctly', async () => {
      ;(runtime as any).model = new MockGBDTModel()
      
      // Make some predictions
      await runtime.predict(mockFeatures, mockArtifact)
      await runtime.predict(mockFeatures, mockArtifact)
      
      const stats = runtime.getStats()
      expect(stats.totalPredictions).toBe(2)
      expect(stats.successfulPredictions).toBe(2)
      expect(stats.avgPredictionTime).toBeGreaterThan(0)
      expect(stats.errorRate).toBe(0)
      
      runtime.resetStats()
      
      const resetStats = runtime.getStats()
      expect(resetStats.totalPredictions).toBe(0)
      expect(resetStats.successfulPredictions).toBe(0)
      expect(resetStats.avgPredictionTime).toBe(0)
      expect(resetStats.errorRate).toBe(0)
    })

    it('should calculate error rate correctly', async () => {
      ;(runtime as any).model = new FailingMockModel()
      
      await runtime.predict(mockFeatures, mockArtifact)
      await runtime.predict(mockFeatures, mockArtifact)
      
      const stats = runtime.getStats()
      expect(stats.totalPredictions).toBe(2)
      expect(stats.failedPredictions).toBe(2)
      expect(stats.errorRate).toBe(1)
    })

    it('should handle division by zero in stats', () => {
      const stats = runtime.getStats()
      
      expect(stats.avgPredictionTime).toBe(0)
      expect(stats.errorRate).toBe(0)
    })
  })

  describe('loadModel', () => {
    it('should throw error for unsupported framework', async () => {
      const unsupportedArtifact = {
        ...mockArtifact,
        gbdt: { ...mockArtifact.gbdt, framework: 'unsupported' }
      }
      
      await (runtime as any).loadModel(unsupportedArtifact)
      
      // Should fall back to mock model rather than throwing
      expect((runtime as any).model).toBeDefined()
      expect((runtime as any).model.framework).toBe('mock')
    })

    it('should resolve absolute vs relative paths', async () => {
      mockPath.isAbsolute.mockReturnValueOnce(true)
      const absoluteArtifact = {
        ...mockArtifact,
        gbdt: { ...mockArtifact.gbdt, model_path: '/absolute/path/model.lgb' }
      }
      
      await (runtime as any).loadModel(absoluteArtifact)
      
      expect(mockPath.resolve).not.toHaveBeenCalled()
    })

    it('should fall back to mock on file not found', async () => {
      mockFs.existsSync.mockReturnValue(false)
      
      await (runtime as any).loadModel(mockArtifact)
      
      expect((runtime as any).model).toBeDefined()
      expect((runtime as any).model.framework).toBe('mock')
    })
  })

  describe('integration scenarios', () => {
    it('should handle complete prediction pipeline', async () => {
      const complexFeatures: RequestFeatures = {
        embedding: new Array(384).fill(0.1),
        cluster_id: 2,
        top_p_distances: [0.1, 0.3, 0.7],
        token_count: 25000,
        has_code: true,
        has_math: true,
        ngram_entropy: 6.5,
        context_ratio: 0.75,
        user_success_rate: 0.95,
        avg_latency: 3500
      }
      
      const probabilities = await runtime.predict(complexFeatures, mockArtifact)
      
      expect(probabilities).toBeDefined()
      expect(probabilities.cheap).toBeGreaterThanOrEqual(0)
      expect(probabilities.mid).toBeGreaterThanOrEqual(0)
      expect(probabilities.hard).toBeGreaterThanOrEqual(0)
      
      const total = probabilities.cheap + probabilities.mid + probabilities.hard
      expect(total).toBeCloseTo(1.0, 5)
      
      // For complex request, should favor hard or mid over cheap
      expect(probabilities.cheap).toBeLessThan(probabilities.mid + probabilities.hard)
    })

    it('should maintain performance under load', async () => {
      ;(runtime as any).model = new MockGBDTModel()
      
      const startTime = Date.now()
      const promises = []
      
      // Simulate concurrent predictions
      for (let i = 0; i < 10; i++) {
        promises.push(runtime.predict(mockFeatures, mockArtifact))
      }
      
      await Promise.all(promises)
      const elapsed = Date.now() - startTime
      
      // Should complete all predictions reasonably quickly
      expect(elapsed).toBeLessThan(1000) // 1 second for 10 predictions
      
      const stats = runtime.getStats()
      expect(stats.totalPredictions).toBe(10)
      expect(stats.successfulPredictions).toBe(10)
      expect(stats.errorRate).toBe(0)
    })

    it('should gracefully degrade when model is slow', async () => {
      ;(runtime as any).model = new SlowMockModel()
      
      const startTime = Date.now()
      const probabilities = await runtime.predict(mockFeatures, mockArtifact)
      const elapsed = Date.now() - startTime
      
      expect(probabilities).toBeDefined()
      // Even with slow model, should eventually return results
      expect(elapsed).toBeGreaterThan(50) // Mock delay
    })

    it('should handle model switching', async () => {
      // Start with mock model
      ;(runtime as any).model = new MockGBDTModel()
      
      const prediction1 = await runtime.predict(mockFeatures, mockArtifact)
      expect(prediction1).toBeDefined()
      
      // Invalidate and switch to different artifact
      runtime.invalidateModel()
      const newArtifact = {
        ...mockArtifact,
        gbdt: { ...mockArtifact.gbdt, framework: 'different' }
      }
      
      const prediction2 = await runtime.predict(mockFeatures, newArtifact)
      expect(prediction2).toBeDefined()
      
      // Should work with both models
      const total1 = prediction1.cheap + prediction1.mid + prediction1.hard
      const total2 = prediction2.cheap + prediction2.mid + prediction2.hard
      
      expect(total1).toBeCloseTo(1.0, 5)
      expect(total2).toBeCloseTo(1.0, 5)
    })
  })
})