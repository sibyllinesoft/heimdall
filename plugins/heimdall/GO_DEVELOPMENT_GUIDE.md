# Go Development Guide - Heimdall Plugin

**Complete development setup and contribution guide for the high-performance Go implementation**

## Table of Contents

- [Development Environment Setup](#development-environment-setup)
- [Project Structure](#project-structure)
- [Building and Testing](#building-and-testing)
- [Code Quality Standards](#code-quality-standards)
- [Performance Optimization](#performance-optimization)
- [Debugging and Profiling](#debugging-and-profiling)
- [Contributing Guidelines](#contributing-guidelines)
- [Advanced Development](#advanced-development)

## Development Environment Setup

### Prerequisites

**Required:**
- **Go 1.21+** (for performance features and standard library improvements)
- **Git** (version control)
- **Make** (build automation)

**Recommended:**
- **VS Code** with Go extension
- **GoLand** (JetBrains IDE)
- **Docker** (for integration testing)

### Go Installation and Setup

```bash
# Option 1: Use provided script (installs latest stable)
./install-go.sh

# Option 2: Manual installation
curl -L https://golang.org/dl/go1.21.linux-amd64.tar.gz | tar -C /usr/local -xzf -
export PATH=$PATH:/usr/local/go/bin

# Verify installation
go version
# Should output: go version go1.21.x linux/amd64
```

### Project Setup

```bash
# Clone the repository
git clone <repository-url>
cd heimdall/plugins/heimdall

# Verify Go environment
go env GOVERSION GOROOT GOPATH

# Download dependencies
go mod download

# Verify setup with quick test
go test -v -short
```

### IDE Configuration

#### VS Code Setup (.vscode/settings.json)
```json
{
    "go.useLanguageServer": true,
    "go.languageServerFlags": ["-rpc.trace", "--debug=localhost:6060"],
    "go.lintTool": "golangci-lint",
    "go.formatTool": "goimports",
    "go.testFlags": ["-v", "-race"],
    "go.buildTags": "integration",
    "go.testTimeout": "30s",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
        "source.organizeImports": true
    }
}
```

#### GoLand Configuration
1. **File > Settings > Go > Build Tags**: Add `integration`
2. **File > Settings > Tools > File Watchers**: Enable Go fmt and Go imports
3. **Run/Debug Configuration**: Set test timeout to 30s with `-race` flag

## Project Structure

### Directory Layout

```
plugins/heimdall/                 # 🚀 Production Go plugin
├── main.go                       # 🔌 Bifrost plugin entry point
├── types.go                      # 📋 Core type definitions
├── config.go                     # ⚙️  Configuration management
├── plugin.go                     # 🎯 Main plugin implementation
├── 
├── # Core routing engine
├── router_execution.go           # 🧠 Request routing logic
├── feature_extraction.go         # 📊 Request analysis
├── gbdt_runtime.go              # 🌲 ML model execution
├── alpha_scoring.go             # ⚖️  Model selection
├── 
├── # Authentication system
├── auth_adapter.go              # 🔐 Auth adapter interface
├── auth_openai.go              # 🤖 OpenAI key adapter
├── auth_anthropic.go           # 🧑‍💼 Anthropic OAuth adapter
├── auth_google.go              # 🌐 Google OAuth adapter
├── 
├── # External services
├── catalog_client.go           # 📋 Model catalog client
├── artifact_manager.go         # 🎯 ML artifact management
├── 
├── # Performance & observability
├── cache.go                    # ⚡ Decision caching
├── metrics.go                  # 📊 Metrics collection
├── performance_benchmark.go    # 🏃‍♂️ Performance testing
├── 
├── # Testing infrastructure
├── *_test.go                   # 🧪 Unit tests (301+ tests)
├── testdata/                   # 📁 Test fixtures and data
├── integration_test.go         # 🔄 Integration tests
├── benchmark_test.go           # 📈 Performance benchmarks
├── 
├── # Build & deployment
├── go.mod                      # 📦 Dependencies
├── go.sum                      # 🔒 Dependency checksums
├── Makefile                    # 🔨 Build automation
├── validate.sh                 # ✅ Validation script
├── deploy.sh                   # 🚀 Deployment script
├── 
├── # Documentation
├── README.md                   # 📖 Main documentation
├── API_DOCUMENTATION.md        # 📚 Complete API reference
├── GO_DEVELOPMENT_GUIDE.md     # 👨‍💻 This file
└── PERFORMANCE_OPTIMIZATION.md # ⚡ Performance tuning guide
```

### Code Organization Principles

**1. Separation of Concerns**
```go
// ✅ Good: Clear separation
type Plugin struct {
    router    Router         // Handles routing logic
    auth      AuthRegistry   // Handles authentication
    metrics   MetricsCollector // Handles observability
}

// ❌ Bad: Mixed responsibilities
type Plugin struct {
    // Everything mixed together
}
```

**2. Interface-Based Design**
```go
// ✅ Good: Interface for testability
type FeatureExtractor interface {
    Extract(ctx context.Context, req *Request) (*Features, error)
}

// ❌ Bad: Concrete types everywhere
func ProcessRequest(extractor *ConcreteExtractor) { /* ... */ }
```

**3. Error Handling**
```go
// ✅ Good: Wrapped errors with context
if err := plugin.Start(); err != nil {
    return fmt.Errorf("failed to start plugin: %w", err)
}

// ❌ Bad: Lost error context
if err := plugin.Start(); err != nil {
    return err
}
```

## Building and Testing

### Build Commands

```bash
# Standard build
go build -o heimdall-plugin

# Optimized production build
go build -ldflags="-w -s" -o heimdall-plugin

# Build with version info
VERSION=$(git describe --tags --always)
go build -ldflags="-X main.version=$VERSION" -o heimdall-plugin

# Cross-platform builds
GOOS=linux GOARCH=amd64 go build -o heimdall-plugin-linux-amd64
GOOS=darwin GOARCH=amd64 go build -o heimdall-plugin-darwin-amd64
GOOS=windows GOARCH=amd64 go build -o heimdall-plugin-windows-amd64.exe
```

### Testing Strategy

**Test Pyramid:**
```
    E2E Tests (10%)         # Full integration tests
      ↗           ↖
Integration Tests (20%)     # Component interaction tests  
      ↗           ↖
  Unit Tests (70%)          # Fast, isolated tests
```

### Test Commands

```bash
# Run all tests (301+ tests)
go test -v ./...

# Run with race detection (critical for concurrent code)
go test -race -v ./...

# Run tests with coverage
go test -coverprofile=coverage.out -covermode=atomic ./...
go tool cover -html=coverage.out -o coverage.html

# Run only fast tests (exclude integration)
go test -v -short ./...

# Run only integration tests
go test -v -tags=integration ./...

# Run specific test by name
go test -v -run TestFeatureExtraction ./...

# Run benchmarks
go test -bench=. -benchmem ./...

# Run benchmarks for specific functions
go test -bench=BenchmarkPreHook -benchtime=10s ./...
```

### Test Categories

**1. Unit Tests (70% of test suite)**
```go
func TestFeatureExtractor_Extract(t *testing.T) {
    tests := []struct {
        name     string
        input    *BifrostRequest
        expected *RequestFeatures
        wantErr  bool
    }{
        {
            name: "basic text extraction",
            input: &BifrostRequest{
                Messages: []Message{{Content: "Hello world"}},
            },
            expected: &RequestFeatures{
                PromptText: "Hello world",
                TokenCount: 2,
                HasCode: false,
                HasMath: false,
            },
            wantErr: false,
        },
        // More test cases...
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            extractor := NewFeatureExtractor(defaultConfig)
            result, err := extractor.Extract(context.Background(), tt.input)
            
            if tt.wantErr {
                assert.Error(t, err)
                return
            }
            
            assert.NoError(t, err)
            assert.Equal(t, tt.expected.PromptText, result.PromptText)
            assert.Equal(t, tt.expected.TokenCount, result.TokenCount)
        })
    }
}
```

**2. Integration Tests (20% of test suite)**
```go
// +build integration

func TestPluginIntegration(t *testing.T) {
    // Start test dependencies
    catalog := startTestCatalog(t)
    defer catalog.Stop()
    
    // Create plugin with test config
    config := testConfig()
    plugin, err := New(config)
    require.NoError(t, err)
    defer plugin.Stop()
    
    // Test full request flow
    req := &BifrostRequest{
        Messages: []Message{{Content: "Complex reasoning task"}},
    }
    
    result, err := plugin.PreHook(context.Background(), req)
    require.NoError(t, err)
    
    // Verify routing decision
    assert.Contains(t, req.Headers.Get("X-Selected-Model"), "gpt")
    assert.NotEmpty(t, req.Context.Value("heimdall_decision"))
}
```

**3. Benchmark Tests (Performance validation)**
```go
func BenchmarkPreHook(b *testing.B) {
    plugin := setupBenchmarkPlugin(b)
    req := &BifrostRequest{
        Messages: []Message{{Content: benchmarkText}},
    }
    
    b.ResetTimer()
    b.ReportAllocs()
    
    for i := 0; i < b.N; i++ {
        _, err := plugin.PreHook(context.Background(), req)
        if err != nil {
            b.Fatal(err)
        }
    }
}

func BenchmarkFeatureExtraction(b *testing.B) {
    extractor := NewFeatureExtractor(defaultConfig)
    req := &BifrostRequest{
        Messages: []Message{{Content: complexPrompt}},
    }
    
    b.ResetTimer()
    
    for i := 0; i < b.N; i++ {
        _, err := extractor.Extract(context.Background(), req)
        if err != nil {
            b.Fatal(err)
        }
    }
}
```

### Continuous Integration

**Makefile targets:**
```makefile
.PHONY: test test-race test-coverage test-integration bench lint fmt clean

# Run all tests
test:
	go test -v ./...

# Run with race detection
test-race:
	go test -race -v ./...

# Generate coverage report
test-coverage:
	go test -coverprofile=coverage.out -covermode=atomic ./...
	go tool cover -html=coverage.out -o coverage.html

# Run integration tests
test-integration:
	go test -v -tags=integration ./...

# Run benchmarks
bench:
	go test -bench=. -benchmem ./...

# Lint code
lint:
	golangci-lint run

# Format code
fmt:
	goimports -w .
	gofmt -s -w .

# Clean build artifacts
clean:
	go clean
	rm -f heimdall-plugin coverage.out coverage.html
```

## Code Quality Standards

### Linting Configuration (.golangci.yml)

```yaml
linters-settings:
  govet:
    check-shadowing: true
  golint:
    min-confidence: 0
  gocyclo:
    min-complexity: 15
  maligned:
    suggest-new: true
  dupl:
    threshold: 100
  goconst:
    min-len: 2
    min-occurrences: 2
  depguard:
    list-type: blacklist
    packages:
      - github.com/sirupsen/logrus
  misspell:
    locale: US
  lll:
    line-length: 140
  goimports:
    local-prefixes: github.com/nathanrice/heimdall
  gocritic:
    enabled-tags:
      - diagnostic
      - experimental
      - opinionated
      - performance
      - style

linters:
  enable:
    - bodyclose
    - depguard
    - dogsled
    - dupl
    - errcheck
    - exportloopref
    - gochecknoinits
    - goconst
    - gocritic
    - gocyclo
    - gofmt
    - goimports
    - golint
    - gomnd
    - goprintffuncname
    - gosec
    - gosimple
    - govet
    - ineffassign
    - lll
    - misspell
    - nakedret
    - rowserrcheck
    - staticcheck
    - structcheck
    - stylecheck
    - typecheck
    - unconvert
    - unparam
    - unused
    - varcheck
    - whitespace

run:
  timeout: 5m
  issues-exit-code: 1
  tests: true
  skip-dirs:
    - testdata

issues:
  exclude-rules:
    - path: _test\.go
      linters:
        - gomnd
        - lll
        - dupl
```

### Code Style Guidelines

**1. Naming Conventions**
```go
// ✅ Good: Clear, descriptive names
type FeatureExtractor interface {
    ExtractRequestFeatures(ctx context.Context, req *Request) (*Features, error)
}

var ErrInvalidConfiguration = errors.New("invalid configuration")

const DefaultTimeoutMS = 25

// ❌ Bad: Unclear abbreviations
type FE interface {
    ExtractReqFeat(c context.Context, r *Req) (*Feat, error)
}
```

**2. Function Design**
```go
// ✅ Good: Single responsibility, clear interface
func (e *FeatureExtractor) extractTokenCount(text string) int {
    return len(strings.Fields(text))
}

// ❌ Bad: Multiple responsibilities
func (e *FeatureExtractor) extractEverything(req *Request) (*Features, *Decision, *Auth, error) {
    // Does too many things
}
```

**3. Error Handling**
```go
// ✅ Good: Comprehensive error handling
func (p *Plugin) PreHook(ctx context.Context, req *Request) (*Request, error) {
    features, err := p.featureExtractor.Extract(ctx, req)
    if err != nil {
        return nil, &HeimdallError{
            Type:    ErrorTypeFeatureExtraction,
            Code:    ErrCodeFeatureTimeout,
            Message: "failed to extract request features",
            Cause:   err,
            Context: map[string]interface{}{
                "request_id": req.ID,
                "timeout":    p.config.FeatureTimeout,
            },
        }
    }
    
    // Continue processing...
    return req, nil
}
```

**4. Documentation**
```go
// ✅ Good: Complete function documentation
// Extract analyzes the request and extracts features for routing decisions.
// It returns RequestFeatures containing embedding, token count, code detection,
// and other analysis results within the configured timeout.
//
// Features extracted:
//   - Text embedding (384-dimensional vector)
//   - Token count estimation
//   - Code/math content detection
//   - N-gram entropy calculation
//
// The extraction process respects the timeout context and will return
// fallback values if embedding generation times out.
func (e *FeatureExtractor) Extract(ctx context.Context, req *BifrostRequest) (*RequestFeatures, error) {
    // Implementation...
}
```

## Performance Optimization

### Go-Specific Optimizations

**1. Memory Management**
```go
// ✅ Good: Reuse slices and objects
type EmbeddingCache struct {
    cache map[string][]float32
    pool  sync.Pool // Reuse embedding slices
}

func (c *EmbeddingCache) Get(key string) []float32 {
    if cached, ok := c.cache[key]; ok {
        // Return copy to avoid mutation
        result := c.getSlice()[:len(cached)]
        copy(result, cached)
        return result
    }
    return nil
}

func (c *EmbeddingCache) getSlice() []float32 {
    if slice := c.pool.Get(); slice != nil {
        return slice.([]float32)[:0] // Reset length but keep capacity
    }
    return make([]float32, 0, 384) // Standard embedding dimension
}

// ❌ Bad: Constant allocation
func (c *EmbeddingCache) Get(key string) []float32 {
    if cached, ok := c.cache[key]; ok {
        result := make([]float32, len(cached)) // New allocation every time
        copy(result, cached)
        return result
    }
    return nil
}
```

**2. Concurrent Processing**
```go
// ✅ Good: Parallel feature extraction
func (e *FeatureExtractor) Extract(ctx context.Context, req *Request) (*RequestFeatures, error) {
    var wg sync.WaitGroup
    results := make(chan interface{}, 4)
    
    // Extract features concurrently
    wg.Add(4)
    
    go func() {
        defer wg.Done()
        embedding := e.extractEmbedding(ctx, req.Text)
        results <- embedding
    }()
    
    go func() {
        defer wg.Done()
        tokens := e.extractTokenCount(req.Text)
        results <- tokens
    }()
    
    go func() {
        defer wg.Done()
        hasCode := e.detectCode(req.Text)
        results <- hasCode
    }()
    
    go func() {
        defer wg.Done()
        entropy := e.calculateEntropy(req.Text)
        results <- entropy
    }()
    
    // Wait and collect results
    go func() {
        wg.Wait()
        close(results)
    }()
    
    // Assemble features
    features := &RequestFeatures{}
    for result := range results {
        switch v := result.(type) {
        case []float32:
            features.Embedding = v
        case int:
            features.TokenCount = v
        case bool:
            features.HasCode = v
        case float64:
            features.Entropy = v
        }
    }
    
    return features, nil
}
```

**3. Efficient String Processing**
```go
// ✅ Good: Use strings.Builder for concatenation
func (e *FeatureExtractor) extractText(messages []Message) string {
    var builder strings.Builder
    builder.Grow(1024) // Pre-allocate capacity
    
    for _, msg := range messages {
        builder.WriteString(msg.Content)
        builder.WriteByte('\n')
    }
    
    return strings.TrimSpace(builder.String())
}

// ❌ Bad: String concatenation creates many allocations
func (e *FeatureExtractor) extractText(messages []Message) string {
    var text string
    for _, msg := range messages {
        text += msg.Content + "\n" // Creates new string each iteration
    }
    return strings.TrimSpace(text)
}
```

### Profiling and Optimization

**1. CPU Profiling**
```bash
# Profile CPU usage during benchmarks
go test -bench=BenchmarkPreHook -cpuprofile=cpu.prof
go tool pprof cpu.prof

# Commands in pprof:
# (pprof) top10          # Show top CPU consumers
# (pprof) list main      # Show annotated source
# (pprof) web            # Open web interface
```

**2. Memory Profiling**
```bash
# Profile memory allocation during benchmarks
go test -bench=BenchmarkFeatureExtraction -memprofile=mem.prof
go tool pprof mem.prof

# Commands in pprof:
# (pprof) top10 -alloc_space    # Show top allocators
# (pprof) list FeatureExtractor  # Show annotated source
```

**3. Trace Analysis**
```bash
# Generate execution trace
go test -bench=BenchmarkPreHook -trace=trace.out
go tool trace trace.out

# Analyze:
# - Goroutine scheduling
# - GC behavior
# - Blocking operations
# - HTTP requests
```

## Debugging and Profiling

### Debug Build Configuration

```bash
# Build with debug information
go build -gcflags="all=-N -l" -o heimdall-plugin-debug

# Enable race detection
go build -race -o heimdall-plugin-race

# Enable memory debugging
GODEBUG=gctrace=1 ./heimdall-plugin
```

### Debugging Tools

**1. Delve Debugger**
```bash
# Install delve
go install github.com/go-delve/delve/cmd/dlv@latest

# Debug tests
dlv test -- -test.run TestFeatureExtraction

# Debug binary
dlv exec ./heimdall-plugin

# Debug with IDE integration (VS Code)
# Use launch.json configuration
```

**2. Logging Configuration**
```go
// Development logging setup
func setupDevLogging() {
    log.SetLevel(log.DebugLevel)
    log.SetFormatter(&log.TextFormatter{
        FullTimestamp: true,
        DisableColors: false,
    })
    
    // Add file and line information
    log.SetReportCaller(true)
}

// Production logging setup  
func setupProdLogging() {
    log.SetLevel(log.InfoLevel)
    log.SetFormatter(&log.JSONFormatter{})
    log.SetReportCaller(false)
}
```

**3. Performance Monitoring**
```go
// Built-in performance metrics
func (p *Plugin) collectMetrics() {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    
    for range ticker.C {
        var m runtime.MemStats
        runtime.ReadMemStats(&m)
        
        p.metrics.SetGauge("memory_usage_mb", float64(m.Alloc)/1024/1024, nil)
        p.metrics.SetGauge("goroutine_count", float64(runtime.NumGoroutine()), nil)
        p.metrics.SetGauge("gc_pause_ns", float64(m.PauseNs[(m.NumGC+255)%256]), nil)
    }
}
```

## Contributing Guidelines

### Development Workflow

**1. Fork and Branch**
```bash
# Fork the repository on GitHub
git clone https://github.com/yourusername/heimdall.git
cd heimdall/plugins/heimdall

# Create feature branch
git checkout -b feature/amazing-improvement
```

**2. Development Process**
```bash
# Make changes and test continuously
go test -v -race ./...

# Run linting
golangci-lint run

# Format code
goimports -w .
gofmt -s -w .

# Run complete validation
./validate.sh
```

**3. Commit Standards**
```bash
# Follow conventional commit format
git commit -m "feat: add embedding caching for 40% performance boost

- Implement LRU cache for embedding vectors
- Add cache hit metrics and monitoring
- Include comprehensive cache tests
- Update performance benchmarks

Closes #123"

# Types: feat, fix, docs, style, refactor, perf, test, chore
```

**4. Pull Request Process**
```bash
# Push branch
git push origin feature/amazing-improvement

# Create PR with:
# - Clear title and description
# - Link to issues
# - Performance impact analysis
# - Test coverage report
# - Breaking changes note (if any)
```

### Code Review Checklist

**For Authors:**
- [ ] All tests pass (`go test -race -v ./...`)
- [ ] Code coverage maintained (>94%)
- [ ] Linting passes (`golangci-lint run`)
- [ ] Performance benchmarks included
- [ ] Documentation updated
- [ ] Breaking changes documented

**For Reviewers:**
- [ ] Code follows Go idioms and project style
- [ ] Error handling is comprehensive
- [ ] No race conditions or deadlocks
- [ ] Performance impact is understood
- [ ] Tests cover edge cases
- [ ] Documentation is accurate

### Release Process

**1. Version Bumping**
```bash
# Update version in main.go
const Version = "v1.2.3"

# Tag release
git tag -a v1.2.3 -m "Release v1.2.3: Performance improvements"
git push origin v1.2.3
```

**2. Release Notes Template**
```markdown
## Heimdall Plugin v1.2.3

### 🚀 Performance Improvements
- **40% faster feature extraction** through embedding caching
- **25% memory reduction** with optimized data structures

### 🧪 Testing
- **315+ comprehensive tests** (up from 301+)
- **95.2% code coverage** (up from 94.7%)

### 🔧 Bug Fixes  
- Fixed race condition in cache eviction (#456)
- Improved error handling for malformed requests (#478)

### 📊 Metrics
- PreHook latency: P50=0.8ms, P99=3.2ms (vs 1.2ms/5.8ms)
- Memory usage: 38MB baseline (vs 45MB)
- Throughput: 21,000+ req/sec (vs 16,800)

### 💥 Breaking Changes
None - fully backward compatible
```

## Advanced Development

### Custom Components

**1. Custom Auth Adapter**
```go
// Implement AuthAdapter interface
type CustomOAuthAdapter struct {
    config AuthAdapterConfig
    client *http.Client
}

func (a *CustomOAuthAdapter) Name() string {
    return "custom-oauth"
}

func (a *CustomOAuthAdapter) Detect(req *BifrostRequest) bool {
    return strings.HasPrefix(req.Headers.Get("Authorization"), "Bearer custom_")
}

func (a *CustomOAuthAdapter) Extract(req *BifrostRequest) (*AuthInfo, error) {
    // Custom extraction logic
}

func (a *CustomOAuthAdapter) Validate(ctx context.Context, info *AuthInfo) error {
    // Custom validation logic
}

// Register in init()
func init() {
    RegisterAuthAdapter("custom-oauth", func(config AuthAdapterConfig) AuthAdapter {
        return &CustomOAuthAdapter{config: config}
    })
}
```

**2. Custom Feature Extractor**
```go
// Extend feature extraction
type EnhancedFeatureExtractor struct {
    base     FeatureExtractor
    nlpModel *NLPModel
}

func (e *EnhancedFeatureExtractor) Extract(ctx context.Context, req *BifrostRequest) (*RequestFeatures, error) {
    // Get base features
    features, err := e.base.Extract(ctx, req)
    if err != nil {
        return nil, err
    }
    
    // Add custom analysis
    sentiment, err := e.nlpModel.AnalyzeSentiment(req.Text)
    if err != nil {
        log.Printf("Sentiment analysis failed: %v", err)
        // Continue without sentiment - don't fail the request
    } else {
        features.Metadata["sentiment"] = sentiment
    }
    
    return features, nil
}
```

### Integration Testing

**1. Test Environment Setup**
```go
// +build integration

func TestMain(m *testing.M) {
    // Setup test environment
    testDB := setupTestDatabase()
    testCatalog := startTestCatalogService()
    testArtifacts := setupTestArtifacts()
    
    // Run tests
    code := m.Run()
    
    // Cleanup
    testDB.Close()
    testCatalog.Stop()
    os.RemoveAll("testdata/temp")
    
    os.Exit(code)
}

func TestFullIntegration(t *testing.T) {
    // Test complete request flow with real services
    config := integrationConfig()
    plugin, err := New(config)
    require.NoError(t, err)
    defer plugin.Stop()
    
    // Test various request patterns
    testCases := []struct {
        name     string
        request  *BifrostRequest
        expected string // Expected bucket or model pattern
    }{
        {"simple query", simpleRequest(), "cheap"},
        {"code generation", codeRequest(), "mid"},
        {"complex reasoning", complexRequest(), "hard"},
    }
    
    for _, tc := range testCases {
        t.Run(tc.name, func(t *testing.T) {
            result, err := plugin.PreHook(context.Background(), tc.request)
            require.NoError(t, err)
            
            bucket := result.Context.Value("heimdall_bucket").(string)
            assert.Equal(t, tc.expected, bucket)
        })
    }
}
```

### Load Testing

**1. Stress Testing Setup**
```go
func BenchmarkConcurrentRequests(b *testing.B) {
    plugin := setupBenchmarkPlugin(b)
    requests := generateTestRequests(1000)
    
    b.SetParallelism(runtime.NumCPU())
    b.ResetTimer()
    
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            req := requests[i%len(requests)]
            _, err := plugin.PreHook(context.Background(), req)
            if err != nil {
                b.Error(err)
            }
            i++
        }
    })
}

func BenchmarkMemoryUsage(b *testing.B) {
    plugin := setupBenchmarkPlugin(b)
    req := generateComplexRequest()
    
    b.ReportAllocs()
    b.ResetTimer()
    
    for i := 0; i < b.N; i++ {
        _, err := plugin.PreHook(context.Background(), req)
        if err != nil {
            b.Fatal(err)
        }
    }
}
```

**Performance Targets:**
- **Latency**: P99 < 10ms for PreHook execution
- **Throughput**: >15,000 requests/second
- **Memory**: <100MB with 10K cached decisions
- **Concurrency**: Support 1000+ concurrent goroutines

---

*This development guide reflects the production-ready Go implementation with comprehensive testing and performance optimization strategies.*