# Heimdall Bifrost Plugin Makefile

.PHONY: all build test test-unit test-integration clean deps help

# Default target
all: deps test build

# Build the plugin
build:
	@echo "Building Heimdall Bifrost plugin..."
	go build -o heimdall-plugin .
	@echo "Plugin built successfully: heimdall-plugin"

# Build as a shared library plugin
plugin:
	@echo "Building plugin as shared library..."
	go build -buildmode=plugin -o heimdall.so .
	@echo "Plugin library built: heimdall.so"

# Install dependencies
deps:
	@echo "Installing Go dependencies..."
	go mod tidy
	go mod download

# Run unit tests
test-unit:
	@echo "Running unit tests..."
	go test -v -race

# Run integration tests (Go implementation only)
test-integration:
	@echo "Running integration tests..."
	go test -v -race -tags=integration

# Run all tests
test: test-unit test-integration

# Run benchmarks
benchmark:
	@echo "Running benchmarks..."
	go test -v -bench=. -benchmem

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -f heimdall-plugin heimdall.so
	go clean -cache -testcache

# Start the Go plugin service for testing
start-router:
	@echo "Starting Go plugin service..."
	go run . &

# Show plugin metrics
metrics:
	@echo "Showing plugin metrics..."
	@echo "Plugin built as Go native implementation - metrics available via GetMetrics() method"

# Example usage
example:
	@echo "Running example usage..."
	go run . --example

# Format code
fmt:
	@echo "Formatting Go code..."
	go fmt ./...
	goimports -w .

# Lint code
lint:
	@echo "Linting Go code..."
	golangci-lint run

# Check for security issues
security:
	@echo "Running security checks..."
	gosec ./...

# Run code coverage
coverage:
	@echo "Running test coverage..."
	go test -v -race -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Install development tools
install-tools:
	@echo "Installing development tools..."
	go install golang.org/x/tools/cmd/goimports@latest
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	go install github.com/securecodewarrior/gosec/v2/cmd/gosec@latest

# Run full CI pipeline
ci: deps fmt lint security test coverage

# Development setup
dev-setup: install-tools deps
	@echo "Development environment ready!"

# Docker build (future)
docker-build:
	@echo "Building Docker image..."
	docker build -t heimdall-plugin .

# Show help
help:
	@echo "Heimdall Bifrost Plugin - Available targets:"
	@echo ""
	@echo "  Build targets:"
	@echo "    build          - Build the plugin binary"
	@echo "    plugin         - Build as shared library plugin"
	@echo "    deps           - Install Go dependencies"
	@echo ""
	@echo "  Test targets:"
	@echo "    test           - Run all tests"
	@echo "    test-unit      - Run unit tests only"
	@echo "    test-integration - Run integration tests only"
	@echo "    benchmark      - Run performance benchmarks"
	@echo "    coverage       - Generate test coverage report"
	@echo ""
	@echo "  Development targets:"
	@echo "    fmt            - Format Go code"
	@echo "    lint           - Lint Go code"
	@echo "    security       - Run security checks"
	@echo "    install-tools  - Install development tools"
	@echo "    dev-setup      - Complete development setup"
	@echo ""
	@echo "  Service targets:"
	@echo "    start-router   - Start TypeScript router service"
	@echo "    health         - Check router service health"
	@echo "    test-router    - Test router service directly"
	@echo ""
	@echo "  Utility targets:"
	@echo "    clean          - Clean build artifacts"
	@echo "    ci             - Run full CI pipeline"
	@echo "    help           - Show this help message"
	@echo ""
	@echo "Examples:"
	@echo "  make dev-setup  # First time setup"
	@echo "  make test       # Run all tests"
	@echo "  make build      # Build the plugin"