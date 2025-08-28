package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// CatalogModelsResponse represents the response from the models endpoint
type CatalogModelsResponse struct {
	Models []ModelInfo `json:"models"`
}

// CatalogStatsResponse represents the response from the stats endpoint
type CatalogStatsResponse struct {
	TotalModels  int                 `json:"total_models"`
	Providers    map[string]int      `json:"providers"`
	LastUpdated  string              `json:"last_updated"`
}

// CatalogHealthResponse represents the response from the health endpoint
type CatalogHealthResponse struct {
	Status    string               `json:"status"`
	Timestamp string               `json:"timestamp"`
	Stats     CatalogStatsResponse `json:"stats"`
}

// FeatureFlagsResponse represents the response from the feature-flags endpoint
type FeatureFlagsResponse struct {
	Flags map[string]interface{} `json:"flags"`
}

// SimpleCacheEntry represents a cache entry with TTL
type SimpleCacheEntry struct {
	Value     interface{}
	ExpiresAt time.Time
}

// SimpleCache is a thread-safe cache with TTL
type SimpleCache struct {
	mutex   sync.RWMutex
	entries map[string]SimpleCacheEntry
	maxSize int
	ttl     time.Duration
}

// NewSimpleCache creates a new cache instance
func NewSimpleCache(maxSize int, ttl time.Duration) *SimpleCache {
	cache := &SimpleCache{
		entries: make(map[string]SimpleCacheEntry),
		maxSize: maxSize,
		ttl:     ttl,
	}
	
	// Start cleanup goroutine
	go cache.cleanupExpired()
	
	return cache
}

// Get retrieves a value from cache
func (c *SimpleCache) Get(key string) (interface{}, bool) {
	c.mutex.RLock()
	defer c.mutex.RUnlock()
	
	entry, exists := c.entries[key]
	if !exists || time.Now().After(entry.ExpiresAt) {
		return nil, false
	}
	
	return entry.Value, true
}

// Set stores a value in cache
func (c *SimpleCache) Set(key string, value interface{}) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	
	// Remove oldest entry if at max size
	if len(c.entries) >= c.maxSize {
		c.evictOldest()
	}
	
	c.entries[key] = SimpleCacheEntry{
		Value:     value,
		ExpiresAt: time.Now().Add(c.ttl),
	}
}

// Clear removes all entries
func (c *SimpleCache) Clear() {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.entries = make(map[string]SimpleCacheEntry)
}

// GetStats returns cache statistics
func (c *SimpleCache) GetStats() map[string]interface{} {
	c.mutex.RLock()
	defer c.mutex.RUnlock()
	
	return map[string]interface{}{
		"size":     len(c.entries),
		"max_size": c.maxSize,
		"ttl":      c.ttl.String(),
	}
}

// evictOldest removes the oldest entry (no lock needed - called from locked context)
func (c *SimpleCache) evictOldest() {
	var oldestKey string
	var oldestTime time.Time
	
	for key, entry := range c.entries {
		if oldestKey == "" || entry.ExpiresAt.Before(oldestTime) {
			oldestKey = key
			oldestTime = entry.ExpiresAt
		}
	}
	
	if oldestKey != "" {
		delete(c.entries, oldestKey)
	}
}

// cleanupExpired removes expired entries periodically
func (c *SimpleCache) cleanupExpired() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		c.mutex.Lock()
		now := time.Now()
		for key, entry := range c.entries {
			if now.After(entry.ExpiresAt) {
				delete(c.entries, key)
			}
		}
		c.mutex.Unlock()
	}
}

// CatalogClient is the HTTP client for the Catalog Service API
type CatalogClient struct {
	baseURL    string
	httpClient *http.Client
	cache      *SimpleCache
}

// NewCatalogClient creates a new catalog client
func NewCatalogClient(baseURL string) *CatalogClient {
	// Remove trailing slash
	baseURL = strings.TrimSuffix(baseURL, "/")
	
	return &CatalogClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		cache: NewSimpleCache(1000, 5*time.Minute),
	}
}

// GetModels retrieves models with optional filtering
func (c *CatalogClient) GetModels(ctx context.Context, params map[string]string) ([]ModelInfo, error) {
	// Build query string
	queryString := ""
	if len(params) > 0 {
		values := url.Values{}
		for k, v := range params {
			if v != "" {
				values.Add(k, v)
			}
		}
		queryString = values.Encode()
	}
	
	url := c.baseURL + "/v1/models"
	if queryString != "" {
		url += "?" + queryString
	}
	
	cacheKey := "models:" + queryString
	
	// Check cache
	if cached, exists := c.cache.Get(cacheKey); exists {
		if response, ok := cached.(CatalogModelsResponse); ok {
			return response.Models, nil
		}
	}
	
	// Fetch from API
	response, err := c.fetchWithRetry(ctx, url, 3, time.Second)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch models: %w", err)
	}
	
	var modelsResponse CatalogModelsResponse
	if err := json.Unmarshal(response, &modelsResponse); err != nil {
		return nil, fmt.Errorf("failed to parse models response: %w", err)
	}
	
	// Cache the response
	c.cache.Set(cacheKey, modelsResponse)
	
	return modelsResponse.Models, nil
}

// GetCapabilities retrieves capabilities for a specific model
func (c *CatalogClient) GetCapabilities(ctx context.Context, modelSlug string) (*ModelCapabilities, error) {
	encodedModel := url.QueryEscape(modelSlug)
	url := c.baseURL + "/v1/capabilities/" + encodedModel
	cacheKey := "capabilities:" + modelSlug
	
	// Check cache
	if cached, exists := c.cache.Get(cacheKey); exists {
		if capabilities, ok := cached.(ModelCapabilities); ok {
			return &capabilities, nil
		}
	}
	
	// Fetch from API
	response, err := c.fetchWithRetry(ctx, url, 3, time.Second)
	if err != nil {
		// Check if it's a 404 error
		if strings.Contains(err.Error(), "404") {
			return nil, nil // Graceful degradation
		}
		return nil, nil // Graceful degradation for other errors
	}
	
	var capabilities ModelCapabilities
	if err := json.Unmarshal(response, &capabilities); err != nil {
		return nil, nil // Graceful degradation
	}
	
	// Cache the response
	c.cache.Set(cacheKey, capabilities)
	
	return &capabilities, nil
}

// GetPricing retrieves pricing for a specific model
func (c *CatalogClient) GetPricing(ctx context.Context, modelSlug string) (*ModelPricing, error) {
	encodedModel := url.QueryEscape(modelSlug)
	url := c.baseURL + "/v1/pricing/" + encodedModel
	cacheKey := "pricing:" + modelSlug
	
	// Check cache
	if cached, exists := c.cache.Get(cacheKey); exists {
		if pricing, ok := cached.(ModelPricing); ok {
			return &pricing, nil
		}
	}
	
	// Fetch from API
	response, err := c.fetchWithRetry(ctx, url, 3, time.Second)
	if err != nil {
		// Check if it's a 404 error
		if strings.Contains(err.Error(), "404") {
			return nil, nil // Graceful degradation
		}
		return nil, nil // Graceful degradation for other errors
	}
	
	var pricing ModelPricing
	if err := json.Unmarshal(response, &pricing); err != nil {
		return nil, nil // Graceful degradation
	}
	
	// Cache the response
	c.cache.Set(cacheKey, pricing)
	
	return &pricing, nil
}

// GetFeatureFlags retrieves feature flags
func (c *CatalogClient) GetFeatureFlags(ctx context.Context) (map[string]interface{}, error) {
	url := c.baseURL + "/v1/feature-flags"
	cacheKey := "feature-flags"
	
	// Check cache
	if cached, exists := c.cache.Get(cacheKey); exists {
		if response, ok := cached.(FeatureFlagsResponse); ok {
			return response.Flags, nil
		}
	}
	
	// Fetch from API
	response, err := c.fetchWithRetry(ctx, url, 3, time.Second)
	if err != nil {
		return map[string]interface{}{}, nil // Graceful degradation
	}
	
	var flagsResponse FeatureFlagsResponse
	if err := json.Unmarshal(response, &flagsResponse); err != nil {
		return map[string]interface{}{}, nil // Graceful degradation
	}
	
	// Cache the response
	c.cache.Set(cacheKey, flagsResponse)
	
	return flagsResponse.Flags, nil
}

// GetHealth retrieves service health and statistics
func (c *CatalogClient) GetHealth(ctx context.Context) (*CatalogHealthResponse, error) {
	url := c.baseURL + "/health"
	
	response, err := c.fetchWithRetry(ctx, url, 3, time.Second)
	if err != nil {
		// Return default health response on error
		return &CatalogHealthResponse{
			Status:    "error",
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			Stats: CatalogStatsResponse{
				TotalModels: 0,
				Providers:   make(map[string]int),
				LastUpdated: time.Now().UTC().Format(time.RFC3339),
			},
		}, nil
	}
	
	var healthResponse CatalogHealthResponse
	if err := json.Unmarshal(response, &healthResponse); err != nil {
		// Return default health response on parse error
		return &CatalogHealthResponse{
			Status:    "error",
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			Stats: CatalogStatsResponse{
				TotalModels: 0,
				Providers:   make(map[string]int),
				LastUpdated: time.Now().UTC().Format(time.RFC3339),
			},
		}, nil
	}
	
	// Fill in defaults if missing
	if healthResponse.Status == "" {
		healthResponse.Status = "unknown"
	}
	if healthResponse.Timestamp == "" {
		healthResponse.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	
	return &healthResponse, nil
}

// GetProviderModels retrieves all models for a specific provider
func (c *CatalogClient) GetProviderModels(ctx context.Context, provider string) ([]ModelInfo, error) {
	return c.GetModels(ctx, map[string]string{"provider": provider})
}

// GetFamilyModels retrieves models by family
func (c *CatalogClient) GetFamilyModels(ctx context.Context, family string) ([]ModelInfo, error) {
	return c.GetModels(ctx, map[string]string{"family": family})
}

// FindModelsWithContext finds models that match context requirements
func (c *CatalogClient) FindModelsWithContext(ctx context.Context, minContext int) ([]ModelInfo, error) {
	allModels, err := c.GetModels(ctx, nil)
	if err != nil {
		return nil, err
	}
	
	var filteredModels []ModelInfo
	for _, model := range allModels {
		if model.CtxIn >= minContext {
			filteredModels = append(filteredModels, model)
		}
	}
	
	return filteredModels, nil
}

// FindModelsInPriceRange finds models within the specified price range
func (c *CatalogClient) FindModelsInPriceRange(ctx context.Context, maxInputPrice, maxOutputPrice float64) ([]ModelInfo, error) {
	allModels, err := c.GetModels(ctx, nil)
	if err != nil {
		return nil, err
	}
	
	var filteredModels []ModelInfo
	for _, model := range allModels {
		if model.Pricing.InPerMillion <= maxInputPrice &&
			model.Pricing.OutPerMillion <= maxOutputPrice {
			filteredModels = append(filteredModels, model)
		}
	}
	
	return filteredModels, nil
}

// ClearCache clears all cached data
func (c *CatalogClient) ClearCache() {
	c.cache.Clear()
}

// GetCacheStats returns cache statistics
func (c *CatalogClient) GetCacheStats() map[string]interface{} {
	return c.cache.GetStats()
}

// fetchWithRetry performs HTTP requests with retry logic
func (c *CatalogClient) fetchWithRetry(ctx context.Context, url string, retries int, delay time.Duration) ([]byte, error) {
	var lastErr error
	
	for attempt := 1; attempt <= retries; attempt++ {
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}
		
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Bifrost-Router/1.0")
		
		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			if attempt < retries {
				time.Sleep(delay * time.Duration(attempt))
				continue
			}
			return nil, fmt.Errorf("network error: %w", err)
		}
		defer resp.Body.Close()
		
		// Read response body
		var body []byte
		if resp.ContentLength >= 0 {
			body = make([]byte, 0, resp.ContentLength)
		}
		
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				body = append(body, buf[:n]...)
			}
			if err != nil {
				break
			}
		}
		
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			if resp.StatusCode >= 500 && attempt < retries {
				// Retry on server errors
				time.Sleep(delay * time.Duration(attempt))
				continue
			}
			// Don't retry on client errors (4xx)
			return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
		}
		
		return body, nil
	}
	
	return nil, fmt.Errorf("all retry attempts failed: %w", lastErr)
}

