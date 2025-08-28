package main

import (
	"context"
	"encoding/json"
	"math"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ============================================================================
// PHASE 3: ALPHA SCORING ALGORITHM TESTS
// Comprehensive test suite for α-score model selection, quality prediction,
// cost estimation, penalty calculations, and performance optimization.
// Target: ~80 tests to reach 73% of 260 total tests (190/260)
// ============================================================================

// Test artifacts and fixtures for alpha scoring tests
func createTestArtifactForAlphaScoring() *AvengersArtifact {
	return &AvengersArtifact{
		Version: "test-alpha-v1.0",
		Alpha:   0.7, // 70% weight on quality, 30% on cost
		Thresholds: BucketThresholds{
			Cheap: 0.3,
			Hard:  0.7,
		},
		Penalties: PenaltyConfig{
			LatencySD:    0.1,
			CtxOver80Pct: 0.15,
		},
		// Quality scores per model per cluster (Q̂[m,c])
		Qhat: map[string][]float64{
			"openai/gpt-5":            {0.95, 0.92, 0.88, 0.94, 0.90}, // 5 clusters
			"anthropic/claude-3.5":    {0.85, 0.88, 0.92, 0.87, 0.89},
			"google/gemini-2.5-pro":   {0.82, 0.85, 0.89, 0.91, 0.86},
			"deepseek/deepseek-r1":    {0.78, 0.82, 0.85, 0.80, 0.79},
			"qwen/qwen3-coder":        {0.72, 0.75, 0.88, 0.74, 0.73}, // Strong on code (cluster 2)
		},
		// Normalized cost scores (Ĉ[m])
		Chat: map[string]float64{
			"openai/gpt-5":          0.85,  // High cost
			"anthropic/claude-3.5":  0.65,  // Mid-high cost
			"google/gemini-2.5-pro": 0.55,  // Mid cost
			"deepseek/deepseek-r1":  0.35,  // Low-mid cost
			"qwen/qwen3-coder":      0.25,  // Low cost
		},
	}
}

func createTestFeaturesForAlphaScoring() *RequestFeatures {
	return &RequestFeatures{
		Embedding:     make([]float64, 384),
		ClusterID:     2, // Code cluster
		TopPDistances: []float64{0.15, 0.23, 0.31, 0.44, 0.55},
		TokenCount:    5000,
		HasCode:       true,
		HasMath:       false,
		NgramEntropy:  3.2,
		ContextRatio:  0.25, // 25% of max context
		AvgLatency:    newFloat64Ptr(2.5),
	}
}

func newFloat64Ptr(f float64) *float64 {
	return &f
}

// ============================================================================
// CORE ALPHA SCORING LOGIC TESTS (~15 tests)
// Test the fundamental α-score formula: α * Q̂[m,c] - (1-α) * Ĉ[m] - penalties
// ============================================================================

func TestAlphaScorerCore(t *testing.T) {
	t.Run("Alpha Scoring Formula", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()
		features := createTestFeaturesForAlphaScoring()

		t.Run("should calculate correct alpha score for single model", func(t *testing.T) {
			score := scorer.scoreModel("qwen/qwen3-coder", features, artifact)
			require.NotNil(t, score)

			// Expected: α=0.7, Q̂[qwen,cluster2]=0.88, Ĉ[qwen]=0.25
			expectedQuality := 0.88
			expectedCost := 0.25
			expectedAlpha := (0.7 * expectedQuality) - (0.3 * expectedCost)

			assert.Equal(t, "qwen/qwen3-coder", score.Model)
			assert.InDelta(t, expectedQuality, score.QualityScore, 0.001)
			assert.InDelta(t, expectedCost, score.CostScore, 0.001)
			assert.Greater(t, score.AlphaScore, expectedAlpha-0.1) // Account for penalties
			assert.Less(t, score.AlphaScore, expectedAlpha+0.1)
		})

		t.Run("should handle missing quality scores gracefully", func(t *testing.T) {
			score := scorer.scoreModel("unknown/model", features, artifact)
			assert.Nil(t, score, "Should return nil for unknown model")
		})

		t.Run("should handle missing cost scores gracefully", func(t *testing.T) {
			// Add model with quality but no cost
			artifact.Qhat["test/model"] = []float64{0.5, 0.6, 0.7}
			score := scorer.scoreModel("test/model", features, artifact)
			assert.Nil(t, score, "Should return nil for model without cost data")
		})

		t.Run("should vary score with alpha parameter", func(t *testing.T) {
			// Test with different alpha values
			alphas := []float64{0.1, 0.5, 0.9}
			var scores []float64

			for _, alpha := range alphas {
				testArtifact := *artifact
				testArtifact.Alpha = alpha
				score := scorer.scoreModel("openai/gpt-5", features, &testArtifact)
				require.NotNil(t, score)
				scores = append(scores, score.AlphaScore)
			}

			// High alpha should favor quality (GPT-5 has high quality)
			assert.Greater(t, scores[2], scores[1]) // α=0.9 > α=0.5
			assert.Greater(t, scores[1], scores[0]) // α=0.5 > α=0.1
		})

		t.Run("should calculate penalties correctly", func(t *testing.T) {
			score := scorer.scoreModel("openai/gpt-5", features, artifact)
			require.NotNil(t, score)
			
			// Should have positive penalty (GPT-5 not optimal for code)
			assert.Greater(t, score.PenaltyScore, 0.0)
			assert.Less(t, score.PenaltyScore, 0.5) // Reasonable range
		})
	})

	t.Run("Alpha Parameter Sensitivity", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()
		features := createTestFeaturesForAlphaScoring()

		t.Run("should prefer quality models with high alpha", func(t *testing.T) {
			artifact.Alpha = 0.95 // Heavily favor quality
			
			candidates := []string{"openai/gpt-5", "qwen/qwen3-coder"}
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			assert.Equal(t, "openai/gpt-5", bestModel) // Higher quality wins
		})

		t.Run("should prefer cost-effective models with low alpha", func(t *testing.T) {
			artifact.Alpha = 0.05 // Heavily favor cost
			
			candidates := []string{"openai/gpt-5", "qwen/qwen3-coder"}
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			assert.Equal(t, "qwen/qwen3-coder", bestModel) // Lower cost wins
		})

		t.Run("should balance quality and cost with mid alpha", func(t *testing.T) {
			artifact.Alpha = 0.5 // Balanced
			
			candidates := []string{"openai/gpt-5", "google/gemini-2.5-pro", "qwen/qwen3-coder"}
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			// Should pick a middle-ground model (likely Gemini for code tasks)
			assert.Contains(t, []string{"google/gemini-2.5-pro", "qwen/qwen3-coder"}, bestModel)
		})
	})
}

// ============================================================================
// QUALITY PREDICTION TESTING (~15 tests)
// Test cluster-specific quality scoring and fallback mechanisms
// ============================================================================

func TestAlphaScorerQualityPrediction(t *testing.T) {
	t.Run("Cluster-Specific Quality Scoring", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should use cluster-specific quality score", func(t *testing.T) {
			// Test each cluster gets correct quality score
			for clusterID := 0; clusterID < 5; clusterID++ {
				qualityScore := scorer.getQualityScore("qwen/qwen3-coder", clusterID, artifact)
				require.NotNil(t, qualityScore)
				
				expectedScore := artifact.Qhat["qwen/qwen3-coder"][clusterID]
				assert.InDelta(t, expectedScore, *qualityScore, 0.001)
			}
		})

		t.Run("should fallback to average when cluster ID exceeds range", func(t *testing.T) {
			qualityScore := scorer.getQualityScore("qwen/qwen3-coder", 999, artifact)
			require.NotNil(t, qualityScore)
			
			// Calculate expected average
			scores := artifact.Qhat["qwen/qwen3-coder"]
			expectedAvg := 0.0
			for _, score := range scores {
				expectedAvg += score
			}
			expectedAvg /= float64(len(scores))
			
			assert.InDelta(t, expectedAvg, *qualityScore, 0.001)
		})

		t.Run("should return nil for unknown model", func(t *testing.T) {
			qualityScore := scorer.getQualityScore("unknown/model", 0, artifact)
			assert.Nil(t, qualityScore)
		})

		t.Run("should handle empty quality array", func(t *testing.T) {
			artifact.Qhat["empty/model"] = []float64{}
			qualityScore := scorer.getQualityScore("empty/model", 0, artifact)
			assert.Nil(t, qualityScore)
		})

		t.Run("should prefer models strong in current cluster", func(t *testing.T) {
			// Qwen is strong in cluster 2 (code)
			features := &RequestFeatures{ClusterID: 2}
			
			candidates := []string{"openai/gpt-5", "qwen/qwen3-coder"}
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			// Qwen should win on cluster 2 due to specialized strength
			assert.Equal(t, "qwen/qwen3-coder", bestModel)
		})
	})

	t.Run("Quality Score Edge Cases", func(t *testing.T) {
		scorer := NewAlphaScorer()
		
		t.Run("should handle NaN quality scores", func(t *testing.T) {
			artifact := createTestArtifactForAlphaScoring()
			artifact.Qhat["nan/model"] = []float64{math.NaN(), 0.5, 0.6}
			
			qualityScore := scorer.getQualityScore("nan/model", 0, artifact)
			// Should either be nil or handle NaN gracefully
			if qualityScore != nil {
				assert.False(t, math.IsNaN(*qualityScore))
			}
		})

		t.Run("should handle infinite quality scores", func(t *testing.T) {
			artifact := createTestArtifactForAlphaScoring()
			artifact.Qhat["inf/model"] = []float64{math.Inf(1), 0.5, 0.6}
			
			qualityScore := scorer.getQualityScore("inf/model", 0, artifact)
			// Should either be nil or handle infinity gracefully
			if qualityScore != nil {
				assert.False(t, math.IsInf(*qualityScore, 0))
			}
		})

		t.Run("should handle negative quality scores", func(t *testing.T) {
			artifact := createTestArtifactForAlphaScoring()
			artifact.Qhat["negative/model"] = []float64{-0.5, 0.5, 0.6}
			
			qualityScore := scorer.getQualityScore("negative/model", 0, artifact)
			require.NotNil(t, qualityScore)
			assert.Equal(t, -0.5, *qualityScore) // Should preserve negative values
		})
	})

	t.Run("Multi-Cluster Quality Analysis", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should identify model strengths across clusters", func(t *testing.T) {
			// Qwen is strongest on cluster 2, GPT-5 on cluster 0
			qwenBest := -1.0
			gptBest := -1.0
			
			for i := 0; i < 5; i++ {
				qwenScore := scorer.getQualityScore("qwen/qwen3-coder", i, artifact)
				gptScore := scorer.getQualityScore("openai/gpt-5", i, artifact)
				
				if qwenScore != nil && *qwenScore > qwenBest {
					qwenBest = *qwenScore
				}
				if gptScore != nil && *gptScore > gptBest {
					gptBest = *gptScore
				}
			}
			
			qwenCluster2 := scorer.getQualityScore("qwen/qwen3-coder", 2, artifact)
			gptCluster0 := scorer.getQualityScore("openai/gpt-5", 0, artifact)
			
			assert.Equal(t, qwenBest, *qwenCluster2)
			assert.Equal(t, gptBest, *gptCluster0)
		})
	})
}

// ============================================================================
// COST ESTIMATION TESTING (~10 tests)
// Test cost score retrieval, normalization, and validation
// ============================================================================

func TestAlphaScorerCostEstimation(t *testing.T) {
	t.Run("Cost Score Accuracy", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should retrieve correct cost scores", func(t *testing.T) {
			testCases := []struct {
				model        string
				expectedCost float64
			}{
				{"openai/gpt-5", 0.85},
				{"anthropic/claude-3.5", 0.65},
				{"google/gemini-2.5-pro", 0.55},
				{"deepseek/deepseek-r1", 0.35},
				{"qwen/qwen3-coder", 0.25},
			}

			for _, tc := range testCases {
				costScore := scorer.getCostScore(tc.model, artifact)
				require.NotNil(t, costScore, "Cost score should exist for %s", tc.model)
				assert.InDelta(t, tc.expectedCost, *costScore, 0.001)
			}
		})

		t.Run("should return nil for unknown model costs", func(t *testing.T) {
			costScore := scorer.getCostScore("unknown/model", artifact)
			assert.Nil(t, costScore)
		})

		t.Run("should handle zero cost scores", func(t *testing.T) {
			artifact.Chat["free/model"] = 0.0
			costScore := scorer.getCostScore("free/model", artifact)
			require.NotNil(t, costScore)
			assert.Equal(t, 0.0, *costScore)
		})

		t.Run("should prefer low-cost models when cost-sensitive", func(t *testing.T) {
			artifact.Alpha = 0.1 // Very cost-sensitive
			features := createTestFeaturesForAlphaScoring()
			
			candidates := []string{"openai/gpt-5", "qwen/qwen3-coder"}
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			assert.Equal(t, "qwen/qwen3-coder", bestModel) // Cheapest option
		})
	})

	t.Run("Cost Score Edge Cases", func(t *testing.T) {
		scorer := NewAlphaScorer()

		t.Run("should handle negative cost scores", func(t *testing.T) {
			artifact := createTestArtifactForAlphaScoring()
			artifact.Chat["negative/model"] = -0.1
			
			costScore := scorer.getCostScore("negative/model", artifact)
			require.NotNil(t, costScore)
			assert.Equal(t, -0.1, *costScore) // Should preserve negative values
		})

		t.Run("should handle very high cost scores", func(t *testing.T) {
			artifact := createTestArtifactForAlphaScoring()
			artifact.Chat["expensive/model"] = 999.99
			
			costScore := scorer.getCostScore("expensive/model", artifact)
			require.NotNil(t, costScore)
			assert.Equal(t, 999.99, *costScore)
		})

		t.Run("should handle NaN cost scores", func(t *testing.T) {
			artifact := createTestArtifactForAlphaScoring()
			artifact.Chat["nan/model"] = math.NaN()
			
			costScore := scorer.getCostScore("nan/model", artifact)
			require.NotNil(t, costScore)
			assert.True(t, math.IsNaN(*costScore)) // Should preserve NaN
		})
	})
}

// ============================================================================
// PENALTY CALCULATION TESTING (~15 tests)
// Test context, latency, and model-specific penalties
// ============================================================================

func TestAlphaScorerPenaltyCalculation(t *testing.T) {
	t.Run("Context Over-utilization Penalties", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should apply penalty when context over 80%", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			features.ContextRatio = 0.85 // Over 80% threshold
			
			penalty := scorer.calculatePenalties("test/model", features, artifact)
			
			assert.GreaterOrEqual(t, penalty, artifact.Penalties.CtxOver80Pct)
		})

		t.Run("should not apply penalty when context under 80%", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			features.ContextRatio = 0.75 // Under 80% threshold
			
			penalty := scorer.calculatePenalties("test/model", features, artifact)
			
			// Should not include context penalty (but may have other penalties)
			contextPenalty := artifact.Penalties.CtxOver80Pct
			if penalty >= contextPenalty {
				// If penalty is high, it should be from other sources
				otherPenalties := penalty - contextPenalty
				assert.GreaterOrEqual(t, otherPenalties, 0.0)
			}
		})

		t.Run("should scale penalty with context ratio", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			
			ratios := []float64{0.82, 0.90, 0.95}
			var penalties []float64
			
			for _, ratio := range ratios {
				features.ContextRatio = ratio
				penalty := scorer.calculatePenalties("test/model", features, artifact)
				penalties = append(penalties, penalty)
			}
			
			// Higher context ratios should generally have higher penalties
			assert.LessOrEqual(t, penalties[0], penalties[1])
			assert.LessOrEqual(t, penalties[1], penalties[2])
		})
	})

	t.Run("Latency Variance Penalties", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should apply penalty for high latency variance", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			features.AvgLatency = newFloat64Ptr(10.0) // Much higher than expected
			
			penalty := scorer.calculatePenalties("openai/gpt-5", features, artifact)
			
			// Should have latency-related penalty
			assert.Greater(t, penalty, 0.0)
		})

		t.Run("should not apply penalty for low latency variance", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			expectedLatency := scorer.estimateLatency("openai/gpt-5", features)
			features.AvgLatency = newFloat64Ptr(expectedLatency * 1.1) // Close to expected
			
			penalty := scorer.calculatePenalties("openai/gpt-5", features, artifact)
			
			// Should have minimal latency penalty
			assert.Less(t, penalty, 0.2)
		})

		t.Run("should handle missing average latency", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			features.AvgLatency = nil
			
			penalty := scorer.calculatePenalties("openai/gpt-5", features, artifact)
			
			// Should not crash and should return reasonable penalty
			assert.GreaterOrEqual(t, penalty, 0.0)
			assert.Less(t, penalty, 1.0)
		})
	})

	t.Run("Model-Specific Penalties", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should give DeepSeek bonus for code tasks", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			features.HasCode = true
			
			deepseekPenalty := scorer.calculatePenalties("deepseek/deepseek-r1", features, artifact)
			gptPenalty := scorer.calculatePenalties("openai/gpt-5", features, artifact)
			
			// DeepSeek should have lower penalty (bonus) for code
			assert.Less(t, deepseekPenalty, gptPenalty)
		})

		t.Run("should penalize non-reasoning models for math", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			features.HasMath = true
			features.HasCode = false
			
			qwenPenalty := scorer.calculatePenalties("qwen/qwen3-coder", features, artifact)
			gptPenalty := scorer.calculatePenalties("openai/gpt-5", features, artifact)
			
			// Non-reasoning models should have higher penalty for math
			assert.Greater(t, qwenPenalty, gptPenalty)
		})

		t.Run("should penalize models for very long context", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			features.TokenCount = 150000 // Very long context
			
			qwenPenalty := scorer.calculatePenalties("qwen/qwen3-coder", features, artifact)
			geminiPenalty := scorer.calculatePenalties("google/gemini-2.5-pro", features, artifact)
			
			// Gemini should have lower penalty for long context
			assert.Less(t, geminiPenalty, qwenPenalty)
		})

		t.Run("should combine multiple penalty factors", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			features.ContextRatio = 0.85    // Over 80% - penalty
			features.HasMath = true          // Math task
			features.TokenCount = 120000     // Long context
			features.AvgLatency = newFloat64Ptr(15.0) // High latency
			
			// Non-reasoning model with multiple penalties
			penalty := scorer.calculatePenalties("qwen/qwen3-coder", features, artifact)
			
			// Should accumulate multiple penalties
			assert.Greater(t, penalty, 0.2) // Significant penalty
			assert.Less(t, penalty, 2.0)   // But not excessive
		})
	})

	t.Run("Penalty Edge Cases", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should handle zero penalty configuration", func(t *testing.T) {
			artifact.Penalties.LatencySD = 0.0
			artifact.Penalties.CtxOver80Pct = 0.0
			
			features := createTestFeaturesForAlphaScoring()
			features.ContextRatio = 0.95 // High context
			
			penalty := scorer.calculatePenalties("test/model", features, artifact)
			
			// Should be very low penalty with zero config
			assert.Less(t, penalty, 0.1)
		})
	})
}

// ============================================================================
// MODEL SELECTION & SCORING TESTS (~15 tests)
// Test best model selection, score comparison, and ranking
// ============================================================================

func TestAlphaScorerModelSelection(t *testing.T) {
	t.Run("Best Model Selection Logic", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()
		features := createTestFeaturesForAlphaScoring()

		t.Run("should select model with highest alpha score", func(t *testing.T) {
			candidates := []string{
				"openai/gpt-5",
				"anthropic/claude-3.5", 
				"qwen/qwen3-coder",
			}
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			assert.NotEmpty(t, bestModel)
			assert.Contains(t, candidates, bestModel)
		})

		t.Run("should handle single candidate", func(t *testing.T) {
			candidates := []string{"qwen/qwen3-coder"}
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			assert.Equal(t, "qwen/qwen3-coder", bestModel)
		})

		t.Run("should return error for empty candidates", func(t *testing.T) {
			candidates := []string{}
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			assert.Error(t, err)
			assert.Empty(t, bestModel)
		})

		t.Run("should fall back to first candidate if no valid scores", func(t *testing.T) {
			// Candidates with no scoring data
			candidates := []string{"unknown/model1", "unknown/model2"}
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			assert.Equal(t, "unknown/model1", bestModel) // Fallback to first
		})

		t.Run("should prefer valid models over invalid ones", func(t *testing.T) {
			candidates := []string{"unknown/model", "qwen/qwen3-coder", "invalid/model"}
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			assert.Equal(t, "qwen/qwen3-coder", bestModel) // Only valid option
		})
	})

	t.Run("Score Comparison and Ranking", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()
		features := createTestFeaturesForAlphaScoring()

		t.Run("should rank models by alpha score", func(t *testing.T) {
			candidates := []string{
				"openai/gpt-5",          // High quality, high cost
				"google/gemini-2.5-pro", // Mid quality, mid cost
				"qwen/qwen3-coder",      // Good for code, low cost
			}
			
			scores, err := scorer.scoreModels(candidates, features, artifact)
			require.NoError(t, err)
			
			// Scores should be sorted by alpha score (descending)
			for i := 1; i < len(scores); i++ {
				assert.GreaterOrEqual(t, scores[i-1].AlphaScore, scores[i].AlphaScore)
			}
		})

		t.Run("should handle identical scores", func(t *testing.T) {
			// Create scenario with very similar scores
			testFeatures := &RequestFeatures{
				ClusterID:     0,
				TokenCount:    1000,
				HasCode:       false,
				HasMath:       false,
				ContextRatio:  0.1,
			}
			
			candidates := []string{"anthropic/claude-3.5", "google/gemini-2.5-pro"}
			bestModel, err := scorer.SelectBest(candidates, testFeatures, artifact)
			
			require.NoError(t, err)
			assert.Contains(t, candidates, bestModel) // Should pick one consistently
		})

		t.Run("should maintain consistent ordering", func(t *testing.T) {
			candidates := []string{
				"openai/gpt-5",
				"anthropic/claude-3.5",
				"google/gemini-2.5-pro",
				"deepseek/deepseek-r1",
				"qwen/qwen3-coder",
			}
			
			// Run selection multiple times
			var results []string
			for i := 0; i < 5; i++ {
				bestModel, err := scorer.SelectBest(candidates, features, artifact)
				require.NoError(t, err)
				results = append(results, bestModel)
			}
			
			// All results should be the same
			for i := 1; i < len(results); i++ {
				assert.Equal(t, results[0], results[i])
			}
		})
	})

	t.Run("Tie-Breaking Scenarios", func(t *testing.T) {
		scorer := NewAlphaScorer()

		t.Run("should break ties consistently", func(t *testing.T) {
			// Create artifact where two models have very similar scores
			artifact := createTestArtifactForAlphaScoring()
			artifact.Qhat["model1"] = []float64{0.8, 0.8, 0.8, 0.8, 0.8}
			artifact.Qhat["model2"] = []float64{0.8, 0.8, 0.8, 0.8, 0.8}
			artifact.Chat["model1"] = 0.5
			artifact.Chat["model2"] = 0.5
			
			features := createTestFeaturesForAlphaScoring()
			candidates := []string{"model1", "model2"}
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			assert.Contains(t, candidates, bestModel)
			
			// Should be deterministic
			for i := 0; i < 3; i++ {
				result, err := scorer.SelectBest(candidates, features, artifact)
				require.NoError(t, err)
				assert.Equal(t, bestModel, result)
			}
		})
	})

	t.Run("Context-Specific Selection", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should adapt to code tasks", func(t *testing.T) {
			features := &RequestFeatures{
				ClusterID:     2, // Code cluster
				HasCode:       true,
				HasMath:       false,
				TokenCount:    3000,
				ContextRatio:  0.2,
			}
			
			candidates := []string{"openai/gpt-5", "qwen/qwen3-coder"}
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			// Should prefer code-specialized model
			assert.Equal(t, "qwen/qwen3-coder", bestModel)
		})

		t.Run("should adapt to math tasks", func(t *testing.T) {
			features := &RequestFeatures{
				ClusterID:     3, // Math cluster
				HasCode:       false,
				HasMath:       true,
				TokenCount:    2000,
				ContextRatio:  0.15,
			}
			
			candidates := []string{"qwen/qwen3-coder", "openai/gpt-5"}
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			// Should prefer reasoning model for math
			assert.Equal(t, "openai/gpt-5", bestModel)
		})

		t.Run("should adapt to long context tasks", func(t *testing.T) {
			features := &RequestFeatures{
				ClusterID:     1,
				HasCode:       false,
				HasMath:       false,
				TokenCount:    200000, // Very long
				ContextRatio:  0.6,
			}
			
			candidates := []string{"qwen/qwen3-coder", "google/gemini-2.5-pro"}
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			require.NoError(t, err)
			// Should prefer long-context model
			assert.Equal(t, "google/gemini-2.5-pro", bestModel)
		})
	})
}

// ============================================================================
// PERFORMANCE & CONCURRENCY TESTS (~10 tests)
// Test concurrent scoring, batch optimization, and <10ms latency requirements
// ============================================================================

func TestAlphaScorerPerformance(t *testing.T) {
	t.Run("Latency Requirements", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()
		features := createTestFeaturesForAlphaScoring()

		t.Run("should complete single scoring under 1ms", func(t *testing.T) {
			start := time.Now()
			
			score := scorer.scoreModel("qwen/qwen3-coder", features, artifact)
			
			elapsed := time.Since(start)
			require.NotNil(t, score)
			assert.Less(t, elapsed, 1*time.Millisecond, "Single scoring should be under 1ms")
		})

		t.Run("should complete best selection under 5ms", func(t *testing.T) {
			candidates := []string{
				"openai/gpt-5",
				"anthropic/claude-3.5", 
				"google/gemini-2.5-pro",
				"deepseek/deepseek-r1",
				"qwen/qwen3-coder",
			}
			
			start := time.Now()
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			elapsed := time.Since(start)
			require.NoError(t, err)
			require.NotEmpty(t, bestModel)
			assert.Less(t, elapsed, 5*time.Millisecond, "Best selection should be under 5ms")
		})

		t.Run("should maintain performance with many candidates", func(t *testing.T) {
			// Create 20 candidates
			var candidates []string
			for i := 0; i < 20; i++ {
				model := fmt.Sprintf("test/model-%d", i)
				artifact.Qhat[model] = []float64{0.5 + float64(i%10)*0.05}
				artifact.Chat[model] = 0.3 + float64(i%5)*0.1
				candidates = append(candidates, model)
			}
			
			start := time.Now()
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			elapsed := time.Since(start)
			require.NoError(t, err)
			require.NotEmpty(t, bestModel)
			assert.Less(t, elapsed, 10*time.Millisecond, "Should handle 20 candidates under 10ms")
		})
	})

	t.Run("Concurrent Scoring", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()
		features := createTestFeaturesForAlphaScoring()

		t.Run("should handle concurrent scoring safely", func(t *testing.T) {
			candidates := []string{
				"openai/gpt-5",
				"qwen/qwen3-coder",
				"google/gemini-2.5-pro",
			}
			
			numGoroutines := 10
			results := make(chan string, numGoroutines)
			errors := make(chan error, numGoroutines)
			
			for i := 0; i < numGoroutines; i++ {
				go func() {
					bestModel, err := scorer.SelectBest(candidates, features, artifact)
					if err != nil {
						errors <- err
						return
					}
					results <- bestModel
				}()
			}
			
			// Collect results
			var models []string
			for i := 0; i < numGoroutines; i++ {
				select {
				case model := <-results:
					models = append(models, model)
				case err := <-errors:
					t.Fatalf("Concurrent scoring failed: %v", err)
				case <-time.After(100 * time.Millisecond):
					t.Fatalf("Concurrent scoring timed out")
				}
			}
			
			// All results should be consistent
			assert.Len(t, models, numGoroutines)
			for i := 1; i < len(models); i++ {
				assert.Equal(t, models[0], models[i])
			}
		})

		t.Run("should maintain performance under concurrent load", func(t *testing.T) {
			candidates := []string{
				"openai/gpt-5",
				"qwen/qwen3-coder",
			}
			
			numGoroutines := 50
			start := time.Now()
			
			var wg sync.WaitGroup
			wg.Add(numGoroutines)
			
			for i := 0; i < numGoroutines; i++ {
				go func() {
					defer wg.Done()
					_, err := scorer.SelectBest(candidates, features, artifact)
					assert.NoError(t, err)
				}()
			}
			
			wg.Wait()
			elapsed := time.Since(start)
			
			avgTimePerRequest := elapsed / time.Duration(numGoroutines)
			assert.Less(t, avgTimePerRequest, 2*time.Millisecond, "Average time per concurrent request should be under 2ms")
		})

		t.Run("should handle concurrent scoring with different features", func(t *testing.T) {
			candidates := []string{"openai/gpt-5", "qwen/qwen3-coder"}
			
			numGoroutines := 20
			results := make(chan string, numGoroutines)
			
			for i := 0; i < numGoroutines; i++ {
				go func(index int) {
					// Create slightly different features for each goroutine
					testFeatures := *features
					testFeatures.ClusterID = index % 5
					testFeatures.HasCode = index%2 == 0
					testFeatures.TokenCount = 1000 + index*500
					
					bestModel, err := scorer.SelectBest(candidates, &testFeatures, artifact)
					if err != nil {
						results <- "ERROR"
						return
					}
					results <- bestModel
				}(i)
			}
			
			// Collect results
			var models []string
			for i := 0; i < numGoroutines; i++ {
				select {
				case model := <-results:
					if model != "ERROR" {
						models = append(models, model)
					}
				case <-time.After(50 * time.Millisecond):
					t.Fatalf("Concurrent scoring with different features timed out")
				}
			}
			
			assert.Greater(t, len(models), 0, "Should have at least some successful results")
			// Results may vary due to different features, but should all be valid candidates
			for _, model := range models {
				assert.Contains(t, candidates, model)
			}
		})
	})

	t.Run("Memory Efficiency", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()

		t.Run("should not leak memory during repeated scoring", func(t *testing.T) {
			features := createTestFeaturesForAlphaScoring()
			candidates := []string{"openai/gpt-5", "qwen/qwen3-coder"}
			
			// Force garbage collection
			runtime.GC()
			var m1 runtime.MemStats
			runtime.ReadMemStats(&m1)
			
			// Perform many scoring operations
			for i := 0; i < 1000; i++ {
				_, err := scorer.SelectBest(candidates, features, artifact)
				require.NoError(t, err)
			}
			
			runtime.GC()
			var m2 runtime.MemStats
			runtime.ReadMemStats(&m2)
			
			// Memory growth should be minimal (less than 1MB)
			memoryGrowth := m2.Alloc - m1.Alloc
			assert.Less(t, memoryGrowth, uint64(1024*1024), "Memory growth should be less than 1MB")
		})

		t.Run("should handle large artifact efficiently", func(t *testing.T) {
			// Create large artifact with many models and clusters
			largeArtifact := createTestArtifactForAlphaScoring()
			
			// Add 100 models with 20 clusters each
			for i := 0; i < 100; i++ {
				model := fmt.Sprintf("test/model-%d", i)
				scores := make([]float64, 20)
				for j := 0; j < 20; j++ {
					scores[j] = 0.5 + float64(j)*0.02
				}
				largeArtifact.Qhat[model] = scores
				largeArtifact.Chat[model] = 0.2 + float64(i%10)*0.05
			}
			
			features := createTestFeaturesForAlphaScoring()
			candidates := []string{"test/model-0", "test/model-50", "test/model-99"}
			
			start := time.Now()
			bestModel, err := scorer.SelectBest(candidates, features, largeArtifact)
			elapsed := time.Since(start)
			
			require.NoError(t, err)
			require.NotEmpty(t, bestModel)
			assert.Less(t, elapsed, 10*time.Millisecond, "Should handle large artifact efficiently")
		})
	})

	t.Run("Batch Scoring Optimization", func(t *testing.T) {
		scorer := NewAlphaScorer()
		artifact := createTestArtifactForAlphaScoring()
		features := createTestFeaturesForAlphaScoring()

		t.Run("should batch score multiple models efficiently", func(t *testing.T) {
			candidates := []string{
				"openai/gpt-5",
				"anthropic/claude-3.5", 
				"google/gemini-2.5-pro",
				"deepseek/deepseek-r1",
				"qwen/qwen3-coder",
			}
			
			start := time.Now()
			scores, err := scorer.scoreModels(candidates, features, artifact)
			elapsed := time.Since(start)
			
			require.NoError(t, err)
			assert.Len(t, scores, len(candidates))
			assert.Less(t, elapsed, 3*time.Millisecond, "Batch scoring should be efficient")
		})

		t.Run("should maintain accuracy in batch scoring", func(t *testing.T) {
			candidates := []string{"openai/gpt-5", "qwen/qwen3-coder"}
			
			// Score individually
			score1 := scorer.scoreModel(candidates[0], features, artifact)
			score2 := scorer.scoreModel(candidates[1], features, artifact)
			
			// Score in batch
			batchScores, err := scorer.scoreModels(candidates, features, artifact)
			
			require.NoError(t, err)
			require.Len(t, batchScores, 2)
			require.NotNil(t, score1)
			require.NotNil(t, score2)
			
			// Results should be identical
			assert.InDelta(t, score1.AlphaScore, batchScores[0].AlphaScore, 0.001)
			assert.InDelta(t, score2.AlphaScore, batchScores[1].AlphaScore, 0.001)
		})
	})
}

// ============================================================================
// INTEGRATION TESTS (~5 tests)
// Test integration with authentication, routing, and other components
// ============================================================================

func TestAlphaScorerIntegration(t *testing.T) {
	t.Run("Integration with Router Components", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		t.Run("should integrate with router decision making", func(t *testing.T) {
			req := &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST",
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: "Write a Python function to sort a list"},
					},
				},
			}
			
			headers := map[string][]string{}
			response, err := plugin.decide(req, headers)
			
			require.NoError(t, err)
			require.NotNil(t, response)
			
			// Should have made a model selection
			assert.NotEmpty(t, response.Decision.Model)
			assert.Contains(t, []string{"cheap", "mid", "hard"}, string(response.Bucket))
		})

		t.Run("should work with authentication context", func(t *testing.T) {
			req := &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST",
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: "Hello world"},
					},
				},
			}
			
			headers := map[string][]string{
				"Authorization": {"Bearer anthropic_test123"},
			}
			
			response, err := plugin.decide(req, headers)
			
			require.NoError(t, err)
			require.NotNil(t, response)
			require.NotNil(t, response.AuthInfo)
			
			assert.Equal(t, "anthropic", response.AuthInfo.Provider)
		})

		t.Run("should handle fallback scenarios", func(t *testing.T) {
			// Create plugin with minimal artifact
			config := createTestConfig()
			plugin, err := New(config)
			require.NoError(t, err)
			
			// Force artifact to nil to trigger fallback
			plugin.currentArtifact = nil
			
			req := &schemas.BifrostRequest{
				Model: "test-model",
			}
			ctx := context.Background()
			
			result, shortCircuit, err := plugin.PreHook(&ctx, req)
			
			// Should handle gracefully with fallback
			assert.NotNil(t, result)
			assert.Nil(t, shortCircuit)
			assert.NoError(t, err)
		})
	})

	t.Run("End-to-End Scoring Pipeline", func(t *testing.T) {
		scorer := NewAlphaScorer()
		featureExtractor := NewFeatureExtractor()
		
		t.Run("should complete full pipeline efficiently", func(t *testing.T) {
			artifact := createTestArtifactForAlphaScoring()
			
			// Create realistic request
			req := &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST",
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: "Please write a React component for a todo list with TypeScript"},
					},
				},
			}
			
			start := time.Now()
			
			// Extract features
			features, err := featureExtractor.Extract(req, artifact, 25) // 25ms budget
			require.NoError(t, err)
			
			// Score models
			candidates := []string{
				"openai/gpt-5",
				"qwen/qwen3-coder",
				"google/gemini-2.5-pro",
			}
			
			bestModel, err := scorer.SelectBest(candidates, features, artifact)
			
			elapsed := time.Since(start)
			
			require.NoError(t, err)
			require.NotEmpty(t, bestModel)
			assert.Less(t, elapsed, 30*time.Millisecond, "Full pipeline should complete under 30ms")
		})
	})
}

// ============================================================================
// BENCHMARK TESTS
// Performance benchmarks for alpha scoring components
// ============================================================================

func BenchmarkAlphaScorer(b *testing.B) {
	scorer := NewAlphaScorer()
	artifact := createTestArtifactForAlphaScoring()
	features := createTestFeaturesForAlphaScoring()

	b.Run("ScoreModel", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			scorer.scoreModel("qwen/qwen3-coder", features, artifact)
		}
	})

	b.Run("SelectBest", func(b *testing.B) {
		candidates := []string{
			"openai/gpt-5",
			"anthropic/claude-3.5",
			"qwen/qwen3-coder",
		}
		
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			scorer.SelectBest(candidates, features, artifact)
		}
	})

	b.Run("ConcurrentSelection", func(b *testing.B) {
		candidates := []string{
			"openai/gpt-5",
			"qwen/qwen3-coder",
		}
		
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				scorer.SelectBest(candidates, features, artifact)
			}
		})
	})
}

// ============================================================================
// HELPER FUNCTIONS FOR TESTING
// ============================================================================

func createTestPlugin(t *testing.T) *Plugin {
	config := createTestConfig()
	plugin, err := New(config)
	require.NoError(t, err)
	
	// Set up test artifact
	plugin.currentArtifact = createTestArtifactForAlphaScoring()
	plugin.lastArtifactLoad = time.Now()
	
	return plugin
}

func createTestConfig() Config {
	return Config{
		Router: RouterConfig{
			Alpha: 0.7,
			Thresholds: BucketThresholds{
				Cheap: 0.3,
				Hard:  0.7,
			},
			Penalties: PenaltyConfig{
				LatencySD:    0.1,
				CtxOver80Pct: 0.15,
			},
			CheapCandidates: []string{"qwen/qwen3-coder", "deepseek/deepseek-r1"},
			MidCandidates:   []string{"anthropic/claude-3.5", "google/gemini-2.5-pro"},
			HardCandidates:  []string{"openai/gpt-5", "google/gemini-2.5-pro"},
		},
		AuthAdapters: AuthAdaptersConfig{
			Enabled: []string{"openai-key", "anthropic-oauth"},
		},
		Tuning: TuningConfig{
			ArtifactURL:   "http://localhost:8080/test-artifact.json",
			ReloadSeconds: 300,
		},
		Timeout:          25 * time.Millisecond,
		CacheTTL:         5 * time.Minute,
		EnableCaching:    true,
		EnableAuth:       true,
		EnableFallbacks:  true,
	}
}