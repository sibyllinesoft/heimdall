// Package heimdall provides a native Go Bifrost plugin that implements intelligent
// routing decisions using GBDT triage and α-score model selection.
// This is a direct port of the TypeScript Heimdall router logic.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

// Config holds the native configuration for the Heimdall plugin
type Config struct {
	// Core routing configuration
	Router RouterConfig `json:"router"`
	
	// Authentication adapters configuration
	AuthAdapters AuthAdaptersConfig `json:"auth_adapters"`
	
	// Catalog service configuration
	Catalog CatalogConfig `json:"catalog"`
	
	// Tuning/artifact configuration
	Tuning TuningConfig `json:"tuning"`
	
	// Performance and caching settings
	Timeout              time.Duration `json:"timeout"`
	CacheTTL            time.Duration `json:"cache_ttl"`
	MaxCacheSize        int           `json:"max_cache_size"`
	EmbeddingTimeout    time.Duration `json:"embedding_timeout"`
	FeatureTimeout      time.Duration `json:"feature_timeout"`
	
	// Feature flags
	EnableCaching      bool `json:"enable_caching"`
	EnableAuth         bool `json:"enable_auth"`
	EnableFallbacks    bool `json:"enable_fallbacks"`
	EnableObservability bool `json:"enable_observability"`
	EnableExploration   bool `json:"enable_exploration"`
}

// RouterConfig represents the core routing configuration
type RouterConfig struct {
	Alpha      float64                  `json:"alpha"`
	Thresholds BucketThresholds         `json:"thresholds"`
	TopP       int                      `json:"top_p"`
	Penalties  PenaltyConfig           `json:"penalties"`
	BucketDefaults BucketDefaults       `json:"bucket_defaults"`
	CheapCandidates []string            `json:"cheap_candidates"`
	MidCandidates   []string            `json:"mid_candidates"`
	HardCandidates  []string            `json:"hard_candidates"`
	OpenRouter     OpenRouterConfig     `json:"openrouter"`
}

type BucketThresholds struct {
	Cheap float64 `json:"cheap"`
	Hard  float64 `json:"hard"`
}

type PenaltyConfig struct {
	LatencySD     float64 `json:"latency_sd"`
	CtxOver80Pct  float64 `json:"ctx_over_80pct"`
}

type BucketDefaults struct {
	Mid  BucketParams `json:"mid"`
	Hard BucketParams `json:"hard"`
}

type BucketParams struct {
	GPT5ReasoningEffort   string `json:"gpt5_reasoning_effort"`
	GeminiThinkingBudget int    `json:"gemini_thinking_budget"`
}

type OpenRouterConfig struct {
	ExcludeAuthors []string      `json:"exclude_authors"`
	Provider       ProviderPrefs `json:"provider"`
}

type AuthAdaptersConfig struct {
	Enabled []string `json:"enabled"`
}

type CatalogConfig struct {
	BaseURL        string        `json:"base_url"`
	RefreshSeconds time.Duration `json:"refresh_seconds"`
}

type TuningConfig struct {
	ArtifactURL   string        `json:"artifact_url"`
	ReloadSeconds time.Duration `json:"reload_seconds"`
}

// RouterRequest represents internal routing request
type RouterRequest struct {
	URL     string                    `json:"url"`
	Method  string                    `json:"method"`
	Headers map[string][]string       `json:"headers"`
	Body    *RequestBody              `json:"body,omitempty"`
}

type RequestBody struct {
	Messages []ChatMessage `json:"messages"`
	Model    string        `json:"model,omitempty"`
	Stream   bool          `json:"stream,omitempty"`
	Params   map[string]interface{} `json:"-"` // Additional params
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// RouterResponse represents the native routing response
type RouterResponse struct {
	Decision            RouterDecision      `json:"decision"`
	Features            RequestFeatures     `json:"features"`
	Bucket              Bucket              `json:"bucket"`
	BucketProbabilities BucketProbabilities `json:"bucket_probabilities"`
	AuthInfo            *AuthInfo           `json:"auth_info"`
	FallbackReason      string              `json:"fallback_reason,omitempty"`
}

// Bucket represents the bucket type
type Bucket string

const (
	BucketCheap Bucket = "cheap"
	BucketMid   Bucket = "mid" 
	BucketHard  Bucket = "hard"
)

// RouterDecision represents the routing decision 
type RouterDecision struct {
	Kind          string                 `json:"kind"`
	Model         string                 `json:"model"`
	Params        map[string]interface{} `json:"params"`
	ProviderPrefs ProviderPrefs          `json:"provider_prefs"`
	Auth          AuthConfig             `json:"auth"`
	Fallbacks     []string               `json:"fallbacks"`
}

// ProviderPrefs represents provider preferences
type ProviderPrefs struct {
	Sort          string `json:"sort"`
	MaxPrice      int    `json:"max_price"`
	AllowFallbacks bool  `json:"allow_fallbacks"`
}

// AuthConfig represents authentication configuration
type AuthConfig struct {
	Mode     string `json:"mode"`
	TokenRef string `json:"token_ref,omitempty"`
}

// RequestFeatures represents extracted request features
type RequestFeatures struct {
	Embedding         []float64 `json:"embedding"`
	ClusterID         int       `json:"cluster_id"`
	TopPDistances     []float64 `json:"top_p_distances"`
	TokenCount        int       `json:"token_count"`
	HasCode          bool      `json:"has_code"`
	HasMath          bool      `json:"has_math"`
	NgramEntropy     float64   `json:"ngram_entropy"`
	ContextRatio     float64   `json:"context_ratio"`
	UserSuccessRate  *float64  `json:"user_success_rate,omitempty"`
	AvgLatency       *float64  `json:"avg_latency,omitempty"`
}

// BucketProbabilities represents bucket classification probabilities
type BucketProbabilities struct {
	Cheap float64 `json:"cheap"`
	Mid   float64 `json:"mid"`
	Hard  float64 `json:"hard"`
}

// AuthInfo represents authentication information
type AuthInfo struct {
	Provider string `json:"provider"`
	Type     string `json:"type"`
	Token    string `json:"token"`
}

// AvengersArtifact represents the ML artifact for routing decisions
type AvengersArtifact struct {
	Version    string                     `json:"version"`
	Centroids  string                    `json:"centroids"`  // path to FAISS index
	Alpha      float64                   `json:"alpha"`
	Thresholds BucketThresholds          `json:"thresholds"`
	Penalties  PenaltyConfig             `json:"penalties"`
	Qhat       map[string][]float64      `json:"qhat"`  // model -> cluster quality scores
	Chat       map[string]float64        `json:"chat"`  // model -> normalized cost
	GBDT       GBDTConfig                `json:"gbdt"`
}

type GBDTConfig struct {
	Framework     string                 `json:"framework"`
	ModelPath     string                 `json:"model_path"`
	FeatureSchema map[string]interface{} `json:"feature_schema"`
}

// ModelScore represents a model's alpha score breakdown
type ModelScore struct {
	Model        string  `json:"model"`
	QualityScore float64 `json:"quality_score"`
	CostScore    float64 `json:"cost_score"`
	PenaltyScore float64 `json:"penalty_score"`
	AlphaScore   float64 `json:"alpha_score"`
}

// CacheEntry represents a cached routing decision
type CacheEntry struct {
	Response  RouterResponse
	ExpiresAt time.Time
}

// ============================================================================
// CORE NATIVE GO COMPONENTS
// Direct ports of TypeScript logic for GBDT triage and α-score routing
// ============================================================================

// AuthAdapter represents an authentication adapter
type AuthAdapter interface {
	GetID() string
	Matches(headers map[string][]string) bool
	Extract(headers map[string][]string) *AuthInfo
	Apply(outgoing *http.Request) *http.Request
}

// AuthAdapterRegistry manages authentication adapters
type AuthAdapterRegistry struct {
	adapters map[string]AuthAdapter
	mu       sync.RWMutex
}

func NewAuthAdapterRegistry() *AuthAdapterRegistry {
	return &AuthAdapterRegistry{
		adapters: make(map[string]AuthAdapter),
	}
}

func (r *AuthAdapterRegistry) Register(adapter AuthAdapter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.adapters[adapter.GetID()] = adapter
}

func (r *AuthAdapterRegistry) Get(id string) AuthAdapter {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.adapters[id]
}

func (r *AuthAdapterRegistry) GetEnabled(enabledIDs []string) []AuthAdapter {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	var enabled []AuthAdapter
	for _, id := range enabledIDs {
		if adapter, exists := r.adapters[id]; exists {
			enabled = append(enabled, adapter)
		}
	}
	return enabled
}

func (r *AuthAdapterRegistry) FindMatch(headers map[string][]string) AuthAdapter {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	for _, adapter := range r.adapters {
		if adapter.Matches(headers) {
			return adapter
		}
	}
	return nil
}

// OpenAIKeyAdapter handles OpenAI API key authentication
type OpenAIKeyAdapter struct{}

func (a *OpenAIKeyAdapter) GetID() string { return "openai-key" }

func (a *OpenAIKeyAdapter) Matches(headers map[string][]string) bool {
	auth := getHeaderValue(headers, "Authorization")
	return strings.HasPrefix(auth, "Bearer sk-")
}

func (a *OpenAIKeyAdapter) Extract(headers map[string][]string) *AuthInfo {
	auth := getHeaderValue(headers, "Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil
	}
	return &AuthInfo{
		Provider: "openai",
		Type:     "bearer",
		Token:    strings.TrimPrefix(auth, "Bearer "),
	}
}

func (a *OpenAIKeyAdapter) Apply(outgoing *http.Request) *http.Request {
	return outgoing // No modification needed for API keys
}

// AnthropicOAuthAdapter handles Anthropic OAuth
type AnthropicOAuthAdapter struct{}

func (a *AnthropicOAuthAdapter) GetID() string { return "anthropic-oauth" }

func (a *AnthropicOAuthAdapter) Matches(headers map[string][]string) bool {
	auth := getHeaderValue(headers, "Authorization")
	return strings.HasPrefix(auth, "Bearer anthropic_")
}

func (a *AnthropicOAuthAdapter) Extract(headers map[string][]string) *AuthInfo {
	auth := getHeaderValue(headers, "Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil
	}
	return &AuthInfo{
		Provider: "anthropic",
		Type:     "bearer",
		Token:    strings.TrimPrefix(auth, "Bearer "),
	}
}

func (a *AnthropicOAuthAdapter) Apply(outgoing *http.Request) *http.Request {
	return outgoing
}

// GeminiOAuthAdapter handles Google Gemini OAuth
type GeminiOAuthAdapter struct{}

func (a *GeminiOAuthAdapter) GetID() string { return "google-oauth" }

func (a *GeminiOAuthAdapter) Matches(headers map[string][]string) bool {
	auth := getHeaderValue(headers, "Authorization")
	return strings.HasPrefix(auth, "Bearer ya29.")
}

func (a *GeminiOAuthAdapter) Extract(headers map[string][]string) *AuthInfo {
	auth := getHeaderValue(headers, "Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil
	}
	return &AuthInfo{
		Provider: "google",
		Type:     "bearer",
		Token:    strings.TrimPrefix(auth, "Bearer "),
	}
}

func (a *GeminiOAuthAdapter) Apply(outgoing *http.Request) *http.Request {
	return outgoing
}

// FeatureExtractor implements native feature extraction (port of features.ts)
type FeatureExtractor struct {
	embeddingCache sync.Map // string -> []float64
	mu             sync.RWMutex
}

func NewFeatureExtractor() *FeatureExtractor {
	return &FeatureExtractor{}
}

func (fe *FeatureExtractor) Extract(req *RouterRequest, artifact *AvengersArtifact, timeoutMs int) (*RequestFeatures, error) {
	startTime := time.Now()
	
	// Extract prompt text from messages
	promptText := fe.extractPromptText(req)
	
	// Get embedding (with caching)
	embedding := fe.getEmbedding(promptText)
	
	// Find nearest clusters (simplified - in production would use FAISS)
	nearestClusters := fe.findNearestClusters(embedding, 5)
	
	// Extract lexical features
	lexFeatures := fe.extractLexicalFeatures(promptText)
	
	// Context analysis
	tokenCount := fe.estimateTokens(promptText)
	contextRatio := fe.calculateContextRatio(tokenCount)
	
	features := &RequestFeatures{
		Embedding:     embedding,
		ClusterID:     fe.getTopCluster(nearestClusters),
		TopPDistances: fe.getTopDistances(nearestClusters),
		TokenCount:    tokenCount,
		HasCode:       lexFeatures.hasCode,
		HasMath:       lexFeatures.hasMath,
		NgramEntropy:  lexFeatures.ngramEntropy,
		ContextRatio:  contextRatio,
	}
	
	elapsed := time.Since(startTime)
	if elapsed.Milliseconds() > int64(timeoutMs) {
		log.Printf("Feature extraction took %dms (budget: %dms)", elapsed.Milliseconds(), timeoutMs)
	}
	
	return features, nil
}

type lexicalFeatures struct {
	hasCode      bool
	hasMath      bool
	ngramEntropy float64
}

func (fe *FeatureExtractor) extractPromptText(req *RouterRequest) string {
	if req.Body == nil {
		return ""
	}
	
	var parts []string
	for _, msg := range req.Body.Messages {
		parts = append(parts, msg.Content)
	}
	return strings.Join(parts, "\n")
}

func (fe *FeatureExtractor) getEmbedding(text string) []float64 {
	// Check cache first
	if cached, ok := fe.embeddingCache.Load(text); ok {
		return cached.([]float64)
	}
	
	// Generate fallback embedding using deterministic hash
	embedding := fe.generateFallbackEmbedding(text)
	fe.embeddingCache.Store(text, embedding)
	return embedding
}

func (fe *FeatureExtractor) generateFallbackEmbedding(text string) []float64 {
	// Create deterministic embedding from text hash (similar to TS fallback)
	hash := sha256.Sum256([]byte(text))
	embedding := make([]float64, 384) // Standard sentence-transformer dimension
	
	for i := 0; i < 384; i++ {
		byteIndex := i % len(hash)
		rawValue := float64(hash[byteIndex]) / 255.0
		embedding[i] = (rawValue - 0.5) * 2 // Normalize to [-1, 1]
	}
	
	return embedding
}

type clusterMatch struct {
	id       int
	distance float64
}

func (fe *FeatureExtractor) findNearestClusters(embedding []float64, k int) []clusterMatch {
	// Simplified cluster matching - in production would use FAISS index
	// For now, return mock clusters with deterministic distances
	var clusters []clusterMatch
	
	for i := 0; i < k; i++ {
		// Generate deterministic distance based on embedding
		dist := math.Mod(float64(i)+embedding[i%len(embedding)], 1.0)
		clusters = append(clusters, clusterMatch{id: i, distance: dist})
	}
	
	// Sort by distance
	sort.Slice(clusters, func(i, j int) bool {
		return clusters[i].distance < clusters[j].distance
	})
	
	return clusters
}

func (fe *FeatureExtractor) getTopCluster(clusters []clusterMatch) int {
	if len(clusters) == 0 {
		return 0
	}
	return clusters[0].id
}

func (fe *FeatureExtractor) getTopDistances(clusters []clusterMatch) []float64 {
	var distances []float64
	for _, cluster := range clusters {
		distances = append(distances, cluster.distance)
	}
	return distances
}

func (fe *FeatureExtractor) extractLexicalFeatures(text string) lexicalFeatures {
	// Code detection patterns (port of TypeScript regexes)
	codePatterns := []*regexp.Regexp{
		regexp.MustCompile("```[\\s\\S]*?```"),          // Code blocks
		regexp.MustCompile("`[^`]+`"),                   // Inline code
		regexp.MustCompile("function\\s+\\w+\\s*\\("),     // Function definitions
		regexp.MustCompile("class\\s+\\w+"),               // Class definitions
		regexp.MustCompile("\\bimport\\s+.*?from"),        // Import statements
		regexp.MustCompile("\\bdef\\s+\\w+\\s*\\("),        // Python functions
		regexp.MustCompile("\\bconst\\s+\\w+\\s*="),        // JS const declarations
		regexp.MustCompile("\\blet\\s+\\w+\\s*="),          // JS let declarations
	}
	
	hasCode := false
	for _, pattern := range codePatterns {
		if pattern.MatchString(text) {
			hasCode = true
			break
		}
	}
	
	// Math detection patterns
	mathPatterns := []*regexp.Regexp{
		regexp.MustCompile("\\$[^$]+\\$"),                 // LaTeX math
		regexp.MustCompile("\\\\\\([^)]+\\\\\\)"),             // LaTeX inline math
		regexp.MustCompile("\\\\\\[[^\\]]+\\\\\\]"),         // LaTeX display math
		regexp.MustCompile("[∫∑∏√∞≤≥≠±×÷]"),              // Math symbols
		regexp.MustCompile("\\b\\d+\\.\\d*[eE][+-]?\\d+"), // Scientific notation
		regexp.MustCompile("(?i)matrix|vector|derivative|integral"), // Math terms
	}
	
	hasMath := false
	for _, pattern := range mathPatterns {
		if pattern.MatchString(text) {
			hasMath = true
			break
		}
	}
	
	// N-gram entropy calculation (simplified)
	ngramEntropy := fe.calculateNgramEntropy(text, 3)
	
	return lexicalFeatures{
		hasCode:      hasCode,
		hasMath:      hasMath,
		ngramEntropy: ngramEntropy,
	}
}

func (fe *FeatureExtractor) calculateNgramEntropy(text string, n int) float64 {
	ngrams := make(map[string]int)
	cleanText := strings.ToLower(regexp.MustCompile("[^a-z\\s]").ReplaceAllString(text, ""))
	
	// Generate n-grams
	total := 0
	for i := 0; i <= len(cleanText)-n; i++ {
		ngram := cleanText[i : i+n]
		ngrams[ngram]++
		total++
	}
	
	if total == 0 {
		return 0
	}
	
	// Calculate entropy
	entropy := 0.0
	for _, count := range ngrams {
		p := float64(count) / float64(total)
		entropy -= p * math.Log2(p)
	}
	
	return entropy
}

func (fe *FeatureExtractor) estimateTokens(text string) int {
	// Rough token estimation: ~4 characters per token
	return int(math.Ceil(float64(len(text)) / 4.0))
}

func (fe *FeatureExtractor) calculateContextRatio(tokenCount int) float64 {
	maxContext := 128000.0 // Default context window
	return math.Min(float64(tokenCount)/maxContext, 1.0)
}

// GBDTRuntime implements GBDT prediction (port of gbdt_runtime.ts)
type GBDTRuntime struct {
	mu sync.RWMutex
}

func NewGBDTRuntime() *GBDTRuntime {
	return &GBDTRuntime{}
}

func (gbdt *GBDTRuntime) Predict(features *RequestFeatures, artifact *AvengersArtifact) (*BucketProbabilities, error) {
	gbdt.mu.RLock()
	defer gbdt.mu.RUnlock()
	
	// Simplified GBDT prediction - in production would load actual model
	// For now, use heuristics based on features
	
	cheapProb := 0.33
	midProb := 0.33
	hardProb := 0.34
	
	// Adjust probabilities based on features
	if features.HasCode {
		// Code tasks tend to be mid-tier
		midProb += 0.2
		cheapProb -= 0.1
		hardProb -= 0.1
	}
	
	if features.HasMath {
		// Math tasks tend to be hard
		hardProb += 0.2
		cheapProb -= 0.1
		midProb -= 0.1
	}
	
	if features.TokenCount > 50000 {
		// Long context tasks tend to be hard
		hardProb += 0.15
		cheapProb -= 0.075
		midProb -= 0.075
	} else if features.TokenCount < 1000 {
		// Short tasks can be cheap
		cheapProb += 0.15
		midProb -= 0.075
		hardProb -= 0.075
	}
	
	// Normalize probabilities
	total := cheapProb + midProb + hardProb
	cheapProb /= total
	midProb /= total
	hardProb /= total
	
	return &BucketProbabilities{
		Cheap: cheapProb,
		Mid:   midProb,
		Hard:  hardProb,
	}, nil
}

// AlphaScorer implements α-score model selection with advanced features
// Includes caching, batch optimization, and historical performance tracking
type AlphaScorer struct {
	mu                sync.RWMutex
	scoreCache        sync.Map // string -> *ModelScore
	performanceHist   sync.Map // string -> *PerformanceHistory
	cacheTTL          time.Duration
	lastCacheClean    time.Time
}

// PerformanceHistory tracks model performance over time for alpha tuning
type PerformanceHistory struct {
	ModelName        string    `json:"model_name"`
	SuccessRate      float64   `json:"success_rate"`
	AvgLatency       float64   `json:"avg_latency"`
	TotalRequests    int64     `json:"total_requests"`
	LastUpdated      time.Time `json:"last_updated"`
	AlphaOptimal     float64   `json:"alpha_optimal"` // Learned optimal alpha
}

// ScoreCacheEntry represents a cached score with expiration
type ScoreCacheEntry struct {
	Score     *ModelScore
	ExpiresAt time.Time
}

func NewAlphaScorer() *AlphaScorer {
	return &AlphaScorer{
		cacheTTL:       5 * time.Minute,
		lastCacheClean: time.Now(),
	}
}

// NewAlphaScorerWithCache creates scorer with custom cache settings
func NewAlphaScorerWithCache(cacheTTL time.Duration) *AlphaScorer {
	return &AlphaScorer{
		cacheTTL:       cacheTTL,
		lastCacheClean: time.Now(),
	}
}

func (as *AlphaScorer) SelectBest(candidates []string, features *RequestFeatures, artifact *AvengersArtifact) (string, error) {
	if len(candidates) == 0 {
		return "", fmt.Errorf("no candidates provided")
	}
	
	// Clean expired cache entries periodically
	if time.Since(as.lastCacheClean) > 10*time.Minute {
		as.cleanExpiredCache()
	}
	
	scores, err := as.scoreModelsBatched(candidates, features, artifact)
	if err != nil {
		return "", err
	}
	
	if len(scores) == 0 {
		return candidates[0], nil // Fallback to first candidate
	}
	
	// Sort by α-score (descending) with tie-breaking
	sort.Slice(scores, func(i, j int) bool {
		if math.Abs(scores[i].AlphaScore-scores[j].AlphaScore) < 0.001 {
			// Tie-breaking: prefer lower cost for equal quality
			return scores[i].CostScore < scores[j].CostScore
		}
		return scores[i].AlphaScore > scores[j].AlphaScore
	})
	
	best := scores[0]
	
	// Update performance history (async)
	go as.updatePerformanceHistory(best.Model, features)
	
	log.Printf("Selected model: %s (α-score: %.3f, quality: %.3f, cost: %.3f, penalty: %.3f)", 
		best.Model, best.AlphaScore, best.QualityScore, best.CostScore, best.PenaltyScore)
	
	return best.Model, nil
}

// SelectBestWithExplanation returns the best model with detailed scoring breakdown
func (as *AlphaScorer) SelectBestWithExplanation(candidates []string, features *RequestFeatures, artifact *AvengersArtifact) (string, []ModelScore, error) {
	if len(candidates) == 0 {
		return "", nil, fmt.Errorf("no candidates provided")
	}
	
	scores, err := as.scoreModelsBatched(candidates, features, artifact)
	if err != nil {
		return "", nil, err
	}
	
	if len(scores) == 0 {
		return candidates[0], nil, nil
	}
	
	// Sort by α-score (descending)
	sort.Slice(scores, func(i, j int) bool {
		return scores[i].AlphaScore > scores[j].AlphaScore
	})
	
	return scores[0].Model, scores, nil
}

// scoreModelsBatched implements optimized batch scoring with caching
func (as *AlphaScorer) scoreModelsBatched(candidates []string, features *RequestFeatures, artifact *AvengersArtifact) ([]ModelScore, error) {
	var scores []ModelScore
	
	// Pre-allocate slice for efficiency
	scores = make([]ModelScore, 0, len(candidates))
	
	for _, model := range candidates {
		// Try cache first
		if cachedScore := as.getCachedScore(model, features, artifact); cachedScore != nil {
			scores = append(scores, *cachedScore)
			continue
		}
		
		// Calculate fresh score
		score := as.scoreModel(model, features, artifact)
		if score != nil {
			// Cache the result
			as.cacheScore(model, features, artifact, score)
			scores = append(scores, *score)
		}
	}
	
	return scores, nil
}

// scoreModels maintains backward compatibility
func (as *AlphaScorer) scoreModels(candidates []string, features *RequestFeatures, artifact *AvengersArtifact) ([]ModelScore, error) {
	return as.scoreModelsBatched(candidates, features, artifact)
}

func (as *AlphaScorer) scoreModel(model string, features *RequestFeatures, artifact *AvengersArtifact) *ModelScore {
	// Get quality score for this model and cluster
	qualityScore := as.getQualityScore(model, features.ClusterID, artifact)
	if qualityScore == nil {
		return nil
	}
	
	// Get cost score for this model
	costScore := as.getCostScore(model, artifact)
	if costScore == nil {
		return nil
	}
	
	// Calculate penalties
	penaltyScore := as.calculatePenalties(model, features, artifact)
	
	// Calculate α-score: α * Q̂[m,c] - (1-α) * Ĉ[m] - penalties
	alpha := artifact.Alpha
	alphaScore := (alpha * *qualityScore) - ((1 - alpha) * *costScore) - penaltyScore
	
	return &ModelScore{
		Model:        model,
		QualityScore: *qualityScore,
		CostScore:    *costScore,
		PenaltyScore: penaltyScore,
		AlphaScore:   alphaScore,
	}
}

func (as *AlphaScorer) getQualityScore(model string, clusterID int, artifact *AvengersArtifact) *float64 {
	modelQuality, ok := artifact.Qhat[model]
	if !ok || len(modelQuality) == 0 {
		return nil
	}
	
	// Use cluster-specific quality score, fallback to average
	if clusterID < len(modelQuality) {
		score := modelQuality[clusterID]
		return &score
	}
	
	// Fallback to average quality across all clusters
	avg := 0.0
	for _, score := range modelQuality {
		avg += score
	}
	avg /= float64(len(modelQuality))
	return &avg
}

func (as *AlphaScorer) getCostScore(model string, artifact *AvengersArtifact) *float64 {
	if cost, ok := artifact.Chat[model]; ok {
		return &cost
	}
	return nil
}

func (as *AlphaScorer) calculatePenalties(model string, features *RequestFeatures, artifact *AvengersArtifact) float64 {
	penalty := 0.0
	
	// Context over-utilization penalty
	if features.ContextRatio > 0.8 {
		penalty += artifact.Penalties.CtxOver80Pct
	}
	
	// Latency variance penalty (simplified)
	expectedLatency := as.estimateLatency(model, features)
	if features.AvgLatency != nil {
		latencyVariance := math.Abs(expectedLatency - *features.AvgLatency) / *features.AvgLatency
		if latencyVariance > 0.2 {
			penalty += artifact.Penalties.LatencySD * latencyVariance
		}
	}
	
	// Model-specific penalties
	penalty += as.getModelSpecificPenalties(model, features)
	
	return penalty
}

func (as *AlphaScorer) estimateLatency(model string, features *RequestFeatures) float64 {
	// Base latency estimates (in seconds)
	baseLatencies := map[string]float64{
		"deepseek/deepseek-r1":     3.0,
		"qwen/qwen3-coder":         2.5,
		"openai/gpt-5":             8.0,
		"google/gemini-2.5-pro":    6.0,
	}
	
	latency := baseLatencies[model]
	if latency == 0 {
		latency = 5.0 // Default
	}
	
	// Scale with token count for large contexts
	if features.TokenCount > 5000 {
		tokenMultiplier := math.Min(float64(features.TokenCount)/10000, 3.0)
		latency *= (1 + tokenMultiplier*0.5)
	}
	
	// Reasoning models take longer for complex tasks
	if (strings.Contains(model, "gpt-5") || strings.Contains(model, "gemini")) &&
		(features.HasCode || features.HasMath) {
		latency *= 1.5
	}
	
	return latency
}

func (as *AlphaScorer) getModelSpecificPenalties(model string, features *RequestFeatures) float64 {
	penalty := 0.0
	
	// DeepSeek is good for code, give bonus
	if features.HasCode && strings.Contains(model, "deepseek") {
		penalty -= 0.05
	}
	
	// Math tasks benefit from reasoning models
	if features.HasMath && !strings.Contains(model, "gpt-5") && !strings.Contains(model, "gemini") {
		penalty += 0.1
	}
	
	// Very long context penalty for models without good long-context support
	if features.TokenCount > 100000 && !strings.Contains(model, "gemini") {
		penalty += 0.15
	}
	
	return penalty
}

// Utility functions
func getHeaderValue(headers map[string][]string, key string) string {
	if values, ok := headers[key]; ok && len(values) > 0 {
		return values[0]
	}
	// Try lowercase key
	if values, ok := headers[strings.ToLower(key)]; ok && len(values) > 0 {
		return values[0]
	}
	return ""
}

// Plugin implements the schemas.Plugin interface for native Heimdall routing
type Plugin struct {
	name   string
	config Config
	
	// Core routing components (native Go implementations)
	authRegistry     *AuthAdapterRegistry
	featureExtractor *FeatureExtractor
	gbdtRuntime      *GBDTRuntime
	alphaScorer      *AlphaScorer
	
	// Current routing artifact
	currentArtifact *AvengersArtifact
	lastArtifactLoad time.Time
	artifactMu      sync.RWMutex
	
	// Cache for routing decisions
	cache   map[string]CacheEntry
	cacheMu sync.RWMutex
	
	// HTTP client for artifact fetching
	httpClient *http.Client
	
	// Metrics and monitoring
	requestCount   int64
	errorCount     int64
	cacheHitCount  int64
	metricsMu      sync.RWMutex
}

// New creates a new native Heimdall plugin instance
func New(cfg interface{}) (*Plugin, error) {
	// Parse configuration
	configData, err := json.Marshal(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal config: %w", err)
	}
	
	var config Config
	if err := json.Unmarshal(configData, &config); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config: %w", err)
	}
	
	// Set defaults
	if config.Timeout == 0 {
		config.Timeout = 25 * time.Millisecond // Fast PreHook requirement
	}
	if config.CacheTTL == 0 {
		config.CacheTTL = 5 * time.Minute
	}
	if config.MaxCacheSize == 0 {
		config.MaxCacheSize = 10000
	}
	if config.EmbeddingTimeout == 0 {
		config.EmbeddingTimeout = 15 * time.Second
	}
	if config.FeatureTimeout == 0 {
		config.FeatureTimeout = 25 * time.Millisecond
	}
	
	// Validate configuration
	if config.Tuning.ArtifactURL == "" {
		return nil, fmt.Errorf("tuning.artifact_url is required")
	}
	
	// Initialize core components
	authRegistry := NewAuthAdapterRegistry()
	featureExtractor := NewFeatureExtractor()
	gbdtRuntime := NewGBDTRuntime()
	alphaScorer := NewAlphaScorer()
	
	// Setup auth adapters based on configuration
	if contains(config.AuthAdapters.Enabled, "openai-key") {
		authRegistry.Register(&OpenAIKeyAdapter{})
	}
	if contains(config.AuthAdapters.Enabled, "anthropic-oauth") {
		authRegistry.Register(&AnthropicOAuthAdapter{})
	}
	if contains(config.AuthAdapters.Enabled, "google-oauth") {
		authRegistry.Register(&GeminiOAuthAdapter{})
	}
	
	plugin := &Plugin{
		name:             "heimdall",
		config:           config,
		authRegistry:     authRegistry,
		featureExtractor: featureExtractor,
		gbdtRuntime:      gbdtRuntime,
		alphaScorer:      alphaScorer,
		httpClient: &http.Client{
			Timeout: config.Timeout,
		},
		cache: make(map[string]CacheEntry),
	}
	
	log.Printf("Initialized native Heimdall plugin with %d auth adapters", len(config.AuthAdapters.Enabled))
	return plugin, nil
}

// GetName returns the plugin name
func (p *Plugin) GetName() string {
	return p.name
}

// PreHook implements the PreHook interface for native request processing
func (p *Plugin) PreHook(ctx *context.Context, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.PluginShortCircuit, error) {
	startTime := time.Now()
	
	// Increment request counter
	p.metricsMu.Lock()
	p.requestCount++
	p.metricsMu.Unlock()
	
	// Convert BifrostRequest to internal RouterRequest
	routerReq, headers, err := p.convertToRouterRequest(ctx, req)
	if err != nil {
		return p.handleError(ctx, req, fmt.Errorf("failed to convert request: %w", err))
	}
	
	// Check cache if enabled (using deterministic key)
	if p.config.EnableCaching {
		if cached := p.getCachedResponse(routerReq); cached != nil {
			p.metricsMu.Lock()
			p.cacheHitCount++
			p.metricsMu.Unlock()
			
			return p.applyCachedDecision(ctx, req, cached)
		}
	}
	
	// Make native routing decision (port of RouterPreHook.decide())
	response, err := p.decide(routerReq, headers)
	if err != nil {
		return p.handleError(ctx, req, fmt.Errorf("routing decision failed: %w", err))
	}
	
	// Cache the response if enabled
	if p.config.EnableCaching {
		p.cacheResponse(routerReq, response)
	}
	
	// Apply routing decision to the request
	result, shortCircuit, err := p.applyRoutingDecision(ctx, req, response)
	
	elapsed := time.Since(startTime)
	if elapsed.Microseconds() > 10000 { // 10ms warning threshold
		log.Printf("PreHook took %dus (>10ms threshold)", elapsed.Microseconds())
	}
	
	return result, shortCircuit, err
}

// PostHook implements 429 fallback and observability
func (p *Plugin) PostHook(ctx *context.Context, res *schemas.BifrostResponse, err *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	// Handle 429 rate limiting with native fallback routing
	if err != nil && err.StatusCode != nil && *err.StatusCode == 429 && p.config.EnableFallbacks {
		// Check if this was an Anthropic 429
		if provider, ok := (*ctx).Value("heimdall_decision").(RouterDecision); ok {
			if provider.Kind == "anthropic" {
				log.Printf("Received 429 from Anthropic, fallback logic could be implemented here")
				// In a full implementation, we could trigger a re-routing with excludeAnthropic=true
			}
		}
	}
	
	// Add observability metrics if enabled
	if p.config.EnableObservability && res != nil {
		// Note: ExtraFields is a struct, not a map. In a full implementation,
		// we would need to extend the BifrostResponseExtraFields struct or use
		// the RawResponse field to store additional metrics.
		// For now, we'll use the existing fields where possible.
		
		if bucket, ok := (*ctx).Value("heimdall_bucket").(Bucket); ok {
			log.Printf("Request routed to bucket: %s", string(bucket))
		}
		if features, ok := (*ctx).Value("heimdall_features").(RequestFeatures); ok {
			log.Printf("Request features - tokens: %d, has_code: %v, has_math: %v", 
				features.TokenCount, features.HasCode, features.HasMath)
		}
		if fallbackReason, ok := (*ctx).Value("heimdall_fallback_reason").(string); ok {
			log.Printf("Fallback reason: %s", fallbackReason)
		}
		if cacheHit, ok := (*ctx).Value("heimdall_cache_hit").(bool); ok && cacheHit {
			log.Printf("Cache hit for request")
		}
	}
	
	return res, err, nil
}

// Utility functions for plugin operation
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// ============================================================================
// MAIN FUNCTION - Plugin Registration
// ============================================================================

func main() {
	// This main function is for testing/standalone usage
	// In production, the plugin would be imported and used via New()
	log.Println("Native Heimdall Bifrost Plugin")
	log.Println("Use via New() function for plugin registration")
	
	// Example usage:
	config := Config{
		Tuning: TuningConfig{
			ArtifactURL:   "https://example.com/artifact.json",
			ReloadSeconds: 300,
		},
		AuthAdapters: AuthAdaptersConfig{
			Enabled: []string{"openai-key", "anthropic-oauth"},
		},
		Router: RouterConfig{
			Alpha: 0.7,
			Thresholds: BucketThresholds{
				Cheap: 0.3,
				Hard:  0.7,
			},
			CheapCandidates: []string{"qwen/qwen3-coder", "deepseek/deepseek-r1"},
			MidCandidates:   []string{"openai/gpt-4o", "anthropic/claude-3.5-sonnet"},
			HardCandidates:  []string{"openai/gpt-5", "google/gemini-2.5-pro"},
		},
		EnableCaching:   true,
		EnableAuth:      true,
		EnableFallbacks: true,
	}
	
	plugin, err := New(config)
	if err != nil {
		log.Fatalf("Failed to create plugin: %v", err)
	}
	
	log.Printf("Created native Heimdall plugin: %s", plugin.GetName())
	log.Printf("Plugin metrics: %+v", plugin.GetMetrics())
	
	// Cleanup
	if err := plugin.Cleanup(); err != nil {
		log.Printf("Cleanup error: %v", err)
	}
}

// decide implements the core routing decision logic (port of RouterPreHook.decide())
func (p *Plugin) decide(req *RouterRequest, headers map[string][]string) (*RouterResponse, error) {
	// Step 1: Ensure we have current artifacts
	if err := p.ensureCurrentArtifact(); err != nil {
		return nil, fmt.Errorf("failed to ensure artifact: %w", err)
	}
	
	if p.currentArtifact == nil {
		return nil, fmt.Errorf("no routing artifact available")
	}
	
	// Step 2: Auth detection
	authAdapter := p.authRegistry.FindMatch(headers)
	var authInfo *AuthInfo
	if authAdapter != nil {
		authInfo = authAdapter.Extract(headers)
	}
	
	// Step 3: Feature extraction (≤25ms budget)
	features, err := p.featureExtractor.Extract(req, p.currentArtifact, int(p.config.FeatureTimeout.Milliseconds()))
	if err != nil {
		return nil, fmt.Errorf("feature extraction failed: %w", err)
	}
	
	// Step 4: GBDT triage
	bucketProbs, err := p.gbdtRuntime.Predict(features, p.currentArtifact)
	if err != nil {
		return nil, fmt.Errorf("GBDT prediction failed: %w", err)
	}
	
	// Step 5: Bucket selection with guardrails
	bucket := p.selectBucket(bucketProbs, features)
	
	// Step 6: In-bucket α-score selection
	decision, err := p.selectModel(bucket, features, authInfo, false)
	if err != nil {
		return nil, fmt.Errorf("model selection failed: %w", err)
	}
	
	return &RouterResponse{
		Decision:            *decision,
		Features:            *features,
		Bucket:              bucket,
		BucketProbabilities: *bucketProbs,
		AuthInfo:            authInfo,
	}, nil
}

// ensureCurrentArtifact ensures we have a current routing artifact
func (p *Plugin) ensureCurrentArtifact() error {
	p.artifactMu.Lock()
	defer p.artifactMu.Unlock()
	
	now := time.Now()
	reloadInterval := p.config.Tuning.ReloadSeconds * time.Second
	
	if p.currentArtifact == nil || now.Sub(p.lastArtifactLoad) > reloadInterval {
		log.Printf("Loading/refreshing routing artifact from %s", p.config.Tuning.ArtifactURL)
		
		// Fetch artifact from URL
		resp, err := p.httpClient.Get(p.config.Tuning.ArtifactURL)
		if err != nil {
			if p.currentArtifact != nil {
				// Keep existing artifact on fetch failure
				log.Printf("Failed to fetch artifact, keeping existing: %v", err)
				return nil
			}
			return fmt.Errorf("failed to fetch artifact: %w", err)
		}
		defer resp.Body.Close()
		
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("artifact fetch failed with status %d", resp.StatusCode)
		}
		
		var artifact AvengersArtifact
		if err := json.NewDecoder(resp.Body).Decode(&artifact); err != nil {
			return fmt.Errorf("failed to decode artifact: %w", err)
		}
		
		p.currentArtifact = &artifact
		p.lastArtifactLoad = now
		log.Printf("Loaded artifact version: %s", artifact.Version)
	}
	
	return nil
}

// selectBucket implements bucket selection with guardrails (port of RouterPreHook.selectBucket())
func (p *Plugin) selectBucket(probs *BucketProbabilities, features *RequestFeatures) Bucket {
	thresholds := p.config.Router.Thresholds
	
	// Guardrails for context overflow
	if p.contextExceedsCapacity(features, BucketCheap) {
		if p.contextExceedsCapacity(features, BucketMid) {
			return BucketHard
		}
		return BucketMid
	}
	
	// Threshold-based bucket selection
	if probs.Hard > thresholds.Hard {
		return BucketHard
	}
	
	if probs.Cheap > thresholds.Cheap {
		return BucketCheap
	}
	
	return BucketMid
}

// contextExceedsCapacity checks if context exceeds bucket capacity
func (p *Plugin) contextExceedsCapacity(features *RequestFeatures, bucket Bucket) bool {
	// Rough context capacity estimates
	capacities := map[Bucket]int{
		BucketCheap: 16000,   // DeepSeek R1, Qwen3-Coder
		BucketMid:   128000,  // GPT-5 medium, Gemini medium
		BucketHard:  1048576, // Gemini 2.5 Pro with high thinking
	}
	
	capacity, ok := capacities[bucket]
	if !ok {
		return false
	}
	
	return features.TokenCount > int(float64(capacity)*0.8) // 80% threshold
}

// selectModel implements in-bucket model selection (port of RouterPreHook.selectModel())
func (p *Plugin) selectModel(bucket Bucket, features *RequestFeatures, authInfo *AuthInfo, excludeAnthropic bool) (*RouterDecision, error) {
	if p.currentArtifact == nil {
		return nil, fmt.Errorf("no artifact available for model selection")
	}
	
	switch bucket {
	case BucketCheap:
		return p.selectModelForBucket("cheap", features)
		
	case BucketMid:
		if !excludeAnthropic && authInfo != nil && authInfo.Provider == "anthropic" {
			return p.selectAnthropicModel(), nil
		}
		return p.selectModelForBucket("mid", features)
		
	case BucketHard:
		return p.selectModelForBucket("hard", features)
		
	default:
		return nil, fmt.Errorf("unknown bucket: %s", bucket)
	}
}

// selectAnthropicModel returns a default Anthropic model decision
func (p *Plugin) selectAnthropicModel() *RouterDecision {
	return &RouterDecision{
		Kind:  "anthropic",
		Model: "claude-3-5-sonnet-20241022",
		Params: map[string]interface{}{},
		ProviderPrefs: ProviderPrefs{
			Sort:           "latency",
			MaxPrice:       100,
			AllowFallbacks: false,
		},
		Auth: AuthConfig{
			Mode: "oauth",
		},
		Fallbacks: []string{},
	}
}

// selectModelForBucket implements consolidated model selection (port of RouterPreHook.selectModelForBucket())
func (p *Plugin) selectModelForBucket(bucketType string, features *RequestFeatures) (*RouterDecision, error) {
	var candidates []string
	
	switch bucketType {
	case "cheap":
		candidates = p.config.Router.CheapCandidates
	case "mid":
		candidates = p.config.Router.MidCandidates
	case "hard":
		candidates = p.config.Router.HardCandidates
	default:
		return nil, fmt.Errorf("unknown bucket type: %s", bucketType)
	}
	
	if len(candidates) == 0 {
		return nil, fmt.Errorf("no candidates for bucket %s", bucketType)
	}
	
	// Special logic for hard models with long context
	finalCandidates := candidates
	if bucketType == "hard" && features.TokenCount > 200000 {
		// For very long context, bias towards Gemini
		var geminiModels, otherModels []string
		for _, c := range candidates {
			if strings.Contains(c, "gemini") {
				geminiModels = append(geminiModels, c)
			} else {
				otherModels = append(otherModels, c)
			}
		}
		finalCandidates = append(geminiModels, otherModels...) // Gemini first
	}
	
	// Use α-score to pick best model
	bestModel, err := p.alphaScorer.SelectBest(finalCandidates, features, p.currentArtifact)
	if err != nil {
		return nil, fmt.Errorf("α-score selection failed: %w", err)
	}
	
	// Build model-specific parameters
	params := make(map[string]interface{})
	if bucketType != "cheap" {
		// Add bucket-specific parameters
		if bucketType == "mid" || bucketType == "hard" {
			bucketParams := p.config.Router.BucketDefaults.Mid
			if bucketType == "hard" {
				bucketParams = p.config.Router.BucketDefaults.Hard
			}
			
			if strings.Contains(bestModel, "gpt") {
				params["reasoning_effort"] = bucketParams.GPT5ReasoningEffort
			} else if strings.Contains(bestModel, "gemini") {
				params["thinkingBudget"] = bucketParams.GeminiThinkingBudget
			}
		}
	}
	
	// Infer provider kind from model name
	providerKind := p.inferProviderKind(bestModel)
	
	// Get provider preferences
	providerPrefs := p.getProviderPreferencesForBucket(bucketType)
	
	// Build fallbacks list (exclude the selected model)
	var fallbacks []string
	for _, c := range finalCandidates {
		if c != bestModel {
			fallbacks = append(fallbacks, c)
		}
	}
	
	return &RouterDecision{
		Kind:          providerKind,
		Model:         bestModel,
		Params:        params,
		ProviderPrefs: providerPrefs,
		Auth: AuthConfig{
			Mode: "env",
		},
		Fallbacks: fallbacks,
	}, nil
}

// inferProviderKind infers provider from model name
func (p *Plugin) inferProviderKind(model string) string {
	if strings.Contains(model, "openai") || strings.Contains(model, "gpt") {
		return "openai"
	}
	if strings.Contains(model, "anthropic") || strings.Contains(model, "claude") {
		return "anthropic"
	}
	if strings.Contains(model, "google") || strings.Contains(model, "gemini") {
		return "google"
	}
	return "openrouter" // Default for other models
}

// getProviderPreferencesForBucket returns provider preferences for bucket
func (p *Plugin) getProviderPreferencesForBucket(bucketType string) ProviderPrefs {
	switch bucketType {
	case "cheap":
		return p.config.Router.OpenRouter.Provider
	case "mid":
		return ProviderPrefs{
			Sort:           "quality",
			MaxPrice:       50,
			AllowFallbacks: true,
		}
	case "hard":
		return ProviderPrefs{
			Sort:           "quality",
			MaxPrice:       100,
			AllowFallbacks: true,
		}
	default:
		return ProviderPrefs{
			Sort:           "quality",
			MaxPrice:       50,
			AllowFallbacks: true,
		}
	}
}

// convertToRouterRequest converts BifrostRequest to internal RouterRequest
func (p *Plugin) convertToRouterRequest(ctx *context.Context, req *schemas.BifrostRequest) (*RouterRequest, map[string][]string, error) {
	headers := make(map[string][]string)
	
	// Extract headers from context if available (HTTP headers)
	if httpHeaders, ok := (*ctx).Value("http_headers").(map[string][]string); ok {
		headers = httpHeaders
	}
	
	// Convert ChatCompletionInput to messages
	var messages []ChatMessage
	if req.Input.ChatCompletionInput != nil {
		for _, msg := range *req.Input.ChatCompletionInput {
			content := ""
			if msg.Content.ContentStr != nil {
				content = *msg.Content.ContentStr
			}
			messages = append(messages, ChatMessage{
				Role:    string(msg.Role),
				Content: content,
			})
		}
	}
	
	body := &RequestBody{
		Messages: messages,
		Model:    req.Model,
	}
	
	routerReq := &RouterRequest{
		URL:     "/v1/chat/completions",
		Method:  "POST",
		Headers: headers,
		Body:    body,
	}
	
	return routerReq, headers, nil
}

// applyRoutingDecision applies the routing decision to the BifrostRequest
func (p *Plugin) applyRoutingDecision(ctx *context.Context, req *schemas.BifrostRequest, response *RouterResponse) (*schemas.BifrostRequest, *schemas.PluginShortCircuit, error) {
	// Update request with routing decision
	req.Provider = schemas.ModelProvider(response.Decision.Kind)
	req.Model = response.Decision.Model
	
	// Set fallbacks - convert string slice to Fallback slice
	var fallbacks []schemas.Fallback
	for _, fallback := range response.Decision.Fallbacks {
		// Extract provider from model name (simplified)
		provider := p.inferProviderKind(fallback)
		fallbacks = append(fallbacks, schemas.Fallback{
			Provider: schemas.ModelProvider(provider),
			Model:    fallback,
		})
	}
	req.Fallbacks = fallbacks
	
	// Enrich context with routing information
	*ctx = context.WithValue(*ctx, "heimdall_bucket", response.Bucket)
	*ctx = context.WithValue(*ctx, "heimdall_features", response.Features)
	*ctx = context.WithValue(*ctx, "heimdall_decision", response.Decision)
	*ctx = context.WithValue(*ctx, "heimdall_alpha_scores", "enabled") // Flag for observability
	
	if response.AuthInfo != nil {
		*ctx = context.WithValue(*ctx, "heimdall_auth_info", response.AuthInfo)
	}
	
	if response.FallbackReason != "" {
		*ctx = context.WithValue(*ctx, "heimdall_fallback_reason", response.FallbackReason)
	}
	
	return req, nil, nil
}

// handleError provides fallback behavior on errors
func (p *Plugin) handleError(ctx *context.Context, req *schemas.BifrostRequest, err error) (*schemas.BifrostRequest, *schemas.PluginShortCircuit, error) {
	p.metricsMu.Lock()
	p.errorCount++
	p.metricsMu.Unlock()
	
	log.Printf("Heimdall plugin error: %v", err)
	
	// Create fallback decision
	fallbackResponse := p.getFallbackDecision(req, err)
	
	// Apply fallback decision
	req.Provider = schemas.ModelProvider(fallbackResponse.Decision.Kind)
	req.Model = fallbackResponse.Decision.Model
	
	// Convert fallbacks
	var fallbacks []schemas.Fallback
	for _, fallback := range fallbackResponse.Decision.Fallbacks {
		provider := p.inferProviderKind(fallback)
		fallbacks = append(fallbacks, schemas.Fallback{
			Provider: schemas.ModelProvider(provider),
			Model:    fallback,
		})
	}
	req.Fallbacks = fallbacks
	
	// Set fallback context
	*ctx = context.WithValue(*ctx, "heimdall_fallback_reason", fallbackResponse.FallbackReason)
	*ctx = context.WithValue(*ctx, "heimdall_error", err.Error())
	*ctx = context.WithValue(*ctx, "heimdall_bucket", fallbackResponse.Bucket)
	
	return req, nil, nil
}

// Cleanup releases resources and performs cleanup
func (p *Plugin) Cleanup() error {
	// Clear cache
	p.cacheMu.Lock()
	p.cache = make(map[string]CacheEntry)
	p.cacheMu.Unlock()
	
	// Close HTTP client
	if p.httpClient != nil {
		p.httpClient.CloseIdleConnections()
	}
	
	// Clear artifact
	p.artifactMu.Lock()
	p.currentArtifact = nil
	p.artifactMu.Unlock()
	
	log.Printf("Native Heimdall plugin cleanup completed")
	return nil
}

// GetMetrics returns plugin metrics for monitoring
func (p *Plugin) GetMetrics() map[string]interface{} {
	p.metricsMu.RLock()
	defer p.metricsMu.RUnlock()
	
	metrics := map[string]interface{}{
		"request_count":    p.requestCount,
		"error_count":      p.errorCount,
		"cache_hit_count":  p.cacheHitCount,
		"cache_entries":    len(p.cache),
	}
	
	// Add artifact info if available
	p.artifactMu.RLock()
	if p.currentArtifact != nil {
		metrics["artifact_version"] = p.currentArtifact.Version
		metrics["artifact_age_seconds"] = time.Since(p.lastArtifactLoad).Seconds()
	}
	p.artifactMu.RUnlock()
	
	return metrics
}

// getFallbackDecision creates a safe fallback decision on errors
func (p *Plugin) getFallbackDecision(req *schemas.BifrostRequest, err error) *RouterResponse {
	log.Printf("Creating fallback decision due to error: %v", err)
	
	// Emergency fallback to cheapest reliable option
	decision := RouterDecision{
		Kind:  "openrouter",
		Model: "qwen/qwen3-coder", // Reliable cheap option
		Params: map[string]interface{}{},
		ProviderPrefs: ProviderPrefs{
			Sort:           "quality",
			MaxPrice:       30,
			AllowFallbacks: true,
		},
		Auth: AuthConfig{
			Mode: "env",
		},
		Fallbacks: []string{"deepseek/deepseek-r1"},
	}
	
	// Basic features for fallback
	tokenCount := p.estimateTokens(req)
	features := RequestFeatures{
		Embedding:     make([]float64, 384), // Empty embedding
		ClusterID:     0,
		TopPDistances: []float64{1.0},
		TokenCount:    tokenCount,
		HasCode:       false,
		HasMath:       false,
		NgramEntropy:  0,
		ContextRatio:  math.Min(float64(tokenCount)/128000, 1.0),
	}
	
	return &RouterResponse{
		Decision: decision,
		Features: features,
		Bucket:   BucketCheap,
		BucketProbabilities: BucketProbabilities{
			Cheap: 1.0,
			Mid:   0.0,
			Hard:  0.0,
		},
		AuthInfo:       nil,
		FallbackReason: "error_fallback",
	}
}

// estimateTokens provides a rough token count estimate for fallback
func (p *Plugin) estimateTokens(req *schemas.BifrostRequest) int {
	if req.Input.ChatCompletionInput == nil {
		return 100 // Default minimum
	}
	
	totalChars := 0
	for _, msg := range *req.Input.ChatCompletionInput {
		if msg.Content.ContentStr != nil {
			totalChars += len(*msg.Content.ContentStr)
		}
	}
	
	// Rough estimation: ~4 chars per token
	return int(math.Ceil(float64(totalChars) / 4.0))
}

// getCachedResponse retrieves a cached routing decision
func (p *Plugin) getCachedResponse(req *RouterRequest) *RouterResponse {
	key := p.getCacheKey(req)
	
	p.cacheMu.RLock()
	defer p.cacheMu.RUnlock()
	
	entry, exists := p.cache[key]
	if !exists || time.Now().After(entry.ExpiresAt) {
		return nil
	}
	
	return &entry.Response
}

// cacheResponse stores a routing decision in cache
func (p *Plugin) cacheResponse(req *RouterRequest, response *RouterResponse) {
	key := p.getCacheKey(req)
	
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	
	p.cache[key] = CacheEntry{
		Response:  *response,
		ExpiresAt: time.Now().Add(p.config.CacheTTL),
	}
}

// getCacheKey generates a cache key for the request
func (p *Plugin) getCacheKey(req *RouterRequest) string {
	// Generate a cache key based on request content
	// This is a simplified implementation - in production you'd want a more sophisticated key
	data, _ := json.Marshal(req.Body)
	return fmt.Sprintf("%s:%s", req.Method, string(data))
}

// applyCachedDecision applies a cached routing decision
func (p *Plugin) applyCachedDecision(ctx *context.Context, req *schemas.BifrostRequest, response *RouterResponse) (*schemas.BifrostRequest, *schemas.PluginShortCircuit, error) {
	*ctx = context.WithValue(*ctx, "heimdall_cache_hit", true)
	return p.applyRoutingDecision(ctx, req, response)
}

// ============================================================================
// ADVANCED ALPHA SCORING METHODS - Phase 3 Implementation
// Caching, performance tracking, A/B testing, and optimization features
// ============================================================================

// getCachedScore retrieves a cached alpha score if available and not expired
func (as *AlphaScorer) getCachedScore(model string, features *RequestFeatures, artifact *AvengersArtifact) *ModelScore {
	cacheKey := as.generateCacheKey(model, features, artifact)
	
	if cached, ok := as.scoreCache.Load(cacheKey); ok {
		entry := cached.(*ScoreCacheEntry)
		if time.Now().Before(entry.ExpiresAt) {
			return entry.Score
		}
		// Expired - remove from cache
		as.scoreCache.Delete(cacheKey)
	}
	
	return nil
}

// cacheScore stores a calculated score in the cache with expiration
func (as *AlphaScorer) cacheScore(model string, features *RequestFeatures, artifact *AvengersArtifact, score *ModelScore) {
	cacheKey := as.generateCacheKey(model, features, artifact)
	
	entry := &ScoreCacheEntry{
		Score:     score,
		ExpiresAt: time.Now().Add(as.cacheTTL),
	}
	
	as.scoreCache.Store(cacheKey, entry)
}

// generateCacheKey creates a deterministic cache key from inputs
func (as *AlphaScorer) generateCacheKey(model string, features *RequestFeatures, artifact *AvengersArtifact) string {
	// Create deterministic key based on relevant inputs
	keyData := fmt.Sprintf("%s:%d:%d:%.2f:%.2f:%t:%t", 
		model, 
		features.ClusterID,
		features.TokenCount,
		artifact.Alpha,
		features.ContextRatio,
		features.HasCode,
		features.HasMath,
	)
	
	// Hash to fixed-length key
	hash := sha256.Sum256([]byte(keyData))
	return fmt.Sprintf("score:%x", hash[:8]) // Use first 8 bytes for efficiency
}

// cleanExpiredCache removes expired entries from the score cache
func (as *AlphaScorer) cleanExpiredCache() {
	as.mu.Lock()
	defer as.mu.Unlock()
	
	now := time.Now()
	as.lastCacheClean = now
	
	// Iterate through cache and remove expired entries
	as.scoreCache.Range(func(key, value interface{}) bool {
		entry := value.(*ScoreCacheEntry)
		if now.After(entry.ExpiresAt) {
			as.scoreCache.Delete(key)
		}
		return true
	})
}

// updatePerformanceHistory tracks model performance for alpha optimization
func (as *AlphaScorer) updatePerformanceHistory(model string, features *RequestFeatures) {
	histKey := fmt.Sprintf("perf:%s", model)
	
	now := time.Now()
	
	if existing, ok := as.performanceHist.Load(histKey); ok {
		// Update existing history
		hist := existing.(*PerformanceHistory)
		as.mu.Lock()
		hist.TotalRequests++
		hist.LastUpdated = now
		// Update average latency if available
		if features.AvgLatency != nil {
			hist.AvgLatency = (hist.AvgLatency + *features.AvgLatency) / 2.0
		}
		as.mu.Unlock()
	} else {
		// Create new history entry
		hist := &PerformanceHistory{
			ModelName:     model,
			SuccessRate:   1.0, // Assume success initially
			AvgLatency:    5.0, // Default latency
			TotalRequests: 1,
			LastUpdated:   now,
			AlphaOptimal:  0.7, // Default alpha
		}
		
		if features.AvgLatency != nil {
			hist.AvgLatency = *features.AvgLatency
		}
		
		as.performanceHist.Store(histKey, hist)
	}
}

// GetPerformanceMetrics returns performance history for observability
func (as *AlphaScorer) GetPerformanceMetrics() map[string]*PerformanceHistory {
	metrics := make(map[string]*PerformanceHistory)
	
	as.performanceHist.Range(func(key, value interface{}) bool {
		keyStr := key.(string)
		hist := value.(*PerformanceHistory)
		metrics[keyStr] = hist
		return true
	})
	
	return metrics
}

// TuneAlphaParameter implements adaptive alpha tuning based on historical performance
func (as *AlphaScorer) TuneAlphaParameter(currentAlpha float64, successRate float64, avgLatency float64) float64 {
	// Simple adaptive tuning algorithm
	// If success rate is low, favor quality (increase alpha)
	// If latency is high, favor speed/cost (decrease alpha)
	
	newAlpha := currentAlpha
	
	if successRate < 0.8 {
		// Low success rate - increase quality weight
		newAlpha = math.Min(currentAlpha+0.05, 0.95)
	} else if successRate > 0.95 && avgLatency > 10.0 {
		// High success but slow - can reduce quality weight for speed
		newAlpha = math.Max(currentAlpha-0.05, 0.1)
	}
	
	return newAlpha
}

// ScoreModelsWithAlphaTuning implements A/B testing for alpha parameter optimization
func (as *AlphaScorer) ScoreModelsWithAlphaTuning(candidates []string, features *RequestFeatures, artifact *AvengersArtifact, explorationRate float64) ([]ModelScore, float64, error) {
	// A/B test: Use different alpha values for exploration
	originalAlpha := artifact.Alpha
	testAlpha := originalAlpha
	
	// With probability explorationRate, try a different alpha
	if math.Mod(float64(time.Now().UnixNano()), 1.0) < explorationRate {
		// Explore different alpha values
		alphaVariants := []float64{0.3, 0.5, 0.7, 0.9}
		variantIndex := int(time.Now().UnixNano()) % len(alphaVariants)
		testAlpha = alphaVariants[variantIndex]
		
		// Temporarily modify artifact
		testArtifact := *artifact
		testArtifact.Alpha = testAlpha
		artifact = &testArtifact
	}
	
	scores, err := as.scoreModelsBatched(candidates, features, artifact)
	if err != nil {
		return nil, originalAlpha, err
	}
	
	return scores, testAlpha, nil
}

// GetCacheMetrics returns cache performance metrics
func (as *AlphaScorer) GetCacheMetrics() map[string]interface{} {
	cacheSize := 0
	expiredCount := 0
	now := time.Now()
	
	as.scoreCache.Range(func(key, value interface{}) bool {
		cacheSize++
		entry := value.(*ScoreCacheEntry)
		if now.After(entry.ExpiresAt) {
			expiredCount++
		}
		return true
	})
	
	return map[string]interface{}{
		"cache_size":      cacheSize,
		"expired_entries": expiredCount,
		"cache_ttl_minutes": int(as.cacheTTL.Minutes()),
		"last_cleanup":    as.lastCacheClean.Format(time.RFC3339),
	}
}

// InvalidateCache clears all cached scores (useful for testing or after artifact updates)
func (as *AlphaScorer) InvalidateCache() {
	as.scoreCache.Range(func(key, value interface{}) bool {
		as.scoreCache.Delete(key)
		return true
	})
}

// ScoreModelsConcurrent implements concurrent scoring for improved performance
func (as *AlphaScorer) ScoreModelsConcurrent(candidates []string, features *RequestFeatures, artifact *AvengersArtifact, maxWorkers int) ([]ModelScore, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	
	// Limit workers to avoid over-subscription
	workers := maxWorkers
	if workers <= 0 || workers > len(candidates) {
		workers = len(candidates)
	}
	
	type scoreJob struct {
		model string
		index int
	}
	
	type scoreResult struct {
		score *ModelScore
		index int
	}
	
	jobs := make(chan scoreJob, len(candidates))
	results := make(chan scoreResult, len(candidates))
	
	// Start workers
	for i := 0; i < workers; i++ {
		go func() {
			for job := range jobs {
				score := as.scoreModel(job.model, features, artifact)
				results <- scoreResult{score: score, index: job.index}
			}
		}()
	}
	
	// Send jobs
	for i, model := range candidates {
		jobs <- scoreJob{model: model, index: i}
	}
	close(jobs)
	
	// Collect results
	scores := make([]*ModelScore, len(candidates))
	for i := 0; i < len(candidates); i++ {
		result := <-results
		scores[result.index] = result.score
	}
	
	// Filter out nil scores and convert to slice
	var validScores []ModelScore
	for _, score := range scores {
		if score != nil {
			validScores = append(validScores, *score)
		}
	}
	
	return validScores, nil
}

// EstimateOptimalAlpha suggests an optimal alpha value based on task characteristics
func (as *AlphaScorer) EstimateOptimalAlpha(features *RequestFeatures) float64 {
	baseAlpha := 0.7 // Default
	
	// Adjust based on task characteristics
	if features.HasCode {
		// Code tasks benefit from specialized models (favor quality)
		baseAlpha += 0.1
	}
	
	if features.HasMath {
		// Math tasks need reasoning capabilities (strongly favor quality)
		baseAlpha += 0.15
	}
	
	if features.TokenCount > 50000 {
		// Long context tasks need capable models (favor quality)
		baseAlpha += 0.05
	} else if features.TokenCount < 1000 {
		// Short tasks can use cheaper models (favor cost)
		baseAlpha -= 0.1
	}
	
	if features.ContextRatio > 0.8 {
		// High context utilization needs capable models
		baseAlpha += 0.05
	}
	
	// Clamp to reasonable range
	return math.Max(0.1, math.Min(0.95, baseAlpha))
}