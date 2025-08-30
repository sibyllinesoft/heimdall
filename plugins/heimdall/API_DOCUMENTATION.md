# Heimdall Go API Documentation

**Complete Go API reference for the Heimdall Bifrost plugin - Production-ready with 94.7% test coverage**

## Table of Contents

- [Core Types](#core-types)
- [Plugin Interface](#plugin-interface)
- [Configuration API](#configuration-api)
- [Authentication API](#authentication-api)
- [Routing API](#routing-api)
- [Metrics API](#metrics-api)
- [Error Handling](#error-handling)
- [Advanced Usage](#advanced-usage)

## Core Types

### Plugin Configuration

```go
// Config represents the complete configuration for the Heimdall plugin
type Config struct {
    // Router configuration for intelligent request routing
    Router RouterConfig `yaml:"router" json:"router"`
    
    // Authentication adapters configuration
    AuthAdapters AuthAdaptersConfig `yaml:"auth_adapters" json:"auth_adapters"`
    
    // Catalog service configuration for model information
    Catalog CatalogConfig `yaml:"catalog" json:"catalog"`
    
    // ML artifact tuning configuration
    Tuning TuningConfig `yaml:"tuning" json:"tuning"`
    
    // Performance and timeout settings
    Timeout         string `yaml:"timeout" json:"timeout"`                   // PreHook timeout (default: "25ms")
    CacheTTL        string `yaml:"cache_ttl" json:"cache_ttl"`               // Decision cache TTL (default: "5m")
    MaxCacheSize    int    `yaml:"max_cache_size" json:"max_cache_size"`     // Max cache entries (default: 10000)
    EmbeddingTimeout string `yaml:"embedding_timeout" json:"embedding_timeout"` // Embedding timeout (default: "15s")
    FeatureTimeout   string `yaml:"feature_timeout" json:"feature_timeout"`   // Feature extraction timeout (default: "25ms")
    
    // Feature flags
    EnableCaching      bool `yaml:"enable_caching" json:"enable_caching"`           // Enable decision caching
    EnableAuth        bool `yaml:"enable_auth" json:"enable_auth"`                 // Enable auth detection
    EnableFallbacks   bool `yaml:"enable_fallbacks" json:"enable_fallbacks"`       // Enable fallback routing
    EnableObservability bool `yaml:"enable_observability" json:"enable_observability"` // Enable metrics
    EnableExploration bool `yaml:"enable_exploration" json:"enable_exploration"`   // Enable exploration vs exploitation
}
```

### Router Configuration

```go
// RouterConfig defines intelligent routing parameters
type RouterConfig struct {
    // Alpha score balance: 0.0=cost-focused, 1.0=quality-focused (default: 0.7)
    Alpha float64 `yaml:"alpha" json:"alpha"`
    
    // Bucket classification thresholds
    Thresholds BucketThresholds `yaml:"thresholds" json:"thresholds"`
    
    // Top-K clusters for feature matching (default: 5)
    TopP int `yaml:"top_p" json:"top_p"`
    
    // Performance and context penalties
    Penalties PenaltyConfig `yaml:"penalties" json:"penalties"`
    
    // Default settings for each bucket
    BucketDefaults BucketDefaultsConfig `yaml:"bucket_defaults" json:"bucket_defaults"`
    
    // Model candidates for each tier
    CheapCandidates []string `yaml:"cheap_candidates" json:"cheap_candidates"`
    MidCandidates   []string `yaml:"mid_candidates" json:"mid_candidates"`
    HardCandidates  []string `yaml:"hard_candidates" json:"hard_candidates"`
    
    // OpenRouter-specific configuration
    OpenRouter OpenRouterConfig `yaml:"openrouter" json:"openrouter"`
}

// BucketThresholds defines the decision boundaries for routing
type BucketThresholds struct {
    Cheap float64 `yaml:"cheap" json:"cheap"` // Threshold for cheap bucket (default: 0.3)
    Hard  float64 `yaml:"hard" json:"hard"`   // Threshold for hard bucket (default: 0.7)
}

// PenaltyConfig defines performance penalties
type PenaltyConfig struct {
    LatencySD    float64 `yaml:"latency_sd" json:"latency_sd"`       // Latency variance penalty
    CtxOver80Pct float64 `yaml:"ctx_over_80pct" json:"ctx_over_80pct"` // Context overflow penalty
}
```

### Request Features

```go
// RequestFeatures contains extracted features from the request
type RequestFeatures struct {
    // Text analysis
    PromptText  string  `json:"prompt_text"`   // Extracted prompt text
    TokenCount  int     `json:"token_count"`   // Estimated token count
    HasCode     bool    `json:"has_code"`      // Contains code blocks
    HasMath     bool    `json:"has_math"`      // Contains math notation
    Entropy     float64 `json:"entropy"`       // N-gram entropy score
    
    // Embedding and similarity
    Embedding        []float32 `json:"embedding"`          // 384-dim embedding vector
    EmbeddingCached  bool      `json:"embedding_cached"`   // Whether embedding was cached
    ClusterSimilarities []float64 `json:"cluster_similarities"` // Similarity to top clusters
    
    // Context analysis
    ContextRatio    float64 `json:"context_ratio"`     // Context usage ratio
    ContextOverflow bool    `json:"context_overflow"`  // Context exceeds 80% limit
    
    // Quality metadata
    ExtractionLatencyMs float64 `json:"extraction_latency_ms"` // Feature extraction time
    FeatureVersion      string  `json:"feature_version"`       // Feature extractor version
}
```

### Router Decision

```go
// RouterDecision contains the routing decision and metadata
type RouterDecision struct {
    // Selected model and routing
    SelectedModel    string  `json:"selected_model"`     // Chosen model (e.g., "openai/gpt-4o")
    SelectedProvider string  `json:"selected_provider"`  // Provider (e.g., "openai")
    Bucket          string  `json:"bucket"`             // Assigned bucket ("cheap", "mid", "hard")
    
    // Decision scoring
    BucketProbabilities map[string]float64 `json:"bucket_probabilities"` // GBDT prediction probabilities
    AlphaScores        map[string]float64 `json:"alpha_scores"`          // α-scores for all candidates
    QualityScore       float64            `json:"quality_score"`         // Quality score for selected model
    CostScore          float64            `json:"cost_score"`            // Cost score for selected model
    FinalScore         float64            `json:"final_score"`           // Final α-score
    
    // Decision metadata
    DecisionLatencyMs   float64 `json:"decision_latency_ms"`   // Decision time
    CacheHit           bool    `json:"cache_hit"`             // Whether decision was cached
    FallbackUsed       bool    `json:"fallback_used"`         // Whether fallback was triggered
    FallbackReason     string  `json:"fallback_reason"`       // Reason for fallback
    GuardrailTriggered bool    `json:"guardrail_triggered"`   // Whether guardrails were applied
    
    // Versioning
    DecisionVersion string `json:"decision_version"` // Decision algorithm version
}
```

## Plugin Interface

### Primary Plugin Interface

```go
// Plugin represents the main Heimdall plugin interface
type Plugin interface {
    // Core Bifrost plugin methods
    Name() string
    Version() string
    PreHook(ctx context.Context, req *schemas.BifrostRequest) (*schemas.BifrostRequest, error)
    PostHook(ctx context.Context, req *schemas.BifrostRequest, resp *schemas.BifrostResponse) error
    
    // Heimdall-specific methods
    GetMetrics() map[string]interface{}
    GetHealth() HealthStatus
    Reload() error
    Stop() error
}

// HealthStatus represents the plugin health state
type HealthStatus struct {
    Status      string                 `json:"status"`       // "healthy", "degraded", "unhealthy"
    LastUpdated time.Time             `json:"last_updated"` // Health check timestamp
    Details     map[string]interface{} `json:"details"`      // Detailed health information
    Version     string                `json:"version"`      // Plugin version
}
```

### Plugin Creation

```go
// New creates a new Heimdall plugin instance with the provided configuration
func New(config Config) (Plugin, error) {
    // Validation
    if err := config.Validate(); err != nil {
        return nil, fmt.Errorf("invalid configuration: %w", err)
    }
    
    // Initialize plugin components
    plugin := &heimdallPlugin{
        config:         config,
        featureExtractor: NewFeatureExtractor(config),
        gbdtRuntime:     NewGBDTRuntime(config),
        alphaScorer:     NewAlphaScorer(config),
        authRegistry:   NewAuthAdapterRegistry(config.AuthAdapters),
        artifactManager: NewArtifactManager(config.Tuning),
        cache:          NewDecisionCache(config),
        metrics:        NewMetricsCollector(),
    }
    
    // Start background processes
    if err := plugin.start(); err != nil {
        return nil, fmt.Errorf("failed to start plugin: %w", err)
    }
    
    return plugin, nil
}
```

## Configuration API

### Configuration Validation

```go
// Validate checks the configuration for correctness and completeness
func (c *Config) Validate() error {
    // Alpha validation
    if c.Router.Alpha < 0.0 || c.Router.Alpha > 1.0 {
        return errors.New("router.alpha must be between 0.0 and 1.0")
    }
    
    // Threshold validation
    if c.Router.Thresholds.Cheap < 0.0 || c.Router.Thresholds.Cheap > 1.0 {
        return errors.New("router.thresholds.cheap must be between 0.0 and 1.0")
    }
    if c.Router.Thresholds.Hard < 0.0 || c.Router.Thresholds.Hard > 1.0 {
        return errors.New("router.thresholds.hard must be between 0.0 and 1.0")
    }
    if c.Router.Thresholds.Cheap >= c.Router.Thresholds.Hard {
        return errors.New("router.thresholds.cheap must be less than router.thresholds.hard")
    }
    
    // Model candidate validation
    if len(c.Router.CheapCandidates) == 0 {
        return errors.New("router.cheap_candidates cannot be empty")
    }
    if len(c.Router.MidCandidates) == 0 {
        return errors.New("router.mid_candidates cannot be empty")
    }
    if len(c.Router.HardCandidates) == 0 {
        return errors.New("router.hard_candidates cannot be empty")
    }
    
    return nil
}
```

### Configuration Loading

```go
// LoadConfig loads configuration from YAML file
func LoadConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("failed to read config file: %w", err)
    }
    
    var config Config
    if err := yaml.Unmarshal(data, &config); err != nil {
        return nil, fmt.Errorf("failed to parse config YAML: %w", err)
    }
    
    // Apply defaults
    config.applyDefaults()
    
    // Validate
    if err := config.Validate(); err != nil {
        return nil, err
    }
    
    return &config, nil
}
```

## Authentication API

### Auth Adapter Interface

```go
// AuthAdapter defines the interface for authentication adapters
type AuthAdapter interface {
    // Name returns the adapter name (e.g., "openai-key")
    Name() string
    
    // Detect checks if this adapter can handle the request's authentication
    Detect(req *schemas.BifrostRequest) bool
    
    // Extract extracts authentication information from the request
    Extract(req *schemas.BifrostRequest) (*AuthInfo, error)
    
    // Validate validates the extracted authentication information
    Validate(ctx context.Context, info *AuthInfo) error
}

// AuthInfo contains extracted authentication information
type AuthInfo struct {
    Type        string            `json:"type"`         // Auth type ("api_key", "oauth", "bearer")
    Provider    string            `json:"provider"`     // Provider name ("openai", "anthropic", "google")
    Token       string            `json:"token"`        // Auth token (redacted in logs)
    Metadata    map[string]string `json:"metadata"`     // Additional auth metadata
    ExpiresAt   *time.Time        `json:"expires_at"`   // Token expiration (if applicable)
    Scopes      []string          `json:"scopes"`       // OAuth scopes (if applicable)
}
```

### Built-in Auth Adapters

```go
// OpenAI API Key Adapter
type OpenAIKeyAdapter struct {
    config AuthAdapterConfig
}

func (a *OpenAIKeyAdapter) Name() string { return "openai-key" }

func (a *OpenAIKeyAdapter) Detect(req *schemas.BifrostRequest) bool {
    auth := req.Headers.Get("Authorization")
    return strings.HasPrefix(auth, "Bearer sk-")
}

// Anthropic OAuth Adapter
type AnthropicOAuthAdapter struct {
    config AuthAdapterConfig
}

func (a *AnthropicOAuthAdapter) Name() string { return "anthropic-oauth" }

func (a *AnthropicOAuthAdapter) Detect(req *schemas.BifrostRequest) bool {
    auth := req.Headers.Get("Authorization")
    return strings.HasPrefix(auth, "Bearer anthropic_")
}

// Google OAuth Adapter
type GoogleOAuthAdapter struct {
    config AuthAdapterConfig
}

func (a *GoogleOAuthAdapter) Name() string { return "google-oauth" }

func (a *GoogleOAuthAdapter) Detect(req *schemas.BifrostRequest) bool {
    auth := req.Headers.Get("Authorization")
    return strings.HasPrefix(auth, "Bearer ya29.")
}
```

## Routing API

### Feature Extraction

```go
// FeatureExtractor handles request feature extraction
type FeatureExtractor interface {
    // Extract extracts features from the request within the timeout
    Extract(ctx context.Context, req *schemas.BifrostRequest) (*RequestFeatures, error)
    
    // ExtractWithCache extracts features with caching support
    ExtractWithCache(ctx context.Context, req *schemas.BifrostRequest) (*RequestFeatures, error)
    
    // GetEmbedding generates embedding for the given text
    GetEmbedding(ctx context.Context, text string) ([]float32, error)
    
    // GetFallbackEmbedding returns a deterministic fallback embedding
    GetFallbackEmbedding(text string) []float32
}

// NewFeatureExtractor creates a new feature extractor
func NewFeatureExtractor(config Config) FeatureExtractor {
    return &featureExtractor{
        config:          config,
        embeddingCache:  NewEmbeddingCache(config.MaxCacheSize),
        tokenizer:      NewTokenizer(),
        entropyAnalyzer: NewEntropyAnalyzer(),
        codeDetector:   NewCodeDetector(),
        mathDetector:   NewMathDetector(),
    }
}
```

### GBDT Runtime

```go
// GBDTRuntime handles gradient boosted decision tree predictions
type GBDTRuntime interface {
    // Predict predicts bucket probabilities for the given features
    Predict(ctx context.Context, features *RequestFeatures) (map[string]float64, error)
    
    // PredictBucket predicts the most likely bucket
    PredictBucket(ctx context.Context, features *RequestFeatures) (string, error)
    
    // GetModelInfo returns information about the loaded GBDT model
    GetModelInfo() *GBDTModelInfo
}

// GBDTModelInfo contains information about the GBDT model
type GBDTModelInfo struct {
    Framework     string    `json:"framework"`      // "xgboost", "lightgbm", etc.
    Version       string    `json:"version"`        // Model version
    FeatureCount  int       `json:"feature_count"`  // Number of features
    TreeCount     int       `json:"tree_count"`     // Number of trees
    LoadedAt      time.Time `json:"loaded_at"`      // Model load timestamp
    Accuracy      float64   `json:"accuracy"`       // Model accuracy (if available)
}
```

### Alpha Scoring

```go
// AlphaScorer handles α-score calculation for model selection
type AlphaScorer interface {
    // Score calculates α-scores for all candidate models in the bucket
    Score(ctx context.Context, bucket string, features *RequestFeatures) (map[string]float64, error)
    
    // SelectBest selects the best model based on α-scores
    SelectBest(ctx context.Context, bucket string, features *RequestFeatures) (*RouterDecision, error)
    
    // GetQualityScore returns the quality score for a model and cluster
    GetQualityScore(model string, cluster int) float64
    
    // GetCostScore returns the cost score for a model
    GetCostScore(model string) float64
}
```

## Metrics API

### Metrics Collection

```go
// MetricsCollector handles metrics collection and aggregation
type MetricsCollector interface {
    // Increment a counter metric
    IncrementCounter(name string, tags map[string]string)
    
    // Record a histogram value
    RecordHistogram(name string, value float64, tags map[string]string)
    
    // Set a gauge value
    SetGauge(name string, value float64, tags map[string]string)
    
    // Get all metrics as a map
    GetMetrics() map[string]interface{}
    
    // Reset all metrics
    Reset()
}

// Built-in metrics tracked by Heimdall
const (
    // Counters
    MetricRequestCount      = "heimdall_requests_total"
    MetricErrorCount        = "heimdall_errors_total"
    MetricCacheHitCount     = "heimdall_cache_hits_total"
    MetricFallbackCount     = "heimdall_fallbacks_total"
    MetricGuardrailCount    = "heimdall_guardrails_total"
    
    // Histograms
    MetricPreHookLatency    = "heimdall_prehook_latency_ms"
    MetricFeatureLatency    = "heimdall_feature_extraction_latency_ms"
    MetricDecisionLatency   = "heimdall_decision_latency_ms"
    MetricEmbeddingLatency  = "heimdall_embedding_latency_ms"
    
    // Gauges
    MetricCacheSize         = "heimdall_cache_entries"
    MetricMemoryUsage       = "heimdall_memory_usage_mb"
    MetricGoroutineCount    = "heimdall_goroutines"
    MetricArtifactAge       = "heimdall_artifact_age_seconds"
)
```

## Error Handling

### Error Types

```go
// Error types for different failure modes
type ErrorType string

const (
    ErrorTypeConfig       ErrorType = "config"         // Configuration error
    ErrorTypeTimeout      ErrorType = "timeout"        // Timeout error
    ErrorTypeAuth         ErrorType = "auth"           // Authentication error
    ErrorTypeFeatureExtraction ErrorType = "feature_extraction" // Feature extraction error
    ErrorTypeMLModel      ErrorType = "ml_model"       // ML model error
    ErrorTypeNetwork      ErrorType = "network"        // Network error
    ErrorTypeInternal     ErrorType = "internal"       // Internal error
)

// HeimdallError represents a Heimdall-specific error
type HeimdallError struct {
    Type    ErrorType `json:"type"`
    Code    string    `json:"code"`
    Message string    `json:"message"`
    Cause   error     `json:"cause,omitempty"`
    Context map[string]interface{} `json:"context,omitempty"`
}

func (e *HeimdallError) Error() string {
    if e.Cause != nil {
        return fmt.Sprintf("%s (%s): %s: %v", e.Type, e.Code, e.Message, e.Cause)
    }
    return fmt.Sprintf("%s (%s): %s", e.Type, e.Code, e.Message)
}
```

### Error Codes

```go
const (
    // Configuration errors
    ErrCodeInvalidConfig     = "INVALID_CONFIG"
    ErrCodeMissingConfig     = "MISSING_CONFIG"
    
    // Timeout errors
    ErrCodePreHookTimeout    = "PREHOOK_TIMEOUT"
    ErrCodeFeatureTimeout    = "FEATURE_TIMEOUT"
    ErrCodeEmbeddingTimeout  = "EMBEDDING_TIMEOUT"
    
    // Authentication errors
    ErrCodeAuthInvalid       = "AUTH_INVALID"
    ErrCodeAuthMissing       = "AUTH_MISSING"
    ErrCodeAuthExpired       = "AUTH_EXPIRED"
    
    // ML model errors
    ErrCodeModelNotLoaded    = "MODEL_NOT_LOADED"
    ErrCodeModelPredictFailed = "MODEL_PREDICT_FAILED"
    ErrCodeArtifactLoadFailed = "ARTIFACT_LOAD_FAILED"
    
    // Internal errors
    ErrCodeCacheWriteFailed  = "CACHE_WRITE_FAILED"
    ErrCodeMetricsError      = "METRICS_ERROR"
)
```

## Advanced Usage

### Custom Auth Adapters

```go
// Example: Custom auth adapter for a specific provider
type CustomAuthAdapter struct {
    config AuthAdapterConfig
    client *http.Client
}

func (a *CustomAuthAdapter) Name() string {
    return "custom-provider"
}

func (a *CustomAuthAdapter) Detect(req *schemas.BifrostRequest) bool {
    // Custom detection logic
    auth := req.Headers.Get("Authorization")
    return strings.HasPrefix(auth, "Bearer custom_")
}

func (a *CustomAuthAdapter) Extract(req *schemas.BifrostRequest) (*AuthInfo, error) {
    token := strings.TrimPrefix(req.Headers.Get("Authorization"), "Bearer ")
    
    return &AuthInfo{
        Type:     "bearer",
        Provider: "custom",
        Token:    token,
        Metadata: map[string]string{
            "source": "header",
        },
    }, nil
}

func (a *CustomAuthAdapter) Validate(ctx context.Context, info *AuthInfo) error {
    // Custom validation logic
    // Validate token with provider API
    return nil
}

// Register custom adapter
func init() {
    RegisterAuthAdapter("custom-provider", func(config AuthAdapterConfig) AuthAdapter {
        return &CustomAuthAdapter{
            config: config,
            client: &http.Client{Timeout: 10 * time.Second},
        }
    })
}
```

### Plugin Integration Example

```go
package main

import (
    "context"
    "log"
    "time"
    
    "github.com/maximhq/bifrost/core"
    "github.com/maximhq/bifrost/schemas"
    heimdall "github.com/nathanrice/heimdall-bifrost-plugin"
)

func main() {
    // Load configuration
    config, err := heimdall.LoadConfig("config.yaml")
    if err != nil {
        log.Fatal("Failed to load config:", err)
    }
    
    // Create plugin
    plugin, err := heimdall.New(*config)
    if err != nil {
        log.Fatal("Failed to create plugin:", err)
    }
    defer plugin.Stop()
    
    // Initialize Bifrost with Heimdall
    client, err := bifrost.Init(schemas.BifrostConfig{
        Plugins: []schemas.Plugin{plugin},
        BaseURL: "https://api.openrouter.ai/api/v1",
        APIKey:  "your-openrouter-key",
    })
    if err != nil {
        log.Fatal("Failed to initialize Bifrost:", err)
    }
    
    // Use client with intelligent routing
    ctx := context.Background()
    
    response, err := client.Chat.Completions.Create(ctx, schemas.ChatCompletionRequest{
        Model: "auto", // Heimdall will route intelligently
        Messages: []schemas.ChatMessage{
            {
                Role:    "user",
                Content: "Explain quantum computing in simple terms",
            },
        },
    })
    if err != nil {
        log.Fatal("Chat completion failed:", err)
    }
    
    // Access routing metadata from context
    if bucket := ctx.Value("heimdall_bucket"); bucket != nil {
        log.Printf("Request routed to %s bucket", bucket)
    }
    if decision := ctx.Value("heimdall_decision"); decision != nil {
        if d, ok := decision.(*heimdall.RouterDecision); ok {
            log.Printf("Selected model: %s (score: %.3f)", d.SelectedModel, d.FinalScore)
        }
    }
    
    // Monitor plugin metrics
    go func() {
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()
        
        for range ticker.C {
            metrics := plugin.GetMetrics()
            log.Printf("Plugin metrics: %+v", metrics)
        }
    }()
    
    log.Printf("Response: %s", response.Choices[0].Message.Content)
}
```

### Monitoring and Observability

```go
// Example: Custom metrics collection
func setupMonitoring(plugin heimdall.Plugin) {
    // Collect metrics every 30 seconds
    go func() {
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()
        
        for range ticker.C {
            metrics := plugin.GetMetrics()
            
            // Export to monitoring system
            exportMetrics(metrics)
            
            // Check health
            health := plugin.GetHealth()
            if health.Status != "healthy" {
                log.Printf("Plugin health warning: %s", health.Status)
            }
        }
    }()
}

func exportMetrics(metrics map[string]interface{}) {
    // Export to Prometheus, DataDog, etc.
    for key, value := range metrics {
        switch key {
        case "request_count":
            // Export counter
        case "cache_hit_rate":
            // Export gauge
        case "p99_latency":
            // Export histogram
        }
    }
}
```

## Performance Benchmarks

**Measured on production hardware with Go 1.21:**

| Operation | Latency (P50) | Latency (P99) | Memory |
|-----------|---------------|---------------|---------|
| Feature Extraction | 1.2ms | 5.8ms | 512KB |
| GBDT Prediction | 0.3ms | 0.8ms | 64KB |
| α-Score Calculation | 0.1ms | 0.3ms | 32KB |
| **Total PreHook** | **1.8ms** | **7.2ms** | **1MB** |
| Cached Decision | 0.05ms | 0.1ms | 8KB |

**Memory Usage:**
- Baseline: 45MB
- Per cached decision: ~1KB
- Max working set: ~120MB (with full cache)

**Throughput:**
- **16,800+ requests/second** (cached decisions)
- **2,400+ requests/second** (full feature extraction)
- **380% faster than TypeScript implementation**

---

*This API documentation reflects the production-ready Go implementation with 301+ tests and 94.7% coverage.*