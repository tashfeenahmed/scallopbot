#!/usr/bin/env bash
#
# ScallopBot installer for Linux and macOS (incl. Raspberry Pi OS 64-bit).
#
#   curl -fsSL https://raw.githubusercontent.com/tashfeenahmed/scallopbot/main/scripts/install.sh | bash
#
# Options (pass after `bash -s --` when piping, e.g. `| bash -s -- --docker`):
#   --dir <path>        Install directory (default: ~/scallopbot, env SCALLOPBOT_DIR)
#   --branch <name>     Git branch to install (default: main, env SCALLOPBOT_BRANCH)
#   --repo <url>        Git repository (default: GitHub, env SCALLOPBOT_REPO)
#   --docker            Only fetch docker-compose.yml + .env into --dir; no Node needed
#   --service <kind>    pm2 | systemd | none   (default: ask; none when non-interactive)
#   --reconfigure       Re-run onboarding even if .env already exists
#   --non-interactive   Never prompt; read answers from the environment (below)
#   --dry-run           Print what would happen without changing anything
#
# Environment-driven onboarding (used as defaults, and as the answers with
# --non-interactive): ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
# GROQ_API_KEY, MOONSHOT_API_KEY, XAI_API_KEY, TELEGRAM_BOT_TOKEN,
# TELEGRAM_ALLOWED_USERS, SCALLOPBOT_WEB_EMAIL, SCALLOPBOT_WEB_PASSWORD.
#
# Safe to re-run: it updates the checkout, rebuilds, and keeps an existing .env.
# It never uses sudo on its own; when something needs root it prints the
# command for you to run instead.

set -euo pipefail

REPO="${SCALLOPBOT_REPO:-https://github.com/tashfeenahmed/scallopbot.git}"
BRANCH="${SCALLOPBOT_BRANCH:-main}"
DIR="${SCALLOPBOT_DIR:-$HOME/scallopbot}"
RAW_BASE="${SCALLOPBOT_RAW_BASE:-https://raw.githubusercontent.com/tashfeenahmed/scallopbot}"
NODE_MAJOR=24
MODE=native
SERVICE=""
RECONFIGURE=0
INTERACTIVE=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --docker) MODE=docker; shift ;;
    --service) SERVICE="$2"; shift 2 ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --non-interactive|-y) INTERACTIVE=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,26p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# Prompts read from the terminal even when this script arrives on stdin (curl | bash).
if [ "$INTERACTIVE" = 1 ] && ! { [ -r /dev/tty ] && : < /dev/tty; } 2>/dev/null; then
  INTERACTIVE=0
fi

# ── helpers ──────────────────────────────────────────────────────────────────
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# ask VAR "Question" "default" [secret]
ask() {
  local __var="$1" __q="$2" __def="${3:-}" __secret="${4:-}" __ans=""
  if [ "$INTERACTIVE" = 1 ]; then
    if [ -n "$__secret" ]; then
      printf '%s%s: ' "$__q" "${__def:+ [keep current]}" > /dev/tty
      IFS= read -rs __ans < /dev/tty || true
      printf '\n' > /dev/tty
    else
      printf '%s%s: ' "$__q" "${__def:+ [$__def]}" > /dev/tty
      IFS= read -r __ans < /dev/tty || true
    fi
  fi
  [ -z "$__ans" ] && __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}

yes_no() { # yes_no "Question" default(y|n)
  local ans
  ask ans "$1 (y/n)" "$2"
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# set_env FILE KEY VALUE — replace `KEY=` or `# KEY=` in place, else append.
set_env() {
  local file="$1" key="$2" value="$3" tmp
  if [ "$DRY_RUN" = 1 ]; then note "[dry-run] set $key in $file"; return; fi
  tmp="$(mktemp)"
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    !done && ($0 ~ "^" k "=" || $0 ~ "^# *" k "=") { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp" && cat "$tmp" > "$file" && rm -f "$tmp"
}

# unset_env FILE KEY — comment out an active `KEY=` line (e.g. .env.example placeholders).
unset_env() {
  local file="$1" key="$2" tmp
  if [ "$DRY_RUN" = 1 ]; then note "[dry-run] comment out $key in $file"; return; fi
  tmp="$(mktemp)"
  KEY="$key" awk '
    BEGIN { k = ENVIRON["KEY"] }
    $0 ~ "^" k "=" { print "# " $0; next }
    { print }
  ' "$file" > "$tmp" && cat "$tmp" > "$file" && rm -f "$tmp"
}

# ── onboarding: writes .env from .env.example ────────────────────────────────
WEB_EMAIL="${SCALLOPBOT_WEB_EMAIL:-}"
WEB_PASSWORD="${SCALLOPBOT_WEB_PASSWORD:-}"

onboard() {
  local envfile="$1" workspace="$2"
  local provider="" key_var="" key="" tg="" tg_users=""

  # Pick a provider: the first key already exported wins as the default.
  for p in anthropic openrouter openai groq moonshot xai; do
    key_var="$(printf '%s' "$p" | tr '[:lower:]' '[:upper:]')_API_KEY"
    if [ -n "${!key_var:-}" ]; then provider="$p"; break; fi
  done
  say "Onboarding (answers go to $envfile)"
  ask provider "LLM provider: anthropic, openrouter, openai, groq, moonshot or xai" "${provider:-anthropic}"
  case "$provider" in
    anthropic|openrouter|openai|groq|moonshot|xai) ;;
    *) die "Unknown provider '$provider'" ;;
  esac
  key_var="$(printf '%s' "$provider" | tr '[:lower:]' '[:upper:]')_API_KEY"
  key="${!key_var:-}"
  ask key "$key_var" "$key" secret
  [ -n "$key" ] || die "$key_var is required (export it or run interactively)."

  tg="${TELEGRAM_BOT_TOKEN:-}"
  ask tg "Telegram bot token from @BotFather (optional, Enter to skip)" "$tg" secret
  if [ -n "$tg" ]; then
    tg_users="${TELEGRAM_ALLOWED_USERS:-}"
    ask tg_users "Allowed Telegram user IDs, comma-separated (strongly recommended)" "$tg_users"
  fi

  ask WEB_EMAIL "Web dashboard login email (optional; Enter to set it in the browser later)" "$WEB_EMAIL"
  if [ -n "$WEB_EMAIL" ]; then
    ask WEB_PASSWORD "Web dashboard password (min 8 chars)" "$WEB_PASSWORD" secret
    if [ "${#WEB_PASSWORD}" -lt 8 ]; then
      warn "Password shorter than 8 characters; skipping. The first browser visit will ask for one."
      WEB_EMAIL=""; WEB_PASSWORD=""
    fi
  fi

  run cp "$envfile.example" "$envfile"
  [ "$DRY_RUN" = 1 ] || chmod 600 "$envfile"
  # .env.example ships placeholder values that would otherwise look like real
  # credentials (e.g. a bogus Telegram token makes startup fail).
  for v in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GROQ_API_KEY MOONSHOT_API_KEY XAI_API_KEY TELEGRAM_BOT_TOKEN; do
    unset_env "$envfile" "$v"
  done
  set_env "$envfile" "$key_var" "$key"
  if [ "$provider" != anthropic ]; then set_env "$envfile" MODEL "$provider"; fi
  if [ -n "$tg" ]; then
    set_env "$envfile" TELEGRAM_BOT_TOKEN "$tg"
    set_env "$envfile" TELEGRAM_ALLOWED_USERS "$tg_users"
  fi
  set_env "$envfile" AGENT_WORKSPACE "$workspace"
  set_env "$envfile" WEB_UI_ENABLED true
  note "Wrote $envfile (mode 600). Edit it any time; see .env.example for every option."
}

# ── Docker mode: compose file + .env only ────────────────────────────────────
if [ "$MODE" = docker ]; then
  say "Docker install into $DIR"
  have curl || die "curl is required."
  run mkdir -p "$DIR"
  run curl -fsSL "$RAW_BASE/$BRANCH/docker-compose.yml" -o "$DIR/docker-compose.yml"
  run curl -fsSL "$RAW_BASE/$BRANCH/.env.example" -o "$DIR/.env.example"
  # No published image yet: build straight from the git repository.
  if [ "$DRY_RUN" = 0 ]; then
    REMOTE_CTX="${REPO%.git}.git#$BRANCH"
    REMOTE_CTX="$REMOTE_CTX" awk '{ sub(/^    build: \.$/, "    build: " ENVIRON["REMOTE_CTX"]); print }' \
      "$DIR/docker-compose.yml" > "$DIR/docker-compose.yml.tmp"
    mv "$DIR/docker-compose.yml.tmp" "$DIR/docker-compose.yml"
  fi
  if [ ! -f "$DIR/.env" ] || [ "$RECONFIGURE" = 1 ]; then
    onboard "$DIR/.env" /data/workspace
  else
    note "Keeping existing $DIR/.env (use --reconfigure to redo onboarding)."
  fi
  if have docker && docker compose version >/dev/null 2>&1; then
    if yes_no "Build and start the container now?" y; then
      run docker compose -f "$DIR/docker-compose.yml" up -d --build
      if [ -n "$WEB_EMAIL" ] && [ "$DRY_RUN" = 0 ]; then
        printf '%s\n' "$WEB_PASSWORD" | docker compose -f "$DIR/docker-compose.yml" exec -T scallopbot node dist/cli.js web-login --email "$WEB_EMAIL" \
          || warn "Could not create the dashboard login; the first browser visit will ask for one."
      fi
    fi
  else
    warn "Docker with the compose plugin was not found. Install Docker, then run: cd $DIR && docker compose up -d --build"
  fi
  say "Done. Dashboard: http://localhost:3000  (logs: cd $DIR && docker compose logs -f)"
  exit 0
fi

# ── Native mode ──────────────────────────────────────────────────────────────
say "ScallopBot install into $DIR (branch $BRANCH)"
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "Unsupported OS $(uname -s). Use Docker (--docker) or install from source." ;;
esac
have git || die "git is required. Install it first (e.g. 'sudo apt-get install -y git' or 'xcode-select --install')."
have curl || die "curl is required."

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node() {
  if have node && [ "$(node_major)" -ge "$NODE_MAJOR" ]; then
    note "Node $(node -v) found."
    return
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    say "Installing nvm (user-level, no sudo) to get Node $NODE_MAJOR"
    note "Prefer a system package? Cancel and run NodeSource yourself:"
    note "  curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | sudo -E bash - && sudo apt-get install -y nodejs"
    if [ "$DRY_RUN" = 1 ]; then
      note "[dry-run] curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
    else
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
    fi
  fi
  if [ "$DRY_RUN" = 1 ]; then note "[dry-run] nvm install $NODE_MAJOR"; return; fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR"
  nvm alias default "$NODE_MAJOR" >/dev/null
  note "Node $(node -v) via nvm. Add nvm to your shell profile if it is not there yet (see https://github.com/nvm-sh/nvm)."
}

ensure_node

if [ -d "$DIR/.git" ]; then
  say "Updating existing checkout"
  # The build regenerates the committed dashboard bundle (public/) and may touch
  # web/package-lock.json; those are build output, not local edits.
  run git -C "$DIR" checkout --quiet -- public web/package-lock.json
  run git -C "$DIR" clean -fdq -- public
  if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    die "$DIR has local changes to tracked files. Commit or stash them, then re-run."
  fi
  run git -C "$DIR" fetch --quiet origin "$BRANCH"
  run git -C "$DIR" checkout --quiet "$BRANCH"
  run git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not a ScallopBot checkout. Pick another --dir."
else
  say "Cloning $REPO"
  run git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi

say "Installing dependencies and building (a few minutes on a Raspberry Pi)"
if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] (cd $DIR && npm ci && npm run build)"
else
  (cd "$DIR" && npm ci --no-audit --no-fund && npm run build)
fi

if [ ! -f "$DIR/.env" ] || [ "$RECONFIGURE" = 1 ]; then
  onboard "$DIR/.env" "$DIR/workspace"
  run mkdir -p "$DIR/workspace"
else
  note "Keeping existing $DIR/.env (use --reconfigure to redo onboarding)."
fi

if [ -n "$WEB_EMAIL" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] node dist/cli.js web-login --email $WEB_EMAIL"
  else
    printf '%s\n' "$WEB_PASSWORD" | (cd "$DIR" && node dist/cli.js web-login --email "$WEB_EMAIL") \
      || warn "Could not create the dashboard login; the first browser visit will ask for one."
  fi
fi

# ── optional service ─────────────────────────────────────────────────────────
if [ -z "$SERVICE" ]; then
  SERVICE=none
  # Re-runs restart whatever an earlier run installed.
  if have pm2 && pm2 describe scallopbot >/dev/null 2>&1; then
    SERVICE=pm2
  elif [ -f "$HOME/.config/systemd/user/scallopbot.service" ]; then
    SERVICE=systemd
  elif [ "$INTERACTIVE" = 1 ]; then
    if [ "$(uname -s)" = Linux ] && have systemctl; then
      ask SERVICE "Run in the background with pm2, systemd (user service) or none?" systemd
    else
      ask SERVICE "Run in the background with pm2 or none?" pm2
    fi
  fi
fi

NODE_BIN="$(command -v node || echo node)"
case "$SERVICE" in
  pm2)
    if ! have pm2; then
      say "Installing pm2"
      run npm install -g pm2 || die "npm install -g pm2 failed (system Node may need: sudo npm install -g pm2)."
    fi
    if [ "$DRY_RUN" = 0 ] && pm2 describe scallopbot >/dev/null 2>&1; then
      run pm2 restart scallopbot --update-env
    else
      run pm2 start "$DIR/dist/cli.js" --name scallopbot --cwd "$DIR" -- start
    fi
    run pm2 save
    note "To start on boot, run 'pm2 startup' and the sudo command it prints."
    ;;
  systemd)
    have systemctl || die "systemctl not found; use --service pm2."
    UNIT_DIR="$HOME/.config/systemd/user"
    say "Installing user service $UNIT_DIR/scallopbot.service"
    run mkdir -p "$UNIT_DIR"
    if [ "$DRY_RUN" = 0 ]; then
      cat > "$UNIT_DIR/scallopbot.service" <<EOF
[Unit]
Description=ScallopBot personal AI agent
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/dist/cli.js start
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
    fi
    run systemctl --user daemon-reload
    run systemctl --user enable scallopbot.service
    run systemctl --user restart scallopbot.service
    note "To keep it running after you log out: sudo loginctl enable-linger $USER"
    note "Logs: journalctl --user -u scallopbot -f"
    ;;
  none|"")
    note "No service installed. Start it with: cd $DIR && node dist/cli.js start"
    ;;
  *) die "Unknown --service '$SERVICE' (pm2, systemd or none)" ;;
esac

say "Done. Dashboard: http://localhost:3000 (first visit asks for a login unless you set one above)"
