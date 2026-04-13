#!/bin/sh
set -eu

# cc-ping installer
# Usage: curl -fsSL https://raw.githubusercontent.com/wbern/cc-ping/main/install.sh | bash
# Pin version: curl -fsSL ... | bash -s -- v1.15.0

REPO="wbern/cc-ping"
INSTALL_DIR="${CC_PING_INSTALL_DIR:-$HOME/.local/bin}"

# Colors (only if terminal)
if [ -t 1 ]; then
  BOLD="\033[1m"
  GREEN="\033[32m"
  RED="\033[31m"
  RESET="\033[0m"
else
  BOLD="" GREEN="" RED="" RESET=""
fi

info() { printf "${GREEN}info${RESET}: %s\n" "$1"; }
error() { printf "${RED}error${RESET}: %s\n" "$1" >&2; exit 1; }

# Parse args
VERSION="${1:-latest}"

# Detect platform
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)      error "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64)        arch="x64" ;;
  *)             error "Unsupported architecture: $ARCH" ;;
esac

TARGET="${os}-${arch}"

# Only support known combinations
case "$TARGET" in
  darwin-arm64|darwin-x64|linux-x64) ;;
  *) error "No pre-built binary for ${TARGET}. Install via npm: npm install -g @wbern/cc-ping" ;;
esac

info "Detected platform: ${TARGET}"

# Resolve download URL
if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi

BINARY_URL="${BASE_URL}/cc-ping-${TARGET}"
CHECKSUMS_URL="${BASE_URL}/checksums.txt"

# Create temp directory
TMPDIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'cc-ping')
trap 'rm -rf "$TMPDIR"' EXIT

# Download binary
info "Downloading cc-ping-${TARGET}..."
if ! curl -fSL --progress-bar -o "${TMPDIR}/cc-ping" "$BINARY_URL"; then
  error "Download failed. Check that the version exists: https://github.com/${REPO}/releases"
fi

# Verify checksum
info "Verifying checksum..."
if curl -fsSL -o "${TMPDIR}/checksums.txt" "$CHECKSUMS_URL" 2>/dev/null; then
  EXPECTED=$(grep "cc-ping-${TARGET}$" "${TMPDIR}/checksums.txt" | cut -d ' ' -f 1)
  if [ -n "$EXPECTED" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "${TMPDIR}/cc-ping" | cut -d ' ' -f 1)
    else
      ACTUAL=$(shasum -a 256 "${TMPDIR}/cc-ping" | cut -d ' ' -f 1)
    fi
    if [ "$ACTUAL" != "$EXPECTED" ]; then
      error "Checksum mismatch! Expected: ${EXPECTED}, got: ${ACTUAL}"
    fi
    info "Checksum verified"
  else
    info "No checksum found for ${TARGET}, skipping verification"
  fi
else
  info "Checksums not available, skipping verification"
fi

# Clear macOS quarantine
if [ "$os" = "darwin" ]; then
  xattr -c "${TMPDIR}/cc-ping" 2>/dev/null || true
fi

# Install
mkdir -p "$INSTALL_DIR"
chmod +x "${TMPDIR}/cc-ping"
mv "${TMPDIR}/cc-ping" "${INSTALL_DIR}/cc-ping"

info "Installed to ${INSTALL_DIR}/cc-ping"

# Add to PATH if needed
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  SHELL_NAME=$(basename "$SHELL")
  EXPORT_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""

  add_to_rc() {
    RC_FILE="$1"
    if [ -f "$RC_FILE" ] && grep -qF "$INSTALL_DIR" "$RC_FILE"; then
      return
    fi
    printf '\n# cc-ping\n%s\n' "$EXPORT_LINE" >> "$RC_FILE"
    info "Added ${INSTALL_DIR} to PATH in ${RC_FILE}"
  }

  case "$SHELL_NAME" in
    zsh)  add_to_rc "$HOME/.zshrc" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        add_to_rc "$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then
        add_to_rc "$HOME/.bash_profile"
      fi
      ;;
    fish)
      FISH_CONFIG="$HOME/.config/fish/config.fish"
      if [ -f "$FISH_CONFIG" ] && ! grep -qF "$INSTALL_DIR" "$FISH_CONFIG"; then
        printf '\n# cc-ping\nfish_add_path %s\n' "$INSTALL_DIR" >> "$FISH_CONFIG"
        info "Added ${INSTALL_DIR} to PATH in ${FISH_CONFIG}"
      fi
      ;;
  esac

  info "Restart your shell or run: ${EXPORT_LINE}"
fi

# Print version
INSTALLED_VERSION=$("${INSTALL_DIR}/cc-ping" --version 2>/dev/null || echo "unknown")
printf "\n${BOLD}cc-ping ${INSTALLED_VERSION}${RESET} installed successfully!\n"
printf "Run ${BOLD}cc-ping --help${RESET} to get started.\n"
