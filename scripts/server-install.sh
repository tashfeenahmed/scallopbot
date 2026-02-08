#!/usr/bin/env bash
#
# ScallopBot Server Installation Script
#
# Installs all dependencies for running ScallopBot on a fresh Ubuntu 24.04 server.
# Covers: Node.js 22, PM2, Python venv (voice), Ollama (embeddings), ffmpeg, sox.
#
# Usage:
#   curl -fsSL <raw-url>/scripts/server-install.sh | bash
#   # or
#   bash scripts/server-install.sh
#
# After running, configure .env and start with:
#   pm2 start ecosystem.config.cjs --env production

set -euo pipefail

APP_DIR="${APP_DIR:-$(pwd)}"
VENV_DIR="$HOME/.scallopbot/venv"
LOG_DIR="/var/log/scallopbot"

echo "==> ScallopBot Server Install"
echo "    App dir: $APP_DIR"
echo ""

# ── 1. System packages ──────────────────────────────────────────────
echo "==> Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  curl git build-essential \
  python3 python3-venv python3-pip \
  ffmpeg sox

# ── 2. Node.js 22 ───────────────────────────────────────────────────
if command -v node &>/dev/null && [[ "$(node -v)" == v22.* ]]; then
  echo "==> Node.js $(node -v) already installed"
else
  echo "==> Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    Node: $(node -v), npm: $(npm -v)"

# ── 3. PM2 ──────────────────────────────────────────────────────────
if command -v pm2 &>/dev/null; then
  echo "==> PM2 already installed ($(pm2 -v))"
else
  echo "==> Installing PM2..."
  npm install -g pm2
fi

# ── 4. Python venv for voice (Kokoro TTS + faster-whisper STT) ─────
echo "==> Setting up Python voice environment..."
mkdir -p "$(dirname "$VENV_DIR")"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install kokoro-onnx faster-whisper -q
echo "    Venv: $VENV_DIR"

# ── 5. Kokoro TTS model files ───────────────────────────────────────
KOKORO_CACHE="$HOME/.cache/kokoro"
if [ -f "$KOKORO_CACHE/kokoro-v1.0.onnx" ] && [ -f "$KOKORO_CACHE/voices-v1.0.bin" ]; then
  echo "==> Kokoro models already cached"
else
  echo "==> Downloading Kokoro TTS models..."
  mkdir -p "$KOKORO_CACHE"
  wget -q -O "$KOKORO_CACHE/kokoro-v1.0.onnx" \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
  wget -q -O "$KOKORO_CACHE/voices-v1.0.bin" \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
fi
echo "    Models: $KOKORO_CACHE"

# ── 6. Ollama (local embeddings) ────────────────────────────────────
if command -v ollama &>/dev/null; then
  echo "==> Ollama already installed"
else
  echo "==> Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Pull embedding model (start service first if needed)
systemctl start ollama 2>/dev/null || true
sleep 2
if ollama list 2>/dev/null | grep -q nomic-embed-text; then
  echo "==> nomic-embed-text model already pulled"
else
  echo "==> Pulling nomic-embed-text embedding model..."
  ollama pull nomic-embed-text
fi

# ── 7. App dependencies ─────────────────────────────────────────────
if [ -f "$APP_DIR/package.json" ]; then
  echo "==> Installing npm dependencies..."
  cd "$APP_DIR"
  npm install
  echo "==> Building..."
  npm run build
else
  echo "==> Skipping npm install (no package.json in $APP_DIR)"
fi

# ── 8. Log directory & PM2 startup ──────────────────────────────────
echo "==> Setting up log directory and PM2 startup..."
mkdir -p "$LOG_DIR"
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# ── 9. Summary ──────────────────────────────────────────────────────
echo ""
echo "==> Installation complete!"
echo ""
echo "    Node.js:        $(node -v)"
echo "    npm:            $(npm -v)"
echo "    PM2:            $(pm2 -v)"
echo "    Python venv:    $VENV_DIR"
echo "    Kokoro models:  $KOKORO_CACHE"
echo "    Ollama:         $(ollama -v 2>&1 | head -1)"
echo "    Embedding model: nomic-embed-text"
echo ""
echo "  Next steps:"
echo "    1. Copy .env.example to .env and configure API keys"
echo "    2. pm2 start ecosystem.config.cjs --env production"
echo "    3. pm2 save"
echo ""
