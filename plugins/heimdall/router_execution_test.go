package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ============================================================================
// PHASE 2: ROUTER EXECUTION ENGINE TESTS
// Comprehensive test suite for router execution, request processing, and 
// performance optimization components.
// ============================================================================

// TestRouterExecutorCore tests the core router execution engine functionality
func TestRouterExecutorCore(t *testing.T) {
	t.Run("decide method comprehensive test", func(t *testing.T) {
		t.Run("should make routing decision for simple request", func(t *testing.T) {
			plugin := createTestPlugin(t)
			
			req := &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST",
				Headers: map[string][]string{
					"Authorization": {"Bearer sk-test123"},
					"Content-Type":  {"application/json"},
				},
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: "Hello, how are you?"},
					},
					Model: "gpt-4o",
				},
			}
			
			headers := map[string][]string{
				"Authorization": {"Bearer sk-test123"},
			}
			
			response, err := plugin.decide(req, headers)
			
			require.NoError(t, err)
			assert.NotNil(t, response)
			assert.NotEmpty(t, response.Decision.Model)
			assert.NotEmpty(t, response.Decision.Kind)
			assert.NotNil(t, response.Features)
			assert.Contains(t, []string{"cheap", "mid", "hard"}, string(response.Bucket))
			
			// Verify probabilities sum to ~1
			probSum := response.BucketProbabilities.Cheap + response.BucketProbabilities.Mid + response.BucketProbabilities.Hard
			assert.InDelta(t, 1.0, probSum, 0.01)
		})
		
		t.Run("should handle code-heavy requests", func(t *testing.T) {
			plugin := createTestPlugin(t)
			
			req := &RouterRequest{
				URL:    "/v1/chat/completions", 
				Method: "POST",
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: "```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n```\nOptimize this code."},
					},
				},
			}
			
			response, err := plugin.decide(req, map[string][]string{})
			
			require.NoError(t, err)
			assert.True(t, response.Features.HasCode, "Should detect code in request")
			// Code requests typically favor mid-tier models
			assert.True(t, response.BucketProbabilities.Mid > 0.4 || response.Bucket == BucketMid)
		})
		
		t.Run("should handle math-heavy requests", func(t *testing.T) {
			plugin := createTestPlugin(t)
			
			req := &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST", 
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: "Solve this integral: ∫(x² + 3x - 2)dx from 0 to 5. Show your work step by step using LaTeX notation $\\int_0^5 (x^2 + 3x - 2)dx$."},
					},
				},
			}
			
			response, err := plugin.decide(req, map[string][]string{})
			
			require.NoError(t, err)
			assert.True(t, response.Features.HasMath, "Should detect math in request")
			// Math requests typically favor hard-tier models
			assert.True(t, response.BucketProbabilities.Hard > 0.4 || response.Bucket == BucketHard)
		})
		
		t.Run("should handle long context requests", func(t *testing.T) {
			plugin := createTestPlugin(t)
			
			// Create a very long message
			longContent := strings.Repeat("This is a very long message that will exceed typical context limits. ", 1000)
			
			req := &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST",
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: longContent},
					},
				},
			}
			
			response, err := plugin.decide(req, map[string][]string{})
			
			require.NoError(t, err)
			assert.Greater(t, response.Features.TokenCount, 10000, "Should detect long context")
			assert.Greater(t, response.Features.ContextRatio, 0.1, "Should have significant context ratio")
			
			// Long context should favor hard bucket or mid at minimum
			assert.True(t, response.Bucket == BucketHard || response.Bucket == BucketMid, 
				"Long context should not use cheap bucket")
		})
		
		t.Run("should handle authentication information", func(t *testing.T) {
			plugin := createTestPlugin(t)
			
			req := &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST",
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: "Hello"},
					},
				},
			}
			
			headers := map[string][]string{
				"Authorization": {"Bearer anthropic_test123"},
			}
			
			response, err := plugin.decide(req, headers)
			
			require.NoError(t, err)
			require.NotNil(t, response.AuthInfo)
			assert.Equal(t, "anthropic", response.AuthInfo.Provider)
			assert.Equal(t, "bearer", response.AuthInfo.Type)
			assert.Equal(t, "anthropic_test123", response.AuthInfo.Token)
		})
		
		t.Run("should fail gracefully without artifact", func(t *testing.T) {
			plugin := createTestPluginWithoutArtifact(t)
			
			req := &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST",
				Body: &RequestBody{
					Messages: []ChatMessage{{Role: "user", Content: "Hello"}},
				},
			}
			
			_, err := plugin.decide(req, map[string][]string{})
			
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "artifact")
		})
	})
}

// TestBucketSelection tests the bucket selection logic with guardrails
func TestBucketSelection(t *testing.T) {
	t.Run("selectBucket method tests", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		t.Run("should select cheap bucket for high cheap probability", func(t *testing.T) {
			probs := &BucketProbabilities{
				Cheap: 0.8,
				Mid:   0.15,
				Hard:  0.05,
			}
			features := &RequestFeatures{
				TokenCount: 1000,
			}
			
			bucket := plugin.selectBucket(probs, features)
			assert.Equal(t, BucketCheap, bucket)
		})
		
		t.Run("should select hard bucket for high hard probability", func(t *testing.T) {
			probs := &BucketProbabilities{
				Cheap: 0.1,
				Mid:   0.2,
				Hard:  0.7,
			}
			features := &RequestFeatures{
				TokenCount: 5000,
			}
			
			bucket := plugin.selectBucket(probs, features)
			assert.Equal(t, BucketHard, bucket)
		})
		
		t.Run("should default to mid bucket for balanced probabilities", func(t *testing.T) {
			probs := &BucketProbabilities{
				Cheap: 0.33,
				Mid:   0.34,
				Hard:  0.33,
			}
			features := &RequestFeatures{
				TokenCount: 3000,
			}
			
			bucket := plugin.selectBucket(probs, features)
			assert.Equal(t, BucketMid, bucket)
		})
		
		t.Run("should apply context overflow guardrails", func(t *testing.T) {
			// Even with high cheap probability, large context should upgrade bucket
			probs := &BucketProbabilities{
				Cheap: 0.9,
				Mid:   0.05,
				Hard:  0.05,
			}
			features := &RequestFeatures{
				TokenCount: 50000, // Exceeds cheap capacity
			}
			
			bucket := plugin.selectBucket(probs, features)
			assert.NotEqual(t, BucketCheap, bucket, "Should not select cheap for large context")
		})
		
		t.Run("should upgrade to hard for very large context", func(t *testing.T) {
			probs := &BucketProbabilities{
				Cheap: 0.8,
				Mid:   0.15,
				Hard:  0.05,
			}
			features := &RequestFeatures{
				TokenCount: 200000, // Exceeds mid capacity
			}
			
			bucket := plugin.selectBucket(probs, features)
			assert.Equal(t, BucketHard, bucket, "Should upgrade to hard for very large context")
		})
	})
	
	t.Run("contextExceedsCapacity method tests", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		testCases := []struct {
			name        string
			tokenCount  int
			bucket      Bucket
			shouldExceed bool
		}{
			{"cheap bucket within capacity", 10000, BucketCheap, false},
			{"cheap bucket exceeds capacity", 20000, BucketCheap, true},
			{"mid bucket within capacity", 80000, BucketMid, false},
			{"mid bucket exceeds capacity", 150000, BucketMid, true},
			{"hard bucket within capacity", 500000, BucketHard, false},
			{"hard bucket exceeds capacity", 1200000, BucketHard, true},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				features := &RequestFeatures{
					TokenCount: tc.tokenCount,
				}
				
				exceeds := plugin.contextExceedsCapacity(features, tc.bucket)
				assert.Equal(t, tc.shouldExceed, exceeds)
			})
		}
	})
}

// TestModelSelection tests the in-bucket model selection logic
func TestModelSelection(t *testing.T) {
	t.Run("selectModel method tests", func(t *testing.T) {
		plugin := createTestPlugin(t)
		features := &RequestFeatures{
			ClusterID:     1,
			TokenCount:    5000,
			HasCode:       false,
			HasMath:       false,
			NgramEntropy:  3.5,
			ContextRatio:  0.1,
		}
		
		t.Run("should select model for cheap bucket", func(t *testing.T) {
			decision, err := plugin.selectModel(BucketCheap, features, nil, false)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			assert.Contains(t, plugin.config.Router.CheapCandidates, decision.Model)
			assert.Equal(t, "env", decision.Auth.Mode)
		})
		
		t.Run("should select model for mid bucket", func(t *testing.T) {
			decision, err := plugin.selectModel(BucketMid, features, nil, false)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			assert.Contains(t, plugin.config.Router.MidCandidates, decision.Model)
		})
		
		t.Run("should select model for hard bucket", func(t *testing.T) {
			decision, err := plugin.selectModel(BucketHard, features, nil, false)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			assert.Contains(t, plugin.config.Router.HardCandidates, decision.Model)
		})
		
		t.Run("should handle Anthropic authentication", func(t *testing.T) {
			authInfo := &AuthInfo{
				Provider: "anthropic",
				Type:     "bearer",
				Token:    "anthropic_test123",
			}
			
			decision, err := plugin.selectModel(BucketMid, features, authInfo, false)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			// Should either use Anthropic model or regular mid bucket selection
			assert.True(t, decision.Kind == "anthropic" || contains(plugin.config.Router.MidCandidates, decision.Model))
		})
		
		t.Run("should exclude Anthropic when requested", func(t *testing.T) {
			authInfo := &AuthInfo{
				Provider: "anthropic",
				Type:     "bearer", 
				Token:    "anthropic_test123",
			}
			
			decision, err := plugin.selectModel(BucketMid, features, authInfo, true)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			assert.NotEqual(t, "anthropic", decision.Kind)
		})
		
		t.Run("should fail for unknown bucket", func(t *testing.T) {
			_, err := plugin.selectModel(Bucket("unknown"), features, nil, false)
			
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "unknown bucket")
		})
	})
	
	t.Run("selectModelForBucket method tests", func(t *testing.T) {
		plugin := createTestPlugin(t)
		features := &RequestFeatures{
			ClusterID:     2,
			TokenCount:    10000,
			HasCode:       true,
			HasMath:       false,
			NgramEntropy:  4.2,
			ContextRatio:  0.15,
		}
		
		t.Run("should add reasoning parameters for mid bucket", func(t *testing.T) {
			decision, err := plugin.selectModelForBucket("mid", features)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			
			// Should have reasoning parameters if GPT or Gemini
			if strings.Contains(decision.Model, "gpt") {
				assert.Contains(t, decision.Params, "reasoning_effort")
			} else if strings.Contains(decision.Model, "gemini") {
				assert.Contains(t, decision.Params, "thinkingBudget")
			}
		})
		
		t.Run("should add reasoning parameters for hard bucket", func(t *testing.T) {
			decision, err := plugin.selectModelForBucket("hard", features)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			
			// Should have reasoning parameters for hard bucket
			if strings.Contains(decision.Model, "gpt") {
				assert.Contains(t, decision.Params, "reasoning_effort")
				assert.Equal(t, "high", decision.Params["reasoning_effort"])
			} else if strings.Contains(decision.Model, "gemini") {
				assert.Contains(t, decision.Params, "thinkingBudget")
				assert.Equal(t, 10000, decision.Params["thinkingBudget"])
			}
		})
		
		t.Run("should not add reasoning parameters for cheap bucket", func(t *testing.T) {
			decision, err := plugin.selectModelForBucket("cheap", features)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			assert.Empty(t, decision.Params, "Cheap bucket should not have reasoning parameters")
		})
		
		t.Run("should prefer Gemini for very long context", func(t *testing.T) {
			longContextFeatures := &RequestFeatures{
				ClusterID:     1,
				TokenCount:    250000, // Very long context
				HasCode:       false,
				HasMath:       false,
				ContextRatio:  0.8,
			}
			
			decision, err := plugin.selectModelForBucket("hard", longContextFeatures)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			// For very long context in hard bucket, should prefer Gemini if available
			if containsGemini(plugin.config.Router.HardCandidates) {
				assert.True(t, strings.Contains(decision.Model, "gemini"), "Should prefer Gemini for long context")
			}
		})
		
		t.Run("should populate fallbacks list", func(t *testing.T) {
			decision, err := plugin.selectModelForBucket("mid", features)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			assert.NotEmpty(t, decision.Fallbacks, "Should have fallback models")
			assert.NotContains(t, decision.Fallbacks, decision.Model, "Fallbacks should not include selected model")
		})
		
		t.Run("should infer correct provider kind", func(t *testing.T) {
			decision, err := plugin.selectModelForBucket("mid", features)
			
			require.NoError(t, err)
			assert.NotNil(t, decision)
			
			expectedProvider := plugin.inferProviderKind(decision.Model)
			assert.Equal(t, expectedProvider, decision.Kind)
		})
	})
}

// TestProviderInference tests provider kind inference from model names
func TestProviderInference(t *testing.T) {
	plugin := createTestPlugin(t)
	
	testCases := []struct {
		model           string
		expectedProvider string
	}{
		{"openai/gpt-4o", "openai"},
		{"gpt-5-turbo", "openai"},
		{"anthropic/claude-3-5-sonnet", "anthropic"},
		{"claude-3-opus", "anthropic"},
		{"google/gemini-1.5-pro", "google"},
		{"gemini-2.0-flash", "google"},
		{"qwen/qwen-2.5-coder", "openrouter"},
		{"deepseek/deepseek-r1", "openrouter"},
		{"meta/llama-3.2", "openrouter"},
	}
	
	for _, tc := range testCases {
		t.Run(fmt.Sprintf("should infer %s for %s", tc.expectedProvider, tc.model), func(t *testing.T) {
			provider := plugin.inferProviderKind(tc.model)
			assert.Equal(t, tc.expectedProvider, provider)
		})
	}
}

// TestProviderPreferences tests provider preferences for different buckets
func TestProviderPreferences(t *testing.T) {
	plugin := createTestPlugin(t)
	
	t.Run("should return correct preferences for cheap bucket", func(t *testing.T) {
		prefs := plugin.getProviderPreferencesForBucket("cheap")
		assert.Equal(t, "price", prefs.Sort)
		assert.Equal(t, 10, prefs.MaxPrice)
		assert.True(t, prefs.AllowFallbacks)
	})
	
	t.Run("should return correct preferences for mid bucket", func(t *testing.T) {
		prefs := plugin.getProviderPreferencesForBucket("mid")
		assert.Equal(t, "quality", prefs.Sort)
		assert.Equal(t, 50, prefs.MaxPrice)
		assert.True(t, prefs.AllowFallbacks)
	})
	
	t.Run("should return correct preferences for hard bucket", func(t *testing.T) {
		prefs := plugin.getProviderPreferencesForBucket("hard")
		assert.Equal(t, "quality", prefs.Sort)
		assert.Equal(t, 100, prefs.MaxPrice)
		assert.True(t, prefs.AllowFallbacks)
	})
	
	t.Run("should return default preferences for unknown bucket", func(t *testing.T) {
		prefs := plugin.getProviderPreferencesForBucket("unknown")
		assert.Equal(t, "quality", prefs.Sort)
		assert.Equal(t, 50, prefs.MaxPrice)
		assert.True(t, prefs.AllowFallbacks)
	})
}

// TestRequestConversion tests conversion between Bifrost and internal request formats
func TestRequestConversion(t *testing.T) {
	t.Run("convertToRouterRequest method tests", func(t *testing.T) {
		plugin := createTestPlugin(t)
		ctx := context.Background()
		
		t.Run("should convert basic chat completion request", func(t *testing.T) {
			content := "Hello, world!"
			bifrostReq := &schemas.BifrostRequest{
				Model: "gpt-4o",
				Input: schemas.BifrostRequestInput{
					ChatCompletionInput: &[]schemas.ChatCompletionMessage{
						{
							Role:    schemas.ChatCompletionMessageRoleUser,
							Content: schemas.ChatCompletionMessageContent{ContentStr: &content},
						},
					},
				},
			}
			
			routerReq, headers, err := plugin.convertToRouterRequest(&ctx, bifrostReq)
			
			require.NoError(t, err)
			assert.NotNil(t, routerReq)
			assert.Equal(t, "/v1/chat/completions", routerReq.URL)
			assert.Equal(t, "POST", routerReq.Method)
			assert.Equal(t, "gpt-4o", routerReq.Body.Model)
			assert.Len(t, routerReq.Body.Messages, 1)
			assert.Equal(t, "user", routerReq.Body.Messages[0].Role)
			assert.Equal(t, content, routerReq.Body.Messages[0].Content)
			assert.NotNil(t, headers)
		})
		
		t.Run("should handle multiple messages", func(t *testing.T) {
			userContent := "What's the weather like?"
			assistantContent := "I'd be happy to help with weather information. However, I don't have access to real-time weather data."
			userContent2 := "That's okay, can you tell me about climate patterns instead?"
			
			bifrostReq := &schemas.BifrostRequest{
				Model: "claude-3-5-sonnet",
				Input: schemas.BifrostRequestInput{
					ChatCompletionInput: &[]schemas.ChatCompletionMessage{
						{
							Role:    schemas.ChatCompletionMessageRoleUser,
							Content: schemas.ChatCompletionMessageContent{ContentStr: &userContent},
						},
						{
							Role:    schemas.ChatCompletionMessageRoleAssistant,
							Content: schemas.ChatCompletionMessageContent{ContentStr: &assistantContent},
						},
						{
							Role:    schemas.ChatCompletionMessageRoleUser,
							Content: schemas.ChatCompletionMessageContent{ContentStr: &userContent2},
						},
					},
				},
			}
			
			routerReq, _, err := plugin.convertToRouterRequest(&ctx, bifrostReq)
			
			require.NoError(t, err)
			assert.Len(t, routerReq.Body.Messages, 3)
			assert.Equal(t, "user", routerReq.Body.Messages[0].Role)
			assert.Equal(t, "assistant", routerReq.Body.Messages[1].Role)
			assert.Equal(t, "user", routerReq.Body.Messages[2].Role)
		})
		
		t.Run("should extract HTTP headers from context", func(t *testing.T) {
			httpHeaders := map[string][]string{
				"Authorization": {"Bearer test123"},
				"Content-Type":  {"application/json"},
				"User-Agent":    {"test-client/1.0"},
			}
			
			ctx := context.WithValue(context.Background(), "http_headers", httpHeaders)
			content := "Test message"
			
			bifrostReq := &schemas.BifrostRequest{
				Model: "gpt-4o",
				Input: schemas.BifrostRequestInput{
					ChatCompletionInput: &[]schemas.ChatCompletionMessage{
						{
							Role:    schemas.ChatCompletionMessageRoleUser,
							Content: schemas.ChatCompletionMessageContent{ContentStr: &content},
						},
					},
				},
			}
			
			routerReq, headers, err := plugin.convertToRouterRequest(&ctx, bifrostReq)
			
			require.NoError(t, err)
			assert.Equal(t, httpHeaders, routerReq.Headers)
			assert.Equal(t, httpHeaders, headers)
		})
		
		t.Run("should handle empty chat completion input", func(t *testing.T) {
			bifrostReq := &schemas.BifrostRequest{
				Model: "gpt-4o",
				Input: schemas.BifrostRequestInput{
					ChatCompletionInput: nil,
				},
			}
			
			routerReq, _, err := plugin.convertToRouterRequest(&ctx, bifrostReq)
			
			require.NoError(t, err)
			assert.Empty(t, routerReq.Body.Messages)
		})
	})
}

// TestRoutingDecisionApplication tests applying routing decisions to requests
func TestRoutingDecisionApplication(t *testing.T) {
	t.Run("applyRoutingDecision method tests", func(t *testing.T) {
		plugin := createTestPlugin(t)
		ctx := context.Background()
		
		t.Run("should apply basic routing decision", func(t *testing.T) {
			content := "Test message"
			bifrostReq := &schemas.BifrostRequest{
				Model: "original-model",
				Input: schemas.BifrostRequestInput{
					ChatCompletionInput: &[]schemas.ChatCompletionMessage{
						{
							Role:    schemas.ChatCompletionMessageRoleUser,
							Content: schemas.ChatCompletionMessageContent{ContentStr: &content},
						},
					},
				},
			}
			
			response := &RouterResponse{
				Decision: RouterDecision{
					Kind:  "openai",
					Model: "gpt-4o",
					Fallbacks: []string{"gpt-3.5-turbo", "claude-3-sonnet"},
				},
				Bucket: BucketMid,
			}
			
			updatedReq, shortCircuit, err := plugin.applyRoutingDecision(&ctx, bifrostReq, response)
			
			require.NoError(t, err)
			assert.Nil(t, shortCircuit)
			assert.Equal(t, schemas.ModelProvider("openai"), updatedReq.Provider)
			assert.Equal(t, "gpt-4o", updatedReq.Model)
			
			// Check fallbacks conversion
			assert.Len(t, updatedReq.Fallbacks, 2)
			assert.Equal(t, "openai", string(updatedReq.Fallbacks[0].Provider))
			assert.Equal(t, "gpt-3.5-turbo", updatedReq.Fallbacks[0].Model)
			assert.Equal(t, "anthropic", string(updatedReq.Fallbacks[1].Provider))
			assert.Equal(t, "claude-3-sonnet", updatedReq.Fallbacks[1].Model)
		})
		
		t.Run("should handle empty fallbacks", func(t *testing.T) {
			content := "Test message"
			bifrostReq := &schemas.BifrostRequest{
				Model: "original-model",
				Input: schemas.BifrostRequestInput{
					ChatCompletionInput: &[]schemas.ChatCompletionMessage{
						{
							Role:    schemas.ChatCompletionMessageRoleUser,
							Content: schemas.ChatCompletionMessageContent{ContentStr: &content},
						},
					},
				},
			}
			
			response := &RouterResponse{
				Decision: RouterDecision{
					Kind:      "anthropic",
					Model:     "claude-3-5-sonnet",
					Fallbacks: []string{},
				},
				Bucket: BucketMid,
			}
			
			updatedReq, shortCircuit, err := plugin.applyRoutingDecision(&ctx, bifrostReq, response)
			
			require.NoError(t, err)
			assert.Nil(t, shortCircuit)
			assert.Equal(t, schemas.ModelProvider("anthropic"), updatedReq.Provider)
			assert.Equal(t, "claude-3-5-sonnet", updatedReq.Model)
			assert.Empty(t, updatedReq.Fallbacks)
		})
	})
}

// TestArtifactManagement tests routing artifact loading and caching
func TestArtifactManagement(t *testing.T) {
	t.Run("ensureCurrentArtifact method tests", func(t *testing.T) {
		t.Run("should load artifact from URL", func(t *testing.T) {
			// Create mock artifact server
			artifact := &AvengersArtifact{
				Version: "test-1.0.0",
				Alpha:   0.7,
				Thresholds: BucketThresholds{
					Cheap: 0.6,
					Hard:  0.3,
				},
				Qhat: map[string][]float64{
					"gpt-4o":       {0.9, 0.8, 0.7},
					"claude-3-5":   {0.85, 0.9, 0.8},
				},
				Chat: map[string]float64{
					"gpt-4o":     0.5,
					"claude-3-5": 0.6,
				},
			}
			
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(artifact)
			}))
			defer server.Close()
			
			plugin := createTestPluginWithArtifactURL(t, server.URL)
			
			err := plugin.ensureCurrentArtifact()
			
			require.NoError(t, err)
			require.NotNil(t, plugin.currentArtifact)
			assert.Equal(t, "test-1.0.0", plugin.currentArtifact.Version)
			assert.Equal(t, 0.7, plugin.currentArtifact.Alpha)
		})
		
		t.Run("should cache artifact and not reload frequently", func(t *testing.T) {
			requestCount := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestCount++
				artifact := &AvengersArtifact{Version: fmt.Sprintf("test-%d", requestCount)}
				json.NewEncoder(w).Encode(artifact)
			}))
			defer server.Close()
			
			plugin := createTestPluginWithArtifactURL(t, server.URL)
			
			// First load
			err := plugin.ensureCurrentArtifact()
			require.NoError(t, err)
			assert.Equal(t, 1, requestCount)
			
			// Second load immediately should use cache
			err = plugin.ensureCurrentArtifact()
			require.NoError(t, err)
			assert.Equal(t, 1, requestCount, "Should not make second request due to caching")
		})
		
		t.Run("should keep existing artifact on fetch failure", func(t *testing.T) {
			// First, successful load
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				artifact := &AvengersArtifact{Version: "cached-artifact"}
				json.NewEncoder(w).Encode(artifact)
			}))
			
			plugin := createTestPluginWithArtifactURL(t, server.URL)
			err := plugin.ensureCurrentArtifact()
			require.NoError(t, err)
			
			originalVersion := plugin.currentArtifact.Version
			server.Close() // Simulate server failure
			
			// Force reload attempt by clearing last load time
			plugin.lastArtifactLoad = time.Time{}
			
			err = plugin.ensureCurrentArtifact()
			assert.NoError(t, err, "Should not error when keeping existing artifact")
			assert.Equal(t, originalVersion, plugin.currentArtifact.Version, "Should keep original artifact")
		})
		
		t.Run("should fail when no artifact exists and load fails", func(t *testing.T) {
			plugin := createTestPluginWithArtifactURL(t, "http://nonexistent-url")
			
			err := plugin.ensureCurrentArtifact()
			
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "failed to fetch artifact")
		})
		
		t.Run("should handle malformed artifact JSON", func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte("invalid json"))
			}))
			defer server.Close()
			
			plugin := createTestPluginWithArtifactURL(t, server.URL)
			
			err := plugin.ensureCurrentArtifact()
			
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "failed to decode artifact")
		})
		
		t.Run("should handle HTTP error status codes", func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
			}))
			defer server.Close()
			
			plugin := createTestPluginWithArtifactURL(t, server.URL)
			
			err := plugin.ensureCurrentArtifact()
			
			assert.Error(t, err)
			assert.Contains(t, err.Error(), "artifact fetch failed with status 500")
		})
	})
}

// TestConcurrentRouting tests concurrent request handling
func TestConcurrentRouting(t *testing.T) {
	t.Run("concurrent decide calls", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		// Create multiple requests
		requests := make([]*RouterRequest, 10)
		for i := 0; i < 10; i++ {
			requests[i] = &RouterRequest{
				URL:    "/v1/chat/completions",
				Method: "POST",
				Body: &RequestBody{
					Messages: []ChatMessage{
						{Role: "user", Content: fmt.Sprintf("Test message %d", i)},
					},
				},
			}
		}
		
		// Process requests concurrently
		var wg sync.WaitGroup
		results := make([]*RouterResponse, 10)
		errors := make([]error, 10)
		
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				resp, err := plugin.decide(requests[idx], map[string][]string{})
				results[idx] = resp
				errors[idx] = err
			}(i)
		}
		
		wg.Wait()
		
		// Verify all requests processed successfully
		for i := 0; i < 10; i++ {
			assert.NoError(t, errors[i], "Request %d should not error", i)
			assert.NotNil(t, results[i], "Request %d should have response", i)
		}
	})
	
	t.Run("concurrent artifact loading", func(t *testing.T) {
		artifact := &AvengersArtifact{Version: "concurrent-test"}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Add small delay to test concurrency
			time.Sleep(10 * time.Millisecond)
			json.NewEncoder(w).Encode(artifact)
		}))
		defer server.Close()
		
		plugin := createTestPluginWithArtifactURL(t, server.URL)
		
		// Start multiple goroutines trying to load artifact
		var wg sync.WaitGroup
		errors := make([]error, 5)
		
		for i := 0; i < 5; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				errors[idx] = plugin.ensureCurrentArtifact()
			}(i)
		}
		
		wg.Wait()
		
		// All should succeed
		for i := 0; i < 5; i++ {
			assert.NoError(t, errors[i], "Concurrent load %d should succeed", i)
		}
		
		// Should only have loaded once
		assert.NotNil(t, plugin.currentArtifact)
	})
}

// TestPerformanceOptimization tests performance-related optimizations
func TestPerformanceOptimization(t *testing.T) {
	t.Run("feature extraction timeout handling", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		// Create request with very long content to test timeout
		longContent := strings.Repeat("This is a test message that will be very long. ", 10000)
		req := &RouterRequest{
			URL:    "/v1/chat/completions",
			Method: "POST",
			Body: &RequestBody{
				Messages: []ChatMessage{
					{Role: "user", Content: longContent},
				},
			},
		}
		
		// Set very short timeout
		start := time.Now()
		features, err := plugin.featureExtractor.Extract(req, plugin.currentArtifact, 1) // 1ms timeout
		
		// Should complete even with short timeout (graceful degradation)
		assert.NoError(t, err)
		assert.NotNil(t, features)
		
		// Should not take too long (should respect performance requirements)
		elapsed := time.Since(start)
		assert.Less(t, elapsed, 100*time.Millisecond, "Feature extraction should be fast")
	})
	
	t.Run("caching effectiveness", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		// Same request should use cached embedding
		content := "This is a test message for caching"
		req := &RouterRequest{
			URL:    "/v1/chat/completions",
			Method: "POST",
			Body: &RequestBody{
				Messages: []ChatMessage{
					{Role: "user", Content: content},
				},
			},
		}
		
		// First extraction
		start1 := time.Now()
		features1, err1 := plugin.featureExtractor.Extract(req, plugin.currentArtifact, 10000)
		elapsed1 := time.Since(start1)
		
		// Second extraction (should be cached)
		start2 := time.Now()
		features2, err2 := plugin.featureExtractor.Extract(req, plugin.currentArtifact, 10000)
		elapsed2 := time.Since(start2)
		
		require.NoError(t, err1)
		require.NoError(t, err2)
		
		// Results should be identical (cached)
		assert.Equal(t, features1.Embedding, features2.Embedding)
		
		// Second call should be faster (cached)
		assert.Less(t, elapsed2, elapsed1, "Cached call should be faster")
	})
	
	t.Run("memory efficient header processing", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		// Test with various header formats
		testCases := []map[string][]string{
			{"Authorization": {"Bearer test123"}},
			{"authorization": {"Bearer test123"}}, // lowercase
			{"Authorization": {"Bearer test1", "Bearer test2"}}, // multiple values
			{"Authorization": {""}}, // empty value
			{}, // no headers
		}
		
		for _, headers := range testCases {
			// Should not panic or allocate excessively
			adapter := plugin.authRegistry.FindMatch(headers)
			if adapter != nil {
				authInfo := adapter.Extract(headers)
				assert.NotNil(t, authInfo)
			}
		}
	})
}

// TestLoadBalancingAndFallbacks tests load balancing and fallback logic
func TestLoadBalancingAndFallbacks(t *testing.T) {
	t.Run("fallback model ordering", func(t *testing.T) {
		plugin := createTestPlugin(t)
		features := &RequestFeatures{ClusterID: 1, TokenCount: 5000}
		
		decision, err := plugin.selectModelForBucket("mid", features)
		
		require.NoError(t, err)
		assert.NotEmpty(t, decision.Fallbacks, "Should have fallback models")
		
		// Selected model should not be in fallbacks
		assert.NotContains(t, decision.Fallbacks, decision.Model)
		
		// All fallbacks should be from the same bucket
		for _, fallback := range decision.Fallbacks {
			assert.Contains(t, plugin.config.Router.MidCandidates, fallback)
		}
	})
	
	t.Run("provider preferences affect selection", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		cheapPrefs := plugin.getProviderPreferencesForBucket("cheap")
		midPrefs := plugin.getProviderPreferencesForBucket("mid")
		hardPrefs := plugin.getProviderPreferencesForBucket("hard")
		
		// Cheap should prioritize price
		assert.Equal(t, "price", cheapPrefs.Sort)
		
		// Mid and hard should prioritize quality
		assert.Equal(t, "quality", midPrefs.Sort)
		assert.Equal(t, "quality", hardPrefs.Sort)
		
		// Hard should have highest price tolerance
		assert.Greater(t, hardPrefs.MaxPrice, midPrefs.MaxPrice)
		assert.Greater(t, midPrefs.MaxPrice, cheapPrefs.MaxPrice)
	})
}

// TestErrorHandling tests comprehensive error handling scenarios
func TestErrorHandling(t *testing.T) {
	t.Run("malformed request handling", func(t *testing.T) {
		plugin := createTestPlugin(t)
		
		// Nil body
		req1 := &RouterRequest{
			URL:    "/v1/chat/completions",
			Method: "POST",
			Body:   nil,
		}
		
		response1, err1 := plugin.decide(req1, map[string][]string{})
		assert.NoError(t, err1) // Should handle gracefully
		assert.NotNil(t, response1)
		
		// Empty messages
		req2 := &RouterRequest{
			URL:    "/v1/chat/completions", 
			Method: "POST",
			Body: &RequestBody{
				Messages: []ChatMessage{},
			},
		}
		
		response2, err2 := plugin.decide(req2, map[string][]string{})
		assert.NoError(t, err2) // Should handle gracefully
		assert.NotNil(t, response2)
	})
	
	t.Run("missing configuration handling", func(t *testing.T) {
		// Test plugin with missing candidates
		config := createTestConfig()
		config.Router.MidCandidates = []string{} // Empty candidates
		
		plugin, err := createPluginWithConfig(t, config)
		require.NoError(t, err)
		
		features := &RequestFeatures{ClusterID: 1, TokenCount: 5000}
		_, err = plugin.selectModel(BucketMid, features, nil, false)
		
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "no candidates")
	})
	
	t.Run("alpha scorer edge cases", func(t *testing.T) {
		plugin := createTestPlugin(t)
		features := &RequestFeatures{ClusterID: 999, TokenCount: 1000} // Non-existent cluster
		
		// Should handle gracefully with fallback
		model, err := plugin.alphaScorer.SelectBest([]string{"test-model"}, features, plugin.currentArtifact)
		
		assert.NoError(t, err)
		assert.NotEmpty(t, model)
	})
}

// ============================================================================
// TEST HELPER FUNCTIONS
// ============================================================================

// createTestPlugin creates a fully configured plugin for testing
func createTestPlugin(t *testing.T) *Plugin {
	config := createTestConfig()
	plugin, err := createPluginWithConfig(t, config)
	require.NoError(t, err)
	
	// Set up test artifact
	plugin.currentArtifact = &AvengersArtifact{
		Version: "test-1.0.0",
		Alpha:   0.7,
		Thresholds: BucketThresholds{
			Cheap: 0.6,
			Hard:  0.3,
		},
		Penalties: PenaltyConfig{
			LatencySD:    2.0,
			CtxOver80Pct: 5.0,
		},
		Qhat: map[string][]float64{
			"qwen/qwen-2.5-coder-32b-instruct":        {0.75, 0.8, 0.7},
			"deepseek/deepseek-r1":                     {0.8, 0.85, 0.75},
			"openai/gpt-4o":                           {0.9, 0.85, 0.8},
			"anthropic/claude-3-5-sonnet-20241022":     {0.85, 0.9, 0.85},
			"google/gemini-1.5-pro":                   {0.8, 0.9, 0.9},
			"google/gemini-2.0-flash-thinking-exp":    {0.9, 0.95, 0.95},
			"openai/o1":                               {0.95, 0.9, 0.95},
			"anthropic/claude-3-opus":                 {0.9, 0.85, 0.9},
		},
		Chat: map[string]float64{
			"qwen/qwen-2.5-coder-32b-instruct":        0.1,
			"deepseek/deepseek-r1":                     0.15,
			"openai/gpt-4o":                           0.5,
			"anthropic/claude-3-5-sonnet-20241022":     0.6,
			"google/gemini-1.5-pro":                   0.4,
			"google/gemini-2.0-flash-thinking-exp":    0.8,
			"openai/o1":                               1.0,
			"anthropic/claude-3-opus":                 0.7,
		},
	}
	plugin.lastArtifactLoad = time.Now()
	
	return plugin
}

// createTestPluginWithoutArtifact creates a plugin without artifact for error testing
func createTestPluginWithoutArtifact(t *testing.T) *Plugin {
	config := createTestConfig()
	config.Tuning.ArtifactURL = "http://nonexistent-url"
	
	plugin, err := createPluginWithConfig(t, config)
	require.NoError(t, err)
	
	return plugin
}

// createTestPluginWithArtifactURL creates a plugin with specific artifact URL
func createTestPluginWithArtifactURL(t *testing.T, url string) *Plugin {
	config := createTestConfig()
	config.Tuning.ArtifactURL = url
	config.Tuning.ReloadSeconds = 1 * time.Second // Short reload for testing
	
	plugin, err := createPluginWithConfig(t, config)
	require.NoError(t, err)
	
	return plugin
}

// createTestConfig creates a standard test configuration
func createTestConfig() Config {
	return Config{
		Router: RouterConfig{
			Alpha: 0.7,
			Thresholds: BucketThresholds{
				Cheap: 0.6,
				Hard:  0.3,
			},
			TopP: 0.05,
			Penalties: PenaltyConfig{
				LatencySD:    2.0,
				CtxOver80Pct: 5.0,
			},
			BucketDefaults: BucketDefaults{
				Mid: BucketParams{
					GPT5ReasoningEffort:  "medium",
					GeminiThinkingBudget: 5000,
				},
				Hard: BucketParams{
					GPT5ReasoningEffort:  "high",
					GeminiThinkingBudget: 10000,
				},
			},
			CheapCandidates: []string{
				"qwen/qwen-2.5-coder-32b-instruct",
				"deepseek/deepseek-r1",
			},
			MidCandidates: []string{
				"openai/gpt-4o",
				"anthropic/claude-3-5-sonnet-20241022",
				"google/gemini-1.5-pro",
			},
			HardCandidates: []string{
				"google/gemini-2.0-flash-thinking-exp",
				"openai/o1", 
				"anthropic/claude-3-opus",
			},
			OpenRouter: OpenRouterConfig{
				ExcludeAuthors: []string{"huggingface"},
				Provider: ProviderPrefs{
					Sort:           "price",
					MaxPrice:       10,
					AllowFallbacks: true,
				},
			},
		},
		AuthAdapters: AuthAdaptersConfig{
			Enabled: []string{"openai-key", "anthropic-oauth", "google-oauth"},
		},
		Catalog: CatalogConfig{
			BaseURL:        "http://localhost:8001",
			RefreshSeconds: 3600,
		},
		Tuning: TuningConfig{
			ArtifactURL:   "http://localhost:8002/artifacts/latest",
			ReloadSeconds: 300,
		},
		Timeout:             25 * time.Millisecond,
		CacheTTL:           5 * time.Minute,
		MaxCacheSize:       10000,
		EmbeddingTimeout:   15 * time.Second,
		FeatureTimeout:     25 * time.Millisecond,
		EnableCaching:      true,
		EnableAuth:         true,
		EnableFallbacks:    true,
		EnableObservability: true,
		EnableExploration:  true,
	}
}

// createPluginWithConfig creates a plugin with the given configuration
func createPluginWithConfig(t *testing.T, config Config) (*Plugin, error) {
	return New(config)
}

// Helper function to check if slice contains string
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// Helper function to check if any candidate contains "gemini"
func containsGemini(candidates []string) bool {
	for _, candidate := range candidates {
		if strings.Contains(candidate, "gemini") {
			return true
		}
	}
	return false
}