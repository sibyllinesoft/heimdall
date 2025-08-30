#!/bin/bash

# Heimdall Go Plugin Deployment Script
# Native Go implementation - no TypeScript dependencies

set -e

# Configuration
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="heimdall-bifrost-plugin"

echo "🚀 Heimdall Go Plugin Deployment"
echo "==============================="
echo "Plugin Directory: ${PLUGIN_DIR}"
echo "Plugin Name: ${PLUGIN_NAME}"
echo ""

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command_exists go; then
    echo "❌ Go is not installed"
    echo "Run: ./install-go.sh to install Go"
    exit 1
fi

echo "✅ Go $(go version | cut -d' ' -f3) detected"

# Build the plugin
echo ""
echo "🔨 Building Go plugin..."
cd "${PLUGIN_DIR}"

# Install dependencies
echo "Installing Go dependencies..."
go mod tidy
go mod download

# Run tests
echo "Running tests..."
go test -v -race ./...

# Build the plugin
echo "Building plugin binary..."
go build -o "${PLUGIN_NAME}" .

if [ -f "${PLUGIN_NAME}" ]; then
    echo "✅ Plugin built successfully: ${PLUGIN_NAME}"
    chmod +x "${PLUGIN_NAME}"
else
    echo "❌ Plugin build failed"
    exit 1
fi

# Show plugin info
echo ""
echo "📊 Plugin Information:"
echo "  • Binary: ${PLUGIN_DIR}/${PLUGIN_NAME}"
echo "  • Size: $(ls -lh ${PLUGIN_NAME} | awk '{print $5}')"
echo "  • Type: Native Go implementation"
echo ""

echo "✅ Deployment completed successfully!"
echo ""
echo "🎯 Usage:"
echo "  • Import the plugin in your Bifrost configuration"
echo "  • Configure with appropriate settings (see README.md)"
echo "  • Plugin provides native Go performance with full routing capabilities"
echo ""
echo "📚 Documentation:"
echo "  • README.md - Usage and configuration guide"
echo "  • PLUGIN_SUMMARY.md - Technical overview"
echo "  • PRODUCTION_READINESS_REPORT.md - Production readiness details"