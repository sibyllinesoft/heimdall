#!/bin/bash

# Heimdall Bifrost Plugin Deployment Script
# This script helps deploy and test the plugin integration

set -e

# Configuration
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${PLUGIN_DIR}/../.." && pwd)"
ROUTER_PORT="${ROUTER_PORT:-3000}"
PLUGIN_MODE="${PLUGIN_MODE:-http}"

echo "🚀 Heimdall Bifrost Plugin Deployment"
echo "======================================"
echo "Plugin Directory: ${PLUGIN_DIR}"
echo "Project Root: ${PROJECT_ROOT}"
echo "Router Port: ${ROUTER_PORT}"
echo "Plugin Mode: ${PLUGIN_MODE}"
echo ""

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to wait for service
wait_for_service() {
    local url=$1
    local timeout=${2:-30}
    local count=0
    
    echo "Waiting for service at ${url}..."
    
    while [ $count -lt $timeout ]; do
        if curl -s "${url}" >/dev/null 2>&1; then
            echo "✅ Service is ready!"
            return 0
        fi
        
        sleep 1
        count=$((count + 1))
        echo -n "."
    done
    
    echo ""
    echo "❌ Service not ready after ${timeout} seconds"
    return 1
}

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command_exists node; then
    echo "❌ Node.js is not installed"
    exit 1
fi

if ! command_exists npm; then
    echo "❌ npm is not installed"
    exit 1
fi

if command_exists go; then
    echo "✅ Go is available"
    HAS_GO=true
else
    echo "⚠️  Go is not installed (plugin compilation will be skipped)"
    HAS_GO=false
fi

if ! command_exists curl; then
    echo "❌ curl is not available for testing"
    exit 1
fi

echo ""

# Install Node.js dependencies
echo "📦 Installing Node.js dependencies..."
cd "${PROJECT_ROOT}"

if [ ! -d "node_modules" ]; then
    npm install
else
    echo "Dependencies already installed"
fi

# Build TypeScript project
echo "🔨 Building TypeScript project..."
npm run build

echo ""

# Build Go plugin if Go is available
if [ "$HAS_GO" = true ]; then
    echo "🔨 Building Go plugin..."
    cd "${PLUGIN_DIR}"
    
    go mod tidy
    go build -o heimdall-plugin .
    
    echo "✅ Go plugin built successfully"
    echo ""
else
    echo "⚠️  Skipping Go plugin build (Go not available)"
    echo ""
fi

# Start TypeScript router service
echo "🚀 Starting TypeScript router service..."
cd "${PLUGIN_DIR}"

# Kill any existing process on the port
if lsof -ti:${ROUTER_PORT} >/dev/null 2>&1; then
    echo "Killing existing process on port ${ROUTER_PORT}..."
    kill -9 $(lsof -ti:${ROUTER_PORT}) || true
    sleep 2
fi

# Start the router service in background
echo "Starting router service on port ${ROUTER_PORT}..."
nohup npx tsx router_service.ts > router_service.log 2>&1 &
ROUTER_PID=$!

echo "Router service started with PID: ${ROUTER_PID}"
echo "Log file: ${PLUGIN_DIR}/router_service.log"

# Wait for service to be ready
if ! wait_for_service "http://localhost:${ROUTER_PORT}/health" 30; then
    echo "❌ Failed to start router service"
    kill $ROUTER_PID 2>/dev/null || true
    exit 1
fi

echo ""

# Test the service
echo "🧪 Testing router service..."

# Health check
echo "Testing health endpoint..."
if health_response=$(curl -s "http://localhost:${ROUTER_PORT}/health"); then
    echo "✅ Health check passed"
    echo "Response: ${health_response}" | head -c 200
    echo ""
else
    echo "❌ Health check failed"
fi

echo ""

# Test decision endpoint
echo "Testing decision endpoint..."
decision_request='{
    "url": "/v1/chat/completions",
    "method": "POST",
    "headers": {
        "content-type": "application/json"
    },
    "body": {
        "messages": [
            {
                "role": "user",
                "content": "Write a hello world program in Python"
            }
        ],
        "model": "gpt-4",
        "stream": false
    }
}'

if decision_response=$(curl -s -X POST "http://localhost:${ROUTER_PORT}/decide" \
    -H "Content-Type: application/json" \
    -d "${decision_request}"); then
    echo "✅ Decision endpoint test passed"
    echo "Response preview:"
    echo "${decision_response}" | jq -r '.decision.kind + "/" + .decision.model + " (bucket: " + .bucket + ")"' 2>/dev/null || echo "${decision_response}" | head -c 200
else
    echo "❌ Decision endpoint test failed"
fi

echo ""

# Run Go tests if available
if [ "$HAS_GO" = true ]; then
    echo "🧪 Running Go plugin tests..."
    cd "${PLUGIN_DIR}"
    
    # Run unit tests
    echo "Running unit tests..."
    if go test -v .; then
        echo "✅ Unit tests passed"
    else
        echo "❌ Unit tests failed"
    fi
    
    echo ""
    
    # Run integration tests
    echo "Running integration tests..."
    if go test -v -tags=integration .; then
        echo "✅ Integration tests passed"
    else
        echo "❌ Integration tests failed"
    fi
else
    echo "⚠️  Skipping Go tests (Go not available)"
fi

echo ""

# Display service information
echo "📊 Service Information"
echo "===================="
echo "Router Service URL: http://localhost:${ROUTER_PORT}"
echo "Health Check: http://localhost:${ROUTER_PORT}/health"
echo "Decision Endpoint: http://localhost:${ROUTER_PORT}/decide"
echo "Metrics: http://localhost:${ROUTER_PORT}/metrics"
echo "Process ID: ${ROUTER_PID}"
echo "Log File: ${PLUGIN_DIR}/router_service.log"
echo ""

# Show example Bifrost configuration
echo "📖 Example Bifrost Configuration"
echo "================================"
cat << 'EOF'
// Go SDK Integration
config := map[string]interface{}{
    "mode":       "http",
    "router_url": "http://localhost:3000",
    "timeout":    "25ms",
    "enable_caching": true,
    "cache_ttl":      "5m",
}

heimdallPlugin, err := heimdall.New(config)
if err != nil {
    log.Fatal("Failed to create Heimdall plugin:", err)
}

client, err := bifrost.Init(schemas.BifrostConfig{
    Account: yourAccount,
    Plugins: []schemas.Plugin{heimdallPlugin},
})

// HTTP Gateway Integration
export APP_PLUGINS="maxim,heimdall"
export HEIMDALL_MODE="http"
export HEIMDALL_ROUTER_URL="http://localhost:3000"
bifrost-http -plugins "maxim,heimdall" -port 8080
EOF

echo ""

# Final instructions
echo "🎉 Deployment Complete!"
echo "======================="
echo ""
echo "The Heimdall Bifrost plugin is ready for use!"
echo ""
echo "Next steps:"
echo "1. Test the service endpoints manually"
echo "2. Integrate the plugin into your Bifrost application"
echo "3. Monitor the router_service.log for any issues"
echo "4. Stop the service when done: kill ${ROUTER_PID}"
echo ""
echo "To stop all services:"
echo "  kill ${ROUTER_PID}"
echo "  rm -f router_service.log"
echo ""
echo "For more information, see the README.md file."

# Keep service running if requested
if [ "${KEEP_RUNNING}" = "true" ]; then
    echo "Service will keep running in background..."
    echo "Monitor with: tail -f ${PLUGIN_DIR}/router_service.log"
else
    echo ""
    echo "Press Ctrl+C to stop the service or run:"
    echo "  kill ${ROUTER_PID}"
    
    # Wait for user interrupt
    trap "echo; echo 'Stopping services...'; kill $ROUTER_PID 2>/dev/null || true; exit 0" INT
    wait $ROUTER_PID 2>/dev/null || true
fi