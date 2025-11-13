#!/bin/bash
# Wrapper script to handle python/python3 for electron-builder

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Create a temporary symlink if python doesn't exist
if ! command -v python &> /dev/null 2>&1; then
  if command -v python3 &> /dev/null 2>&1; then
    # Create a temporary symlink in a local directory
    mkdir -p "$PROJECT_DIR/.tmp"
    ln -sf "$(which python3)" "$PROJECT_DIR/.tmp/python"
    export PATH="$PROJECT_DIR/.tmp:$PATH"
  fi
fi

# Change to project directory and run electron-builder
cd "$PROJECT_DIR"
exec electron-builder "$@"

