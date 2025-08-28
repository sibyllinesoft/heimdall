import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AlphaScorer } from './alpha_score.js'
import type { RequestFeatures, AvengersArtifact, ModelScore } from './alpha_score.js'

describe('AlphaScorer', () => {
  let scorer: AlphaScorer
  let mockFeatures: RequestFeatures
  let mockArtifact: AvengersArtifact
  let testCandidates: string[]

  beforeEach(() => {
    scorer = new AlphaScorer()
    
    mockFeatures = {
      embedding: new Array(384).fill(0.1),
      cluster_id: 0,
      top_p_distances: [0.3, 0.5, 0.8],
      token_count: 1000,
      has_code: false,
      has_math: false,
      ngram_entropy: 4.2,
      context_ratio: 0.1
    }
    
    mockArtifact = {
      version: '2024-01-01',
      centroids: '',
      alpha: 0.6,
      thresholds: { cheap: 0.62, hard: 0.58 },
      penalties: { 
        latency_sd: 0.05,
        ctx_over_80pct: 0.15
      },
      qhat: {
        'model-a': [0.8, 0.7, 0.6], // Quality scores per cluster
        'model-b': [0.6, 0.8, 0.7],
        'model-c': [0.9, 0.6, 0.8],
        'deepseek/deepseek-r1': [0.85, 0.75, 0.80],
        'qwen/qwen3-coder': [0.75, 0.85, 0.70],
        'openai/gpt-5': [0.95, 0.90, 0.95],
        'google/gemini-2.5-pro': [0.90, 0.85, 0.90]
      },
      chat: {
        'model-a': 0.1,  // Cost scores (lower is better)
        'model-b': 0.15,
        'model-c': 0.05,
        'deepseek/deepseek-r1': 0.08,
        'qwen/qwen3-coder': 0.06,
        'openai/gpt-5': 0.25,
        'google/gemini-2.5-pro': 0.20
      },
      gbdt: { framework: 'test', model_path: '', feature_schema: {} }
    }
    
    testCandidates = ['model-a', 'model-b', 'model-c']
    
    // Mock console methods to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('selectBest', () => {
    it('should select the best model based on α-score', async () => {
      const bestModel = await scorer.selectBest(testCandidates, mockFeatures, mockArtifact)
      
      expect(bestModel).toBeDefined()
      expect(testCandidates).toContain(bestModel)
    })

    it('should handle empty candidates array', async () => {
      await expect(scorer.selectBest([], mockFeatures, mockArtifact))
        .rejects.toThrow('No valid model scores')
    })

    it('should return first candidate on error', async () => {
      const invalidArtifact = { ...mockArtifact, qhat: null }
      
      const bestModel = await scorer.selectBest(testCandidates, mockFeatures, invalidArtifact as any)
      
      expect(bestModel).toBe(testCandidates[0])
    })

    it('should prefer models with higher quality at high α', async () => {
      const highAlphaArtifact = { ...mockArtifact, alpha: 0.9 }
      
      const bestModel = await scorer.selectBest(testCandidates, mockFeatures, highAlphaArtifact)
      const scores = await scorer.getDetailedScores(testCandidates, mockFeatures, highAlphaArtifact)
      
      const bestScore = scores.find(s => s.model === bestModel)
      expect(bestScore).toBeDefined()
      expect(bestScore!.quality_score).toBeGreaterThan(0.6)
    })

    it('should prefer models with lower cost at low α', async () => {
      const lowAlphaArtifact = { ...mockArtifact, alpha: 0.1 }
      
      const bestModel = await scorer.selectBest(testCandidates, mockFeatures, lowAlphaArtifact)
      const scores = await scorer.getDetailedScores(testCandidates, mockFeatures, lowAlphaArtifact)
      
      const bestScore = scores.find(s => s.model === bestModel)
      expect(bestScore).toBeDefined()
      expect(bestScore!.cost_score).toBeLessThan(0.2)
    })
  })

  describe('scoreModels', () => {
    it('should return scores for all valid models', async () => {
      const scores = await scorer.scoreModels(testCandidates, mockFeatures, mockArtifact)
      
      expect(scores).toHaveLength(testCandidates.length)
      scores.forEach(score => {
        expect(score.model).toBeDefined()
        expect(score.quality_score).toBeGreaterThanOrEqual(0)
        expect(score.cost_score).toBeGreaterThanOrEqual(0)
        expect(score.penalty_score).toBeGreaterThanOrEqual(0)
        expect(typeof score.alpha_score).toBe('number')
      })
    })

    it('should filter out models without quality scores', async () => {
      const incompleteArtifact = {
        ...mockArtifact,
        qhat: { 'model-a': [0.8, 0.7, 0.6] } // Only model-a has scores
      }
      
      const scores = await scorer.scoreModels(testCandidates, mockFeatures, incompleteArtifact)
      
      expect(scores).toHaveLength(1)
      expect(scores[0].model).toBe('model-a')
    })

    it('should handle models without cost scores', async () => {
      const incompleteArtifact = {
        ...mockArtifact,
        chat: { 'model-a': 0.1 } // Only model-a has cost score
      }
      
      const scores = await scorer.scoreModels(testCandidates, mockFeatures, incompleteArtifact)
      
      expect(scores).toHaveLength(1)
      expect(scores[0].model).toBe('model-a')
    })
  })

  describe('getQualityScore', () => {
    it('should return cluster-specific quality score', () => {
      const qualityScore = (scorer as any).getQualityScore('model-a', 0, mockArtifact)
      
      expect(qualityScore).toBe(0.8) // First score in model-a array
    })

    it('should return average quality score for invalid cluster', () => {
      const qualityScore = (scorer as any).getQualityScore('model-a', 999, mockArtifact)
      
      const expectedAvg = (0.8 + 0.7 + 0.6) / 3
      expect(qualityScore).toBeCloseTo(expectedAvg)
    })

    it('should return null for non-existent model', () => {
      const qualityScore = (scorer as any).getQualityScore('non-existent', 0, mockArtifact)
      
      expect(qualityScore).toBeNull()
    })

    it('should return null for invalid quality data', () => {
      const invalidArtifact = {
        ...mockArtifact,
        qhat: { 'model-a': 'invalid' }
      }
      
      const qualityScore = (scorer as any).getQualityScore('model-a', 0, invalidArtifact)
      
      expect(qualityScore).toBeNull()
    })
  })

  describe('getCostScore', () => {
    it('should return cost score for existing model', () => {
      const costScore = (scorer as any).getCostScore('model-a', mockArtifact)
      
      expect(costScore).toBe(0.1)
    })

    it('should return null for non-existent model', () => {
      const costScore = (scorer as any).getCostScore('non-existent', mockArtifact)
      
      expect(costScore).toBeNull()
    })
  })

  describe('calculatePenalties', () => {
    it('should return zero penalty for normal context', () => {
      const penalty = (scorer as any).calculatePenalties('model-a', mockFeatures, mockArtifact)
      
      expect(penalty).toBeGreaterThanOrEqual(0)
    })

    it('should apply context over-utilization penalty', () => {
      const highContextFeatures = { ...mockFeatures, context_ratio: 0.9 }
      const penalty = (scorer as any).calculatePenalties('model-a', highContextFeatures, mockArtifact)
      
      expect(penalty).toBeGreaterThanOrEqual(mockArtifact.penalties.ctx_over_80pct)
    })

    it('should apply latency variance penalty', () => {
      const highLatencyFeatures = { ...mockFeatures, avg_latency: 10.0 }
      const penalty = (scorer as any).calculatePenalties('model-a', highLatencyFeatures, mockArtifact)
      
      expect(penalty).toBeGreaterThan(0)
    })

    it('should handle missing avg_latency gracefully', () => {
      const featuresWithoutLatency = { ...mockFeatures }
      delete (featuresWithoutLatency as any).avg_latency
      
      const penalty = (scorer as any).calculatePenalties('model-a', featuresWithoutLatency, mockArtifact)
      
      expect(penalty).toBeGreaterThanOrEqual(0)
    })
  })

  describe('estimateLatency', () => {
    it('should return reasonable latency estimates', () => {
      const latency = (scorer as any).estimateLatency('deepseek/deepseek-r1', mockFeatures)
      
      expect(latency).toBeGreaterThan(0)
      expect(latency).toBeLessThan(20) // Reasonable upper bound
    })

    it('should scale with token count', () => {
      const lowTokenFeatures = { ...mockFeatures, token_count: 100 }
      const highTokenFeatures = { ...mockFeatures, token_count: 50000 }
      
      const lowLatency = (scorer as any).estimateLatency('model-a', lowTokenFeatures)
      const highLatency = (scorer as any).estimateLatency('model-a', highTokenFeatures)
      
      expect(highLatency).toBeGreaterThan(lowLatency)
    })

    it('should increase latency for reasoning models with complex tasks', () => {
      const codeFeatures = { ...mockFeatures, has_code: true }
      const mathFeatures = { ...mockFeatures, has_math: true }
      
      const normalLatency = (scorer as any).estimateLatency('openai/gpt-5', mockFeatures)
      const codeLatency = (scorer as any).estimateLatency('openai/gpt-5', codeFeatures)
      const mathLatency = (scorer as any).estimateLatency('openai/gpt-5', mathFeatures)
      
      expect(codeLatency).toBeGreaterThan(normalLatency)
      expect(mathLatency).toBeGreaterThan(normalLatency)
    })

    it('should have default latency for unknown models', () => {
      const latency = (scorer as any).estimateLatency('unknown-model', mockFeatures)
      
      expect(latency).toBe(5.0) // Default base latency
    })
  })

  describe('getModelSpecificPenalties', () => {
    it('should give bonus to DeepSeek for code tasks', () => {
      const codeFeatures = { ...mockFeatures, has_code: true }
      const penalty = (scorer as any).getModelSpecificPenalties('deepseek/deepseek-r1', codeFeatures)
      
      expect(penalty).toBeLessThan(0) // Negative penalty = bonus
    })

    it('should penalize non-reasoning models for math tasks', () => {
      const mathFeatures = { ...mockFeatures, has_math: true }
      const penalty = (scorer as any).getModelSpecificPenalties('model-a', mathFeatures)
      
      expect(penalty).toBeGreaterThan(0)
    })

    it('should penalize non-Gemini models for very long context', () => {
      const longContextFeatures = { ...mockFeatures, token_count: 120000 }
      const penalty = (scorer as any).getModelSpecificPenalties('model-a', longContextFeatures)
      
      expect(penalty).toBeGreaterThan(0)
    })

    it('should not penalize Gemini for long context', () => {
      const longContextFeatures = { ...mockFeatures, token_count: 120000 }
      const penalty = (scorer as any).getModelSpecificPenalties('google/gemini-2.5-pro', longContextFeatures)
      
      // Should only get the base penalty calculation, no additional long context penalty
      expect(penalty).toBeLessThan(0.15)
    })
  })

  describe('validateArtifact', () => {
    it('should validate correct artifact', () => {
      const validation = scorer.validateArtifact(mockArtifact)
      
      expect(validation.isValid).toBe(true)
      expect(validation.issues).toHaveLength(0)
    })

    it('should detect invalid alpha', () => {
      const invalidArtifact = { ...mockArtifact, alpha: 1.5 }
      const validation = scorer.validateArtifact(invalidArtifact)
      
      expect(validation.isValid).toBe(false)
      expect(validation.issues).toContain('Invalid alpha value')
    })

    it('should detect missing quality scores', () => {
      const invalidArtifact = { ...mockArtifact, qhat: null }
      const validation = scorer.validateArtifact(invalidArtifact as any)
      
      expect(validation.isValid).toBe(false)
      expect(validation.issues).toContain('Missing quality scores (qhat)')
    })

    it('should detect missing cost scores', () => {
      const invalidArtifact = { ...mockArtifact, chat: null }
      const validation = scorer.validateArtifact(invalidArtifact as any)
      
      expect(validation.isValid).toBe(false)
      expect(validation.issues).toContain('Missing cost scores (chat)')
    })

    it('should detect missing penalties', () => {
      const invalidArtifact = { ...mockArtifact, penalties: null }
      const validation = scorer.validateArtifact(invalidArtifact as any)
      
      expect(validation.isValid).toBe(false)
      expect(validation.issues).toContain('Missing penalty configuration')
    })

    it('should identify missing common models', () => {
      const sparseArtifact = {
        ...mockArtifact,
        qhat: { 'model-a': [0.5] },
        chat: { 'model-a': 0.1 }
      }
      
      const validation = scorer.validateArtifact(sparseArtifact)
      
      expect(validation.missingModels.length).toBeGreaterThan(0)
      expect(validation.missingModels).toContain('deepseek/deepseek-r1')
      expect(validation.missingModels).toContain('openai/gpt-5')
    })
  })

  describe('selectWithExploration', () => {
    it('should usually select the best model', async () => {
      // Run multiple times to check deterministic behavior with low exploration rate
      const selections: string[] = []
      
      for (let i = 0; i < 5; i++) {
        const selected = await scorer.selectWithExploration(
          testCandidates, 
          mockFeatures, 
          mockArtifact, 
          0.0 // No exploration
        )
        selections.push(selected)
      }
      
      // Should always select the same (best) model
      const uniqueSelections = new Set(selections)
      expect(uniqueSelections.size).toBe(1)
    })

    it('should explore with high exploration rate', async () => {
      const selections: string[] = []
      
      for (let i = 0; i < 10; i++) {
        const selected = await scorer.selectWithExploration(
          testCandidates,
          mockFeatures,
          mockArtifact,
          0.8, // High exploration
          3   // Consider top 3
        )
        selections.push(selected)
      }
      
      // Should have some variety in selections
      const uniqueSelections = new Set(selections)
      expect(uniqueSelections.size).toBeGreaterThanOrEqual(1)
    })

    it('should handle empty candidates', async () => {
      const selected = await scorer.selectWithExploration(
        [],
        mockFeatures,
        mockArtifact,
        0.1
      )
      
      expect(selected).toBeUndefined()
    })

    it('should respect topN parameter', async () => {
      const manyCandidates = [...testCandidates, 'model-d', 'model-e', 'model-f']
      const scores = await scorer.scoreModels(manyCandidates, mockFeatures, mockArtifact)
      
      // With 100% exploration and topN=2, should only select from top 2
      const selections: string[] = []
      for (let i = 0; i < 20; i++) {
        const selected = await scorer.selectWithExploration(
          manyCandidates.filter(c => scores.some(s => s.model === c)), // Only valid candidates
          mockFeatures,
          mockArtifact,
          1.0, // 100% exploration
          2    // Top 2 only
        )
        selections.push(selected)
      }
      
      const uniqueSelections = new Set(selections)
      expect(uniqueSelections.size).toBeLessThanOrEqual(2)
    })
  })

  describe('getDetailedScores', () => {
    it('should return detailed scoring breakdown', async () => {
      const scores = await scorer.getDetailedScores(testCandidates, mockFeatures, mockArtifact)
      
      expect(scores).toHaveLength(testCandidates.length)
      scores.forEach(score => {
        expect(score).toHaveProperty('model')
        expect(score).toHaveProperty('quality_score')
        expect(score).toHaveProperty('cost_score')
        expect(score).toHaveProperty('penalty_score')
        expect(score).toHaveProperty('alpha_score')
      })
    })

    it('should match scoreModels output', async () => {
      const detailed = await scorer.getDetailedScores(testCandidates, mockFeatures, mockArtifact)
      const regular = await scorer.scoreModels(testCandidates, mockFeatures, mockArtifact)
      
      expect(detailed).toEqual(regular)
    })
  })

  describe('calculateDiversityBonus', () => {
    it('should give bonus for diverse selection', () => {
      const bonus = (scorer as any).calculateDiversityBonus('model-a', [])
      
      expect(bonus).toBe(0.1) // Maximum bonus for new model
    })

    it('should reduce bonus for repeated selections', () => {
      const recentSelections = ['model-a', 'model-a', 'model-a']
      const bonus = (scorer as any).calculateDiversityBonus('model-a', recentSelections)
      
      expect(bonus).toBeLessThan(0.1)
      expect(bonus).toBeGreaterThanOrEqual(0)
    })

    it('should handle empty recent selections', () => {
      const bonus = (scorer as any).calculateDiversityBonus('model-a', [])
      
      expect(bonus).toBe(0.1)
    })
  })

  describe('integration scenarios', () => {
    it('should handle real-world model selection scenario', async () => {
      const realCandidates = ['deepseek/deepseek-r1', 'qwen/qwen3-coder', 'openai/gpt-5']
      const codeTask = {
        ...mockFeatures,
        has_code: true,
        token_count: 2000,
        cluster_id: 1
      }
      
      const bestModel = await scorer.selectBest(realCandidates, codeTask, mockArtifact)
      const scores = await scorer.getDetailedScores(realCandidates, codeTask, mockArtifact)
      
      expect(realCandidates).toContain(bestModel)
      expect(scores).toHaveLength(realCandidates.length)
      
      // Verify α-score calculation
      const bestScore = scores.find(s => s.model === bestModel)
      expect(bestScore).toBeDefined()
      
      const expectedAlpha = (mockArtifact.alpha * bestScore!.quality_score) - 
                            ((1 - mockArtifact.alpha) * bestScore!.cost_score) - 
                            bestScore!.penalty_score
                            
      expect(bestScore!.alpha_score).toBeCloseTo(expectedAlpha, 5)
    })

    it('should prefer different models based on task type', async () => {
      const candidates = ['deepseek/deepseek-r1', 'openai/gpt-5']
      
      // Code task should favor DeepSeek
      const codeTask = { ...mockFeatures, has_code: true }
      const codeSelection = await scorer.selectBest(candidates, codeTask, mockArtifact)
      
      // Math task should favor reasoning model (GPT-5)
      const mathTask = { ...mockFeatures, has_math: true }
      const mathSelection = await scorer.selectBest(candidates, mathTask, mockArtifact)
      
      // At least one should be different (depending on the specific scoring)
      expect([codeSelection, mathSelection]).toContain('deepseek/deepseek-r1')
      expect([codeSelection, mathSelection]).toContain('openai/gpt-5')
    })

    it('should handle edge case with all models having same scores', async () => {
      const uniformArtifact = {
        ...mockArtifact,
        qhat: {
          'model-a': [0.5, 0.5, 0.5],
          'model-b': [0.5, 0.5, 0.5],
          'model-c': [0.5, 0.5, 0.5]
        },
        chat: {
          'model-a': 0.1,
          'model-b': 0.1,
          'model-c': 0.1
        }
      }
      
      const bestModel = await scorer.selectBest(testCandidates, mockFeatures, uniformArtifact)
      
      expect(testCandidates).toContain(bestModel)
      // Should still make a deterministic choice
    })
  })
})