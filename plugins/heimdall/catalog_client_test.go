package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Test helper functions
func createMockModelInfo(overrides map[string]interface{}) ModelInfo {
	model := ModelInfo{
		Slug:     "openai/gpt-5",
		Name:     "GPT-5",
		Provider: "openai",
		Family:   "gpt5",
		CtxIn:    128000,
		CtxOut:   8192,
		Pricing: ModelPricing{
			InPerMillion:  5.0,
			OutPerMillion: 15.0,
			Currency:      "USD",
		},
		Capabilities: ModelCapabilities{
			Reasoning:        true,
			Vision:           true,
			FunctionCalling:  true,
			StructuredOutput: true,
			Multimodal:       false,
			FineTuning:       false,
		},
		QualityTier: "flagship",
	}
	
	// Apply overrides
	if slug, ok := overrides["slug"].(string); ok {
		model.Slug = slug
	}
	if name, ok := overrides["name"].(string); ok {
		model.Name = name
	}
	if provider, ok := overrides["provider"].(string); ok {
		model.Provider = provider
	}
	if family, ok := overrides["family"].(string); ok {
		model.Family = family
	}
	if ctxIn, ok := overrides["ctx_in"].(int); ok {
		model.CtxIn = ctxIn
	}
	if ctxOut, ok := overrides["ctx_out"].(int); ok {
		model.CtxOut = ctxOut
	}
	if qualityTier, ok := overrides["quality_tier"].(string); ok {
		model.QualityTier = qualityTier
	}
	
	return model
}

func createMockCapabilities(overrides map[string]interface{}) ModelCapabilities {
	capabilities := ModelCapabilities{
		Reasoning:        true,
		Vision:           false,
		FunctionCalling:  true,
		StructuredOutput: true,
		Multimodal:       false,
		FineTuning:       false,
	}
	
	// Apply overrides
	if reasoning, ok := overrides["reasoning"].(bool); ok {
		capabilities.Reasoning = reasoning
	}
	if vision, ok := overrides["vision"].(bool); ok {
		capabilities.Vision = vision
	}
	if functionCalling, ok := overrides["function_calling"].(bool); ok {
		capabilities.FunctionCalling = functionCalling
	}
	if structuredOutput, ok := overrides["structured_output"].(bool); ok {
		capabilities.StructuredOutput = structuredOutput
	}
	if multimodal, ok := overrides["multimodal"].(bool); ok {
		capabilities.Multimodal = multimodal
	}
	if fineTuning, ok := overrides["fine_tuning"].(bool); ok {
		capabilities.FineTuning = fineTuning
	}
	
	return capabilities
}

func createMockPricing(overrides map[string]interface{}) ModelPricing {
	pricing := ModelPricing{
		InPerMillion:  5.0,
		OutPerMillion: 15.0,
		Currency:      "USD",
	}
	
	// Apply overrides
	if inPerMillion, ok := overrides["in_per_million"].(float64); ok {
		pricing.InPerMillion = inPerMillion
	}
	if outPerMillion, ok := overrides["out_per_million"].(float64); ok {
		pricing.OutPerMillion = outPerMillion
	}
	if currency, ok := overrides["currency"].(string); ok {
		pricing.Currency = currency
	}
	
	return pricing
}

// TestCatalogClient_Constructor tests the constructor
func TestCatalogClient_Constructor(t *testing.T) {
	t.Run("should initialize with base URL", func(t *testing.T) {
		client := NewCatalogClient("http://localhost:3001")
		if client == nil {
			t.Fatal("Expected client to be initialized")
		}
		if client.baseURL != "http://localhost:3001" {
			t.Errorf("Expected baseURL to be 'http://localhost:3001', got %s", client.baseURL)
		}
	})
	
	t.Run("should strip trailing slash from base URL", func(t *testing.T) {
		client := NewCatalogClient("http://localhost:3001/")
		if client.baseURL != "http://localhost:3001" {
			t.Errorf("Expected baseURL to be 'http://localhost:3001', got %s", client.baseURL)
		}
	})
}

// TestCatalogClient_GetModels tests the GetModels functionality
func TestCatalogClient_GetModels(t *testing.T) {
	t.Run("should fetch models without parameters", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{}),
				createMockModelInfo(map[string]interface{}{
					"slug":     "google/gemini-2.5-pro",
					"provider": "google",
				}),
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/models" {
				t.Errorf("Expected path '/v1/models', got %s", r.URL.Path)
			}
			if r.Header.Get("Content-Type") != "application/json" {
				t.Errorf("Expected Content-Type header 'application/json', got %s", r.Header.Get("Content-Type"))
			}
			if r.Header.Get("User-Agent") != "Bifrost-Router/1.0" {
				t.Errorf("Expected User-Agent header 'Bifrost-Router/1.0', got %s", r.Header.Get("User-Agent"))
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		models, err := client.GetModels(ctx, nil)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if len(models) != 2 {
			t.Errorf("Expected 2 models, got %d", len(models))
		}
		if models[0].Slug != "openai/gpt-5" {
			t.Errorf("Expected first model slug 'openai/gpt-5', got %s", models[0].Slug)
		}
		if models[1].Slug != "google/gemini-2.5-pro" {
			t.Errorf("Expected second model slug 'google/gemini-2.5-pro', got %s", models[1].Slug)
		}
	})
	
	t.Run("should fetch models with provider filter", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{"provider": "openai"}),
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			expectedURL := "/v1/models?provider=openai"
			if r.URL.String() != expectedURL {
				t.Errorf("Expected URL '%s', got %s", expectedURL, r.URL.String())
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		models, err := client.GetModels(ctx, map[string]string{"provider": "openai"})
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if len(models) != 1 {
			t.Errorf("Expected 1 model, got %d", len(models))
		}
		if models[0].Provider != "openai" {
			t.Errorf("Expected provider 'openai', got %s", models[0].Provider)
		}
	})
	
	t.Run("should fetch models with family filter", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{"family": "gpt5"}),
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			expectedURL := "/v1/models?family=gpt5"
			if r.URL.String() != expectedURL {
				t.Errorf("Expected URL '%s', got %s", expectedURL, r.URL.String())
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		models, err := client.GetModels(ctx, map[string]string{"family": "gpt5"})
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if len(models) != 1 {
			t.Errorf("Expected 1 model, got %d", len(models))
		}
		if models[0].Family != "gpt5" {
			t.Errorf("Expected family 'gpt5', got %s", models[0].Family)
		}
	})
	
	t.Run("should handle both provider and family filters", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{}),
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Check that both parameters are present
			provider := r.URL.Query().Get("provider")
			family := r.URL.Query().Get("family")
			
			if provider != "openai" {
				t.Errorf("Expected provider 'openai', got %s", provider)
			}
			if family != "gpt5" {
				t.Errorf("Expected family 'gpt5', got %s", family)
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		params := map[string]string{
			"provider": "openai",
			"family":   "gpt5",
		}
		
		models, err := client.GetModels(ctx, params)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if len(models) != 1 {
			t.Errorf("Expected 1 model, got %d", len(models))
		}
	})
	
	t.Run("should use cache for repeated requests", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{}),
			},
		}
		
		requestCount := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestCount++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		// First request
		models1, err := client.GetModels(ctx, nil)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		// Second request - should use cache
		models2, err := client.GetModels(ctx, nil)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if requestCount != 1 {
			t.Errorf("Expected 1 request (due to caching), got %d", requestCount)
		}
		
		if len(models1) != len(models2) || models1[0].Slug != models2[0].Slug {
			t.Errorf("Expected cached results to match original results")
		}
	})
	
	t.Run("should handle fetch errors", func(t *testing.T) {
		client := NewCatalogClient("http://invalid-url-12345")
		ctx := context.Background()
		
		_, err := client.GetModels(ctx, nil)
		if err == nil {
			t.Fatal("Expected error for invalid URL, got nil")
		}
		
		if !strings.Contains(err.Error(), "failed to fetch models") {
			t.Errorf("Expected error message to contain 'failed to fetch models', got %s", err.Error())
		}
	})
	
	t.Run("should handle HTTP error responses", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		_, err := client.GetModels(ctx, nil)
		if err == nil {
			t.Fatal("Expected error for 500 response, got nil")
		}
		
		if !strings.Contains(err.Error(), "500") {
			t.Errorf("Expected error message to contain '500', got %s", err.Error())
		}
	})
	
	t.Run("should handle JSON parsing errors", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte("invalid json"))
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		_, err := client.GetModels(ctx, nil)
		if err == nil {
			t.Fatal("Expected error for invalid JSON, got nil")
		}
		
		if !strings.Contains(err.Error(), "failed to parse") {
			t.Errorf("Expected error message to contain 'failed to parse', got %s", err.Error())
		}
	})
}

// TestCatalogClient_GetCapabilities tests the GetCapabilities functionality
func TestCatalogClient_GetCapabilities(t *testing.T) {
	t.Run("should fetch capabilities for a model", func(t *testing.T) {
		mockCapabilities := createMockCapabilities(map[string]interface{}{})
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// URL.Path is already decoded, so we expect the decoded path
			expectedPath := "/v1/capabilities/openai/gpt-5"
			if r.URL.Path != expectedPath {
				t.Errorf("Expected path '%s', got %s", expectedPath, r.URL.Path)
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockCapabilities)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		capabilities, err := client.GetCapabilities(ctx, "openai/gpt-5")
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if capabilities == nil {
			t.Fatal("Expected capabilities, got nil")
		}
		
		if !capabilities.Reasoning {
			t.Errorf("Expected reasoning capability to be true")
		}
	})
	
	t.Run("should return nil for 404 responses", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		capabilities, err := client.GetCapabilities(ctx, "unknown/model")
		if err != nil {
			t.Fatalf("Expected no error for 404, got %v", err)
		}
		
		if capabilities != nil {
			t.Errorf("Expected nil capabilities for 404, got %+v", capabilities)
		}
	})
	
	t.Run("should use cache for repeated requests", func(t *testing.T) {
		mockCapabilities := createMockCapabilities(map[string]interface{}{})
		
		requestCount := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestCount++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockCapabilities)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		// First request
		capabilities1, err := client.GetCapabilities(ctx, "openai/gpt-5")
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		// Second request - should use cache
		capabilities2, err := client.GetCapabilities(ctx, "openai/gpt-5")
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if requestCount != 1 {
			t.Errorf("Expected 1 request (due to caching), got %d", requestCount)
		}
		
		if capabilities1.Reasoning != capabilities2.Reasoning {
			t.Errorf("Expected cached results to match original results")
		}
	})
	
	t.Run("should handle network errors gracefully", func(t *testing.T) {
		client := NewCatalogClient("http://invalid-url-12345")
		ctx := context.Background()
		
		capabilities, err := client.GetCapabilities(ctx, "openai/gpt-5")
		if err != nil {
			t.Fatalf("Expected no error (graceful degradation), got %v", err)
		}
		
		if capabilities != nil {
			t.Errorf("Expected nil capabilities for network error, got %+v", capabilities)
		}
	})
	
	t.Run("should handle JSON parsing errors gracefully", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte("invalid json"))
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		capabilities, err := client.GetCapabilities(ctx, "openai/gpt-5")
		if err != nil {
			t.Fatalf("Expected no error (graceful degradation), got %v", err)
		}
		
		if capabilities != nil {
			t.Errorf("Expected nil capabilities for JSON error, got %+v", capabilities)
		}
	})
}

// TestCatalogClient_GetPricing tests the GetPricing functionality
func TestCatalogClient_GetPricing(t *testing.T) {
	t.Run("should fetch pricing for a model", func(t *testing.T) {
		mockPricing := createMockPricing(map[string]interface{}{})
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// URL.Path is already decoded, so we expect the decoded path  
			expectedPath := "/v1/pricing/openai/gpt-5"
			if r.URL.Path != expectedPath {
				t.Errorf("Expected path '%s', got %s", expectedPath, r.URL.Path)
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockPricing)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		pricing, err := client.GetPricing(ctx, "openai/gpt-5")
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if pricing == nil {
			t.Fatal("Expected pricing, got nil")
		}
		
		if pricing.InPerMillion != 5.0 {
			t.Errorf("Expected input pricing 5.0, got %f", pricing.InPerMillion)
		}
		if pricing.OutPerMillion != 15.0 {
			t.Errorf("Expected output pricing 15.0, got %f", pricing.OutPerMillion)
		}
	})
	
	t.Run("should return nil for 404 responses", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		pricing, err := client.GetPricing(ctx, "unknown/model")
		if err != nil {
			t.Fatalf("Expected no error for 404, got %v", err)
		}
		
		if pricing != nil {
			t.Errorf("Expected nil pricing for 404, got %+v", pricing)
		}
	})
	
	t.Run("should use cache for repeated requests", func(t *testing.T) {
		mockPricing := createMockPricing(map[string]interface{}{})
		
		requestCount := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestCount++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockPricing)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		// First request
		pricing1, err := client.GetPricing(ctx, "openai/gpt-5")
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		// Second request - should use cache
		pricing2, err := client.GetPricing(ctx, "openai/gpt-5")
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if requestCount != 1 {
			t.Errorf("Expected 1 request (due to caching), got %d", requestCount)
		}
		
		if pricing1.InPerMillion != pricing2.InPerMillion {
			t.Errorf("Expected cached results to match original results")
		}
	})
}

// TestCatalogClient_GetFeatureFlags tests the GetFeatureFlags functionality
func TestCatalogClient_GetFeatureFlags(t *testing.T) {
	t.Run("should fetch feature flags", func(t *testing.T) {
		mockFlags := FeatureFlagsResponse{
			Flags: map[string]interface{}{
				"advanced_routing": true,
				"beta_features":    false,
				"max_concurrency": 10,
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			expectedPath := "/v1/feature-flags"
			if r.URL.Path != expectedPath {
				t.Errorf("Expected path '%s', got %s", expectedPath, r.URL.Path)
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockFlags)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		flags, err := client.GetFeatureFlags(ctx)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if len(flags) != 3 {
			t.Errorf("Expected 3 feature flags, got %d", len(flags))
		}
		
		if advancedRouting, ok := flags["advanced_routing"].(bool); !ok || !advancedRouting {
			t.Errorf("Expected advanced_routing to be true")
		}
		
		if betaFeatures, ok := flags["beta_features"].(bool); !ok || betaFeatures {
			t.Errorf("Expected beta_features to be false")
		}
		
		if maxConcurrency, ok := flags["max_concurrency"].(float64); !ok || maxConcurrency != 10 {
			t.Errorf("Expected max_concurrency to be 10, got %v", maxConcurrency)
		}
	})
	
	t.Run("should use cache for repeated requests", func(t *testing.T) {
		mockFlags := FeatureFlagsResponse{
			Flags: map[string]interface{}{
				"test_flag": true,
			},
		}
		
		requestCount := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestCount++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockFlags)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		// First request
		flags1, err := client.GetFeatureFlags(ctx)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		// Second request - should use cache
		flags2, err := client.GetFeatureFlags(ctx)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if requestCount != 1 {
			t.Errorf("Expected 1 request (due to caching), got %d", requestCount)
		}
		
		if len(flags1) != len(flags2) {
			t.Errorf("Expected cached results to match original results")
		}
	})
	
	t.Run("should return empty map on error", func(t *testing.T) {
		client := NewCatalogClient("http://invalid-url-12345")
		ctx := context.Background()
		
		flags, err := client.GetFeatureFlags(ctx)
		if err != nil {
			t.Fatalf("Expected no error (graceful degradation), got %v", err)
		}
		
		if flags == nil {
			t.Fatal("Expected empty map, got nil")
		}
		
		if len(flags) != 0 {
			t.Errorf("Expected empty flags map, got %d flags", len(flags))
		}
	})
}

// TestCatalogClient_GetHealth tests the GetHealth functionality
func TestCatalogClient_GetHealth(t *testing.T) {
	t.Run("should fetch health status", func(t *testing.T) {
		mockHealth := CatalogHealthResponse{
			Status:    "healthy",
			Timestamp: "2024-01-01T00:00:00Z",
			Stats: CatalogStatsResponse{
				TotalModels: 42,
				Providers:   map[string]int{"openai": 10, "google": 8},
				LastUpdated: "2024-01-01T00:00:00Z",
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			expectedPath := "/health"
			if r.URL.Path != expectedPath {
				t.Errorf("Expected path '%s', got %s", expectedPath, r.URL.Path)
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockHealth)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		health, err := client.GetHealth(ctx)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if health == nil {
			t.Fatal("Expected health response, got nil")
		}
		
		if health.Status != "healthy" {
			t.Errorf("Expected status 'healthy', got %s", health.Status)
		}
		
		if health.Stats.TotalModels != 42 {
			t.Errorf("Expected 42 total models, got %d", health.Stats.TotalModels)
		}
		
		if health.Stats.Providers["openai"] != 10 {
			t.Errorf("Expected 10 OpenAI models, got %d", health.Stats.Providers["openai"])
		}
	})
	
	t.Run("should return default health on error", func(t *testing.T) {
		client := NewCatalogClient("http://invalid-url-12345")
		ctx := context.Background()
		
		health, err := client.GetHealth(ctx)
		if err != nil {
			t.Fatalf("Expected no error (graceful degradation), got %v", err)
		}
		
		if health == nil {
			t.Fatal("Expected health response, got nil")
		}
		
		if health.Status != "error" {
			t.Errorf("Expected status 'error', got %s", health.Status)
		}
		
		if health.Stats.TotalModels != 0 {
			t.Errorf("Expected 0 total models, got %d", health.Stats.TotalModels)
		}
	})
	
	t.Run("should fill in defaults for missing fields", func(t *testing.T) {
		// Response with missing fields
		incompleteHealth := map[string]interface{}{
			"stats": map[string]interface{}{
				"total_models": 5,
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(incompleteHealth)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		health, err := client.GetHealth(ctx)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if health.Status != "unknown" {
			t.Errorf("Expected default status 'unknown', got %s", health.Status)
		}
		
		if health.Timestamp == "" {
			t.Errorf("Expected timestamp to be filled in")
		}
	})
}

// TestCatalogClient_ConvenienceMethods tests convenience methods
func TestCatalogClient_ConvenienceMethods(t *testing.T) {
	t.Run("GetProviderModels should filter by provider", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{"provider": "openai"}),
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("provider") != "openai" {
				t.Errorf("Expected provider filter 'openai'")
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		models, err := client.GetProviderModels(ctx, "openai")
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if len(models) != 1 {
			t.Errorf("Expected 1 model, got %d", len(models))
		}
		
		if models[0].Provider != "openai" {
			t.Errorf("Expected provider 'openai', got %s", models[0].Provider)
		}
	})
	
	t.Run("GetFamilyModels should filter by family", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{"family": "gpt5"}),
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("family") != "gpt5" {
				t.Errorf("Expected family filter 'gpt5'")
			}
			
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		models, err := client.GetFamilyModels(ctx, "gpt5")
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if len(models) != 1 {
			t.Errorf("Expected 1 model, got %d", len(models))
		}
		
		if models[0].Family != "gpt5" {
			t.Errorf("Expected family 'gpt5', got %s", models[0].Family)
		}
	})
	
	t.Run("FindModelsWithContext should filter by context size", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{"ctx_in": 128000}),
				createMockModelInfo(map[string]interface{}{"ctx_in": 64000}),
				createMockModelInfo(map[string]interface{}{"ctx_in": 32000}),
			},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		models, err := client.FindModelsWithContext(ctx, 64000)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		// Should return models with context >= 64000
		if len(models) != 2 {
			t.Errorf("Expected 2 models with context >= 64000, got %d", len(models))
		}
		
		for _, model := range models {
			if model.CtxIn < 64000 {
				t.Errorf("Expected all models to have context >= 64000, got %d", model.CtxIn)
			}
		}
	})
	
	t.Run("FindModelsInPriceRange should filter by price", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{
				createMockModelInfo(map[string]interface{}{}), // 5.0 in, 15.0 out - should match
				createMockModelInfo(map[string]interface{}{    // 20.0 in, 30.0 out - should not match
					"slug": "expensive/model",
					"pricing": map[string]interface{}{
						"in_per_million":  20.0,
						"out_per_million": 30.0,
						"currency":        "USD",
					},
				}),
			},
		}
		
		// Manually set pricing for the expensive model since map override is limited
		mockModels.Models[1].Pricing = ModelPricing{
			InPerMillion:  20.0,
			OutPerMillion: 30.0,
			Currency:      "USD",
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		models, err := client.FindModelsInPriceRange(ctx, 10.0, 20.0)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		// Should return only the model within price range
		if len(models) != 1 {
			t.Errorf("Expected 1 model within price range, got %d", len(models))
		}
		
		if len(models) > 0 && models[0].Pricing.InPerMillion > 10.0 {
			t.Errorf("Expected input price <= 10.0, got %f", models[0].Pricing.InPerMillion)
		}
	})
}

// TestCatalogClient_CacheManagement tests cache functionality
func TestCatalogClient_CacheManagement(t *testing.T) {
	t.Run("ClearCache should clear all cached data", func(t *testing.T) {
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{createMockModelInfo(map[string]interface{}{})},
		}
		
		requestCount := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestCount++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		// First request
		_, err := client.GetModels(ctx, nil)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		// Second request - should use cache
		_, err = client.GetModels(ctx, nil)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if requestCount != 1 {
			t.Errorf("Expected 1 request before cache clear, got %d", requestCount)
		}
		
		// Clear cache
		client.ClearCache()
		
		// Third request - should make new request
		_, err = client.GetModels(ctx, nil)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		
		if requestCount != 2 {
			t.Errorf("Expected 2 requests after cache clear, got %d", requestCount)
		}
	})
	
	t.Run("GetCacheStats should return cache statistics", func(t *testing.T) {
		client := NewCatalogClient("http://localhost:3001")
		
		stats := client.GetCacheStats()
		if stats == nil {
			t.Fatal("Expected cache stats, got nil")
		}
		
		if _, ok := stats["size"]; !ok {
			t.Errorf("Expected cache stats to include 'size'")
		}
		
		if _, ok := stats["max_size"]; !ok {
			t.Errorf("Expected cache stats to include 'max_size'")
		}
		
		if _, ok := stats["ttl"]; !ok {
			t.Errorf("Expected cache stats to include 'ttl'")
		}
	})
}

// TestCatalogClient_RetryLogic tests retry functionality
func TestCatalogClient_RetryLogic(t *testing.T) {
	t.Run("should retry on server errors", func(t *testing.T) {
		attemptCount := 0
		mockModels := CatalogModelsResponse{
			Models: []ModelInfo{createMockModelInfo(map[string]interface{}{})},
		}
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			attemptCount++
			if attemptCount < 3 {
				// First two attempts fail with server error
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}
			// Third attempt succeeds
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(mockModels)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		models, err := client.GetModels(ctx, nil)
		if err != nil {
			t.Fatalf("Expected success after retries, got %v", err)
		}
		
		if attemptCount != 3 {
			t.Errorf("Expected 3 attempts, got %d", attemptCount)
		}
		
		if len(models) != 1 {
			t.Errorf("Expected 1 model, got %d", len(models))
		}
	})
	
	t.Run("should not retry on client errors", func(t *testing.T) {
		attemptCount := 0
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			attemptCount++
			http.Error(w, "Bad Request", http.StatusBadRequest)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		_, err := client.GetModels(ctx, nil)
		if err == nil {
			t.Fatal("Expected error for client error, got nil")
		}
		
		if attemptCount != 1 {
			t.Errorf("Expected 1 attempt (no retry on client error), got %d", attemptCount)
		}
		
		if !strings.Contains(err.Error(), "400") {
			t.Errorf("Expected error to contain '400', got %s", err.Error())
		}
	})
	
	t.Run("should timeout after max retries", func(t *testing.T) {
		attemptCount := 0
		
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			attemptCount++
			// Always fail with server error
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx := context.Background()
		
		_, err := client.GetModels(ctx, nil)
		if err == nil {
			t.Fatal("Expected error after max retries, got nil")
		}
		
		if attemptCount != 3 {
			t.Errorf("Expected 3 attempts (max retries), got %d", attemptCount)
		}
	})
}

// TestCatalogClient_ContextHandling tests context handling
func TestCatalogClient_ContextHandling(t *testing.T) {
	t.Run("should respect context cancellation", func(t *testing.T) {
		// Server that never responds
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done() // Wait for context cancellation
		}))
		defer server.Close()
		
		client := NewCatalogClient(server.URL)
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		
		_, err := client.GetModels(ctx, nil)
		if err == nil {
			t.Fatal("Expected error due to context timeout, got nil")
		}
		
		if !strings.Contains(err.Error(), "context") && !strings.Contains(err.Error(), "timeout") {
			t.Errorf("Expected context-related error, got %s", err.Error())
		}
	})
}

// TestSimpleCache tests the cache implementation
func TestSimpleCache(t *testing.T) {
	t.Run("should store and retrieve values", func(t *testing.T) {
		cache := NewSimpleCache(10, time.Minute)
		
		cache.Set("key1", "value1")
		
		value, exists := cache.Get("key1")
		if !exists {
			t.Fatal("Expected key to exist in cache")
		}
		
		if value != "value1" {
			t.Errorf("Expected 'value1', got %v", value)
		}
	})
	
	t.Run("should handle TTL expiration", func(t *testing.T) {
		cache := NewSimpleCache(10, 50*time.Millisecond)
		
		cache.Set("key1", "value1")
		
		// Should exist immediately
		_, exists := cache.Get("key1")
		if !exists {
			t.Fatal("Expected key to exist immediately after set")
		}
		
		// Wait for TTL expiration
		time.Sleep(100 * time.Millisecond)
		
		// Should not exist after TTL
		_, exists = cache.Get("key1")
		if exists {
			t.Fatal("Expected key to be expired after TTL")
		}
	})
	
	t.Run("should evict oldest entry when at max size", func(t *testing.T) {
		cache := NewSimpleCache(2, time.Minute)
		
		cache.Set("key1", "value1")
		cache.Set("key2", "value2")
		
		// Both should exist
		_, exists1 := cache.Get("key1")
		_, exists2 := cache.Get("key2")
		if !exists1 || !exists2 {
			t.Fatal("Expected both keys to exist before eviction")
		}
		
		// Adding third should evict oldest
		cache.Set("key3", "value3")
		
		// key1 should be evicted, key2 and key3 should exist
		_, exists1 = cache.Get("key1")
		_, exists2 = cache.Get("key2")
		_, exists3 := cache.Get("key3")
		
		if exists1 {
			t.Error("Expected key1 to be evicted")
		}
		if !exists2 {
			t.Error("Expected key2 to still exist")
		}
		if !exists3 {
			t.Error("Expected key3 to exist")
		}
	})
	
	t.Run("should clear all entries", func(t *testing.T) {
		cache := NewSimpleCache(10, time.Minute)
		
		cache.Set("key1", "value1")
		cache.Set("key2", "value2")
		
		cache.Clear()
		
		_, exists1 := cache.Get("key1")
		_, exists2 := cache.Get("key2")
		
		if exists1 || exists2 {
			t.Error("Expected all keys to be cleared")
		}
	})
	
	t.Run("should return statistics", func(t *testing.T) {
		cache := NewSimpleCache(10, time.Minute)
		
		cache.Set("key1", "value1")
		
		stats := cache.GetStats()
		if stats["size"] != 1 {
			t.Errorf("Expected size 1, got %v", stats["size"])
		}
		if stats["max_size"] != 10 {
			t.Errorf("Expected max_size 10, got %v", stats["max_size"])
		}
	})
}