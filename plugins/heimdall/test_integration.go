// +build integration

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"testing"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

// TestIntegration tests the full integration with the TypeScript router service
func TestIntegration(t *testing.T) {
	// Start TypeScript router service
	service, err := startRouterService()
	if err != nil {
		t.Fatalf("Failed to start router service: %v", err)
	}
	defer service.Process.Kill()

	// Wait for service to be ready
	if err := waitForService("http://localhost:3000/health", 30*time.Second); err != nil {
		t.Fatalf("Router service not ready: %v", err)
	}

	// Test plugin creation and basic functionality
	t.Run("PluginCreation", func(t *testing.T) {
		testPluginCreation(t)
	})

	t.Run("HealthCheck", func(t *testing.T) {
		testHealthCheck(t)
	})

	t.Run("RoutingDecision", func(t *testing.T) {
		testRoutingDecision(t)
	})

	t.Run("CachePerformance", func(t *testing.T) {
		testCachePerformance(t)
	})

	t.Run("ErrorHandling", func(t *testing.T) {
		testErrorHandling(t)
	})
}

func startRouterService() (*exec.Cmd, error) {
	cmd := exec.Command("npx", "tsx", "router_service.ts")
	cmd.Dir = "."
	
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start router service: %w", err)
	}

	return cmd, nil
}

func waitForService(url string, timeout time.Duration) error {
	client := &http.Client{Timeout: 5 * time.Second}
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(1 * time.Second)
	}

	return fmt.Errorf("service not ready after %v", timeout)
}

func testPluginCreation(t *testing.T) {
	config := map[string]interface{}{
		"mode":       "http",
		"router_url": "http://localhost:3000",
		"timeout":    "5s", // Longer timeout for integration tests
	}

	plugin, err := New(config)
	if err != nil {
		t.Fatalf("Failed to create plugin: %v", err)
	}

	if plugin.GetName() != "heimdall" {
		t.Errorf("Expected plugin name 'heimdall', got '%s'", plugin.GetName())
	}

	defer plugin.Cleanup()
}

func testHealthCheck(t *testing.T) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://localhost:3000/health")
	if err != nil {
		t.Fatalf("Health check failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Health check returned status %d", resp.StatusCode)
	}

	var health map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		t.Fatalf("Failed to decode health response: %v", err)
	}

	if status, ok := health["status"].(string); !ok || status != "healthy" {
		t.Errorf("Expected healthy status, got %v", status)
	}
}

func testRoutingDecision(t *testing.T) {
	config := map[string]interface{}{
		"mode":       "http",
		"router_url": "http://localhost:3000",
		"timeout":    "5s",
	}

	plugin, err := New(config)
	if err != nil {
		t.Fatalf("Failed to create plugin: %v", err)
	}
	defer plugin.Cleanup()

	ctx := context.Background()
	req := &schemas.BifrostRequest{
		Provider: "auto",
		Model:    "",
		Input: schemas.BifrostInput{
			ChatCompletionInput: []schemas.BifrostMessage{
				{
					Role: "user",
					Content: schemas.BifrostMessageContent{
						ContentStr: "Write a hello world program in Python",
					},
				},
			},
		},
		Params: map[string]interface{}{
			"max_tokens": 500,
		},
	}

	startTime := time.Now()
	modifiedReq, shortCircuit, err := plugin.PreHook(&ctx, req)
	duration := time.Since(startTime)

	if err != nil {
		t.Fatalf("PreHook failed: %v", err)
	}

	if shortCircuit != nil {
		t.Error("PreHook should not short circuit for valid request")
	}

	if modifiedReq.Provider == "auto" {
		t.Error("Provider should be modified from 'auto'")
	}

	if modifiedReq.Model == "" {
		t.Error("Model should be set")
	}

	// Check that routing decision was made quickly enough
	if duration > 100*time.Millisecond {
		t.Errorf("PreHook took too long: %v (should be <100ms)", duration)
	}

	// Check context enrichment
	if bucket := ctx.Value("heimdall_bucket"); bucket == nil {
		t.Error("Context should contain heimdall_bucket")
	}

	if decision := ctx.Value("heimdall_decision"); decision == nil {
		t.Error("Context should contain heimdall_decision")
	}

	log.Printf("Routing decision: provider=%s, model=%s, duration=%v", 
		modifiedReq.Provider, modifiedReq.Model, duration)
}

func testCachePerformance(t *testing.T) {
	config := map[string]interface{}{
		"mode":           "http",
		"router_url":     "http://localhost:3000",
		"enable_caching": true,
		"cache_ttl":      "1m",
	}

	plugin, err := New(config)
	if err != nil {
		t.Fatalf("Failed to create plugin: %v", err)
	}
	defer plugin.Cleanup()

	req := &schemas.BifrostRequest{
		Provider: "auto",
		Input: schemas.BifrostInput{
			ChatCompletionInput: []schemas.BifrostMessage{
				{
					Role: "user",
					Content: schemas.BifrostMessageContent{
						ContentStr: "Hello world",
					},
				},
			},
		},
	}

	// First request (cache miss)
	ctx1 := context.Background()
	start1 := time.Now()
	_, _, err = plugin.PreHook(&ctx1, req)
	duration1 := time.Since(start1)
	if err != nil {
		t.Fatalf("First PreHook failed: %v", err)
	}

	// Second request (cache hit)
	ctx2 := context.Background()
	start2 := time.Now()
	_, _, err = plugin.PreHook(&ctx2, req)
	duration2 := time.Since(start2)
	if err != nil {
		t.Fatalf("Second PreHook failed: %v", err)
	}

	// Cache hit should be significantly faster
	if duration2 >= duration1 {
		t.Errorf("Cache hit (%v) should be faster than cache miss (%v)", duration2, duration1)
	}

	// Check cache metrics
	metrics := plugin.GetMetrics()
	if cacheHits, ok := metrics["cache_hit_count"].(int64); !ok || cacheHits == 0 {
		t.Error("Expected cache hit to be recorded")
	}

	log.Printf("Cache performance: miss=%v, hit=%v", duration1, duration2)
}

func testErrorHandling(t *testing.T) {
	// Test with invalid router URL
	config := map[string]interface{}{
		"mode":       "http",
		"router_url": "http://localhost:9999", // Non-existent service
		"timeout":    "1s",
	}

	plugin, err := New(config)
	if err != nil {
		t.Fatalf("Failed to create plugin: %v", err)
	}
	defer plugin.Cleanup()

	ctx := context.Background()
	req := &schemas.BifrostRequest{
		Provider: "auto",
		Input: schemas.BifrostInput{
			ChatCompletionInput: []schemas.BifrostMessage{
				{
					Role: "user",
					Content: schemas.BifrostMessageContent{
						ContentStr: "Hello",
					},
				},
			},
		},
	}

	// Should handle error gracefully with fallback
	modifiedReq, shortCircuit, err := plugin.PreHook(&ctx, req)
	if err != nil {
		t.Fatalf("PreHook should handle errors gracefully: %v", err)
	}

	if shortCircuit != nil {
		t.Error("PreHook should not short circuit on error")
	}

	// Should fallback to safe default
	if modifiedReq.Provider != "openrouter" {
		t.Errorf("Expected fallback provider 'openrouter', got '%s'", modifiedReq.Provider)
	}

	// Check error was logged in context
	if fallbackReason := ctx.Value("heimdall_fallback_reason"); fallbackReason == nil {
		t.Error("Expected fallback reason in context")
	}

	// Check error metrics
	metrics := plugin.GetMetrics()
	if errorCount, ok := metrics["error_count"].(int64); !ok || errorCount == 0 {
		t.Error("Expected error to be recorded in metrics")
	}
}

func TestBenchmarkRouting(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping benchmark in short mode")
	}

	// Start service for benchmark
	service, err := startRouterService()
	if err != nil {
		t.Fatalf("Failed to start router service: %v", err)
	}
	defer service.Process.Kill()

	if err := waitForService("http://localhost:3000/health", 30*time.Second); err != nil {
		t.Fatalf("Router service not ready: %v", err)
	}

	config := map[string]interface{}{
		"mode":           "http",
		"router_url":     "http://localhost:3000",
		"enable_caching": true,
	}

	plugin, err := New(config)
	if err != nil {
		t.Fatalf("Failed to create plugin: %v", err)
	}
	defer plugin.Cleanup()

	req := &schemas.BifrostRequest{
		Provider: "auto",
		Input: schemas.BifrostInput{
			ChatCompletionInput: []schemas.BifrostMessage{
				{
					Role: "user",
					Content: schemas.BifrostMessageContent{
						ContentStr: "Benchmark request",
					},
				},
			},
		},
	}

	// Warm up cache
	ctx := context.Background()
	plugin.PreHook(&ctx, req)

	// Benchmark cached requests
	const numRequests = 100
	start := time.Now()

	for i := 0; i < numRequests; i++ {
		ctx := context.Background()
		_, _, err := plugin.PreHook(&ctx, req)
		if err != nil {
			t.Fatalf("Benchmark request %d failed: %v", i, err)
		}
	}

	duration := time.Since(start)
	avgDuration := duration / numRequests

	log.Printf("Benchmark: %d requests in %v (avg: %v per request)", 
		numRequests, duration, avgDuration)

	if avgDuration > 1*time.Millisecond {
		t.Errorf("Average cached request took %v, should be <1ms", avgDuration)
	}
}