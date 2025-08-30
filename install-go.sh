#!/bin/bash
# Go Installation Script for Heimdall Plugin Development
# Generated on: 2025-01-28
# Review this script before execution

set -euo pipefail  # Exit on any error

echo "🔍 Checking system requirements..."
# Check if we're on a supported architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64) GO_ARCH="amd64" ;;
    aarch64) GO_ARCH="arm64" ;;
    *) echo "❌ Unsupported architecture: $ARCH"; exit 1 ;;
esac

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
echo "✅ Detected: $OS/$GO_ARCH"

# Set Go version to install
GO_VERSION="1.21.5"
GO_TARBALL="go${GO_VERSION}.${OS}-${GO_ARCH}.tar.gz"
GO_URL="https://golang.org/dl/${GO_TARBALL}"

echo "📦 Installing Go ${GO_VERSION}..."

# Download Go
echo "⬇️  Downloading Go from $GO_URL"
cd /tmp
curl -LO "$GO_URL"

# Verify download
if [[ ! -f "$GO_TARBALL" ]]; then
    echo "❌ Failed to download Go tarball"
    exit 1
fi

# Remove existing Go installation if it exists
if [[ -d "/usr/local/go" ]]; then
    echo "🗑️  Removing existing Go installation..."
    sudo rm -rf /usr/local/go
fi

# Extract Go
echo "📂 Extracting Go to /usr/local..."
sudo tar -C /usr/local -xzf "$GO_TARBALL"

# Add Go to PATH in user's profile
GO_BIN_PATH="/usr/local/go/bin"
PROFILE_FILE="$HOME/.bashrc"

if ! grep -q "$GO_BIN_PATH" "$PROFILE_FILE" 2>/dev/null; then
    echo "🔧 Adding Go to PATH in $PROFILE_FILE"
    echo "" >> "$PROFILE_FILE"
    echo "# Go programming language" >> "$PROFILE_FILE"
    echo "export PATH=\$PATH:$GO_BIN_PATH" >> "$PROFILE_FILE"
    echo "export GOPATH=\$HOME/go" >> "$PROFILE_FILE"
    echo "export GO111MODULE=on" >> "$PROFILE_FILE"
fi

# Clean up
rm -f "$GO_TARBALL"

echo "✅ Verifying installation..."
# Test Go installation (need to source the profile first)
export PATH=$PATH:$GO_BIN_PATH
if "$GO_BIN_PATH/go" version; then
    echo "🎉 Go installation complete!"
    echo ""
    echo "📋 Next steps:"
    echo "1. Either restart your terminal or run: source ~/.bashrc"
    echo "2. Verify with: go version"
    echo "3. Navigate to your project: cd /home/nathan/Projects/heimdall/plugins/heimdall"
    echo "4. Run: go mod tidy && go test -v"
else
    echo "❌ Go installation failed - binary not working"
    exit 1
fi

echo ""
echo "🏗️  Go is now ready for Heimdall plugin development!"