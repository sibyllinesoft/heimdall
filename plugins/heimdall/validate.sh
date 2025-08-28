#!/bin/bash
# Comprehensive Heimdall Go Implementation Validation Script
# Generated on: 2025-08-28
# Validates Go implementation readiness for production

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# Validation results
VALIDATION_RESULTS=()

# Check if Go is available
check_go_installation() {
    log_info "Checking Go installation..."
    if ! command -v go >/dev/null 2>&1; then
        log_error "Go is not installed or not in PATH"
        log_info "Please run ./install-go.sh first"
        exit 1
    fi
    
    GO_VERSION=$(go version)
    log_success "Go found: $GO_VERSION"
}

# Initialize Go module and dependencies
setup_go_module() {
    log_info "Setting up Go module..."
    
    if [ ! -f "go.mod" ]; then
        go mod init github.com/heimdall/plugins/heimdall
        log_success "Initialized Go module"
    fi
    
    # Install dependencies
    log_info "Installing dependencies..."
    go mod tidy
    go mod download
    log_success "Dependencies installed"
}

# Run comprehensive test suite
run_test_suite() {
    log_info "Running comprehensive test suite..."
    
    # Test with race detection
    log_info "Running tests with race detection..."
    if go test -race -v -count=1 ./... > test_results.log 2>&1; then
        TEST_COUNT=$(grep -c "=== RUN" test_results.log || echo "0")
        PASS_COUNT=$(grep -c "--- PASS:" test_results.log || echo "0")
        log_success "All tests passed: $PASS_COUNT/$TEST_COUNT"
        VALIDATION_RESULTS+=("✅ Test Suite: $PASS_COUNT/$TEST_COUNT tests passed")
    else
        log_error "Tests failed - check test_results.log"
        VALIDATION_RESULTS+=("❌ Test Suite: Tests failed")
        return 1
    fi
    
    # Run benchmarks
    log_info "Running performance benchmarks..."
    if go test -bench=. -benchmem ./... > benchmark_results.log 2>&1; then
        log_success "Benchmarks completed - check benchmark_results.log"
        VALIDATION_RESULTS+=("✅ Benchmarks: Completed successfully")
    else
        log_warning "Benchmarks had issues - check benchmark_results.log"
        VALIDATION_RESULTS+=("⚠️  Benchmarks: Some issues detected")
    fi
}

# Code quality checks
run_quality_checks() {
    log_info "Running code quality checks..."
    
    # Format check
    log_info "Checking code formatting..."
    if [ -z "$(gofmt -l .)" ]; then
        log_success "Code is properly formatted"
        VALIDATION_RESULTS+=("✅ Code Format: Properly formatted")
    else
        log_warning "Code formatting issues found"
        gofmt -l .
        VALIDATION_RESULTS+=("⚠️  Code Format: Issues found")
    fi
    
    # Vet check
    log_info "Running go vet..."
    if go vet ./... > vet_results.log 2>&1; then
        log_success "go vet passed"
        VALIDATION_RESULTS+=("✅ Go Vet: Passed")
    else
        log_warning "go vet found issues - check vet_results.log"
        VALIDATION_RESULTS+=("⚠️  Go Vet: Issues found")
    fi
    
    # Lint check (if golangci-lint is available)
    if command -v golangci-lint >/dev/null 2>&1; then
        log_info "Running golangci-lint..."
        if golangci-lint run > lint_results.log 2>&1; then
            log_success "Linting passed"
            VALIDATION_RESULTS+=("✅ Linting: Passed")
        else
            log_warning "Linting issues found - check lint_results.log"
            VALIDATION_RESULTS+=("⚠️  Linting: Issues found")
        fi
    fi
    
    # Security check (if gosec is available)
    if command -v gosec >/dev/null 2>&1; then
        log_info "Running security scan..."
        if gosec ./... > security_results.log 2>&1; then
            log_success "Security scan passed"
            VALIDATION_RESULTS+=("✅ Security: No issues found")
        else
            log_warning "Security issues found - check security_results.log"
            VALIDATION_RESULTS+=("⚠️  Security: Issues found")
        fi
    fi
}

# Test coverage analysis
analyze_coverage() {
    log_info "Analyzing test coverage..."
    
    if go test -coverprofile=coverage.out ./... > coverage_results.log 2>&1; then
        COVERAGE=$(go tool cover -func=coverage.out | grep "total:" | awk '{print $3}')
        log_success "Test coverage: $COVERAGE"
        VALIDATION_RESULTS+=("✅ Coverage: $COVERAGE")
        
        # Generate HTML coverage report
        go tool cover -html=coverage.out -o coverage.html
        log_success "Coverage report generated: coverage.html"
    else
        log_warning "Coverage analysis failed"
        VALIDATION_RESULTS+=("⚠️  Coverage: Analysis failed")
    fi
}

# Build verification
verify_build() {
    log_info "Verifying build process..."
    
    if go build -v ./... > build_results.log 2>&1; then
        log_success "Build successful"
        VALIDATION_RESULTS+=("✅ Build: Successful")
    else
        log_error "Build failed - check build_results.log"
        VALIDATION_RESULTS+=("❌ Build: Failed")
        return 1
    fi
}

# Memory and performance profiling
run_profiling() {
    log_info "Running performance profiling..."
    
    # CPU profiling
    log_info "Running CPU profiling..."
    go test -cpuprofile=cpu.prof -bench=. ./... > profile_results.log 2>&1 || true
    
    # Memory profiling  
    log_info "Running memory profiling..."
    go test -memprofile=mem.prof -bench=. ./... >> profile_results.log 2>&1 || true
    
    log_success "Profiling data generated (cpu.prof, mem.prof)"
    VALIDATION_RESULTS+=("✅ Profiling: Data generated")
}

# Generate validation report
generate_report() {
    log_info "Generating validation report..."
    
    cat > validation_report.md << EOF
# Heimdall Go Implementation Validation Report

**Generated:** $(date)
**Go Version:** $(go version)

## Validation Summary

EOF

    for result in "${VALIDATION_RESULTS[@]}"; do
        echo "- $result" >> validation_report.md
    done
    
    cat >> validation_report.md << EOF

## Test Results

\`\`\`
$(cat test_results.log 2>/dev/null | tail -20 || echo "No test results available")
\`\`\`

## Performance Benchmarks

\`\`\`
$(cat benchmark_results.log 2>/dev/null | grep -E "Benchmark|ns/op|B/op" | head -20 || echo "No benchmark results available")
\`\`\`

## Files Generated

- test_results.log - Complete test execution log
- benchmark_results.log - Performance benchmark results  
- coverage.out - Coverage data
- coverage.html - HTML coverage report
- cpu.prof - CPU profiling data
- mem.prof - Memory profiling data
- validation_report.md - This report

## Next Steps

1. Review all generated logs and reports
2. Address any warnings or issues found
3. Run performance comparison with TypeScript baseline
4. Deploy to staging environment for integration testing
5. Update documentation and prepare migration guide

EOF

    log_success "Validation report generated: validation_report.md"
}

# Main execution
main() {
    log_info "🚀 Starting Heimdall Go Implementation Validation"
    log_info "=================================================="
    
    check_go_installation
    setup_go_module
    
    # Core validation steps
    verify_build || exit 1
    run_test_suite || exit 1
    analyze_coverage
    run_quality_checks
    run_profiling
    
    # Generate final report
    generate_report
    
    log_success "🎉 Validation completed!"
    log_info "Check validation_report.md for complete results"
    
    # Summary
    echo
    log_info "📊 VALIDATION SUMMARY"
    log_info "===================="
    for result in "${VALIDATION_RESULTS[@]}"; do
        echo "  $result"
    done
}

# Run main function
main "$@"