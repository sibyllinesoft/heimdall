#!/bin/bash
# Go Installation and Validation Script for Heimdall
# Generated on: 2025-08-28
# Review this script before execution

set -euo pipefail  # Exit on any error

echo "🔍 Checking system requirements..."
# Check if we're on Ubuntu/Debian
if ! command -v apt >/dev/null 2>&1; then
    echo "❌ This script requires apt package manager (Ubuntu/Debian)"
    exit 1
fi

# Check architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64)
        GO_ARCH="amd64"
        ;;
    aarch64)
        GO_ARCH="arm64"
        ;;
    *)
        echo "❌ Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

echo "✅ System: $(lsb_release -d | cut -f2-), Architecture: $ARCH"

echo "📦 Installing Go 1.21..."
# Download and install Go
GO_VERSION="1.21.5"
GO_TARBALL="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
DOWNLOAD_URL="https://golang.org/dl/${GO_TARBALL}"

# Create temporary directory
TMP_DIR=$(mktemp -d)
cd "$TMP_DIR"

# Download Go
echo "⬇️  Downloading Go from $DOWNLOAD_URL"
wget -q "$DOWNLOAD_URL" || curl -sL "$DOWNLOAD_URL" -o "$GO_TARBALL"

# Verify download
if [ ! -f "$GO_TARBALL" ]; then
    echo "❌ Failed to download Go"
    exit 1
fi

# Remove existing Go installation (if any)
sudo rm -rf /usr/local/go

# Extract and install
echo "📁 Installing Go to /usr/local/go"
sudo tar -C /usr/local -xzf "$GO_TARBALL"

# Update PATH for current session
export PATH=$PATH:/usr/local/go/bin

# Add to bashrc for persistence
if ! grep -q "/usr/local/go/bin" ~/.bashrc; then
    echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
fi

# Clean up
cd /
rm -rf "$TMP_DIR"

echo "✅ Verifying Go installation..."
/usr/local/go/bin/go version

echo "🔧 Setting up Go workspace..."
# Initialize go module if not exists
cd /home/nathan/Projects/heimdall/plugins/heimdall
if [ ! -f "go.mod" ]; then
    /usr/local/go/bin/go mod init github.com/yourorg/heimdall
fi

echo "📋 Installing Go development tools..."
/usr/local/go/bin/go install golang.org/x/tools/cmd/goimports@latest
/usr/local/go/bin/go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
/usr/local/go/bin/go install github.com/securecodewarrior/gosec/v2/cmd/gosec@latest

echo "🎉 Go installation complete!"
echo ""
echo "Next steps:"
echo "1. Source your bashrc: source ~/.bashrc"
echo "2. Or start a new terminal session"
echo "3. Run: go version"
echo "4. Navigate to project directory and run: go mod tidy"