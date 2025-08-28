#!/bin/bash
# Go Installation Script for Phase 2 Testing
# This script installs Go 1.21+ for running the router execution tests

set -euo pipefail

echo "🔍 Installing Go for Heimdall router testing..."

# Create installation directory
sudo mkdir -p /usr/local

# Download and install Go 1.21
GO_VERSION="1.21.5"
GO_ARCHIVE="go${GO_VERSION}.linux-amd64.tar.gz"

echo "📦 Downloading Go ${GO_VERSION}..."
cd /tmp
wget "https://golang.org/dl/${GO_ARCHIVE}"

echo "🔧 Installing Go to /usr/local..."
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf "${GO_ARCHIVE}"

echo "🎯 Setting up Go environment..."
# Add Go to PATH for current session
export PATH="/usr/local/go/bin:$PATH"

# Add Go to permanent PATH
if ! grep -q "/usr/local/go/bin" ~/.bashrc; then
    echo 'export PATH="/usr/local/go/bin:$PATH"' >> ~/.bashrc
fi

echo "✅ Go installation complete!"
echo "🔍 Verifying installation..."

# Verify Go installation
/usr/local/go/bin/go version

echo "🚀 Go is ready for Heimdall router testing!"
echo "📋 Run 'source ~/.bashrc' or restart your terminal to use 'go' command directly"
echo "⚡ Current session: use '/usr/local/go/bin/go' for immediate testing"

echo "🎉 Installation complete! You can now run:"
echo "    cd /home/nathan/Projects/heimdall/plugins/heimdall"
echo "    /usr/local/go/bin/go test -v ./... -run TestRouterExecutorCore"