---
name: browser
description: Browse websites using agent-browser CLI - navigate, interact, extract content
user-invocable: false
triggers: [browse, web, website, page, scrape, click, navigate, screenshot]
metadata:
  openclaw:
    emoji: "\U0001F310"
    requires:
      bins: [agent-browser]
---

# Browser Skill (agent-browser CLI)

Use the `agent-browser` CLI via bash for all web automation. This is a powerful headless browser optimized for AI agents.

## Workflow

1. **Navigate** to a URL with `open`
2. **Snapshot** to see interactive elements with refs (@e1, @e2, etc.)
3. **Interact** using refs from snapshot (click, fill, type)
4. **Extract** content with `get text` or `screenshot`

## Core Commands

```bash
# Navigation
agent-browser open <url>              # Go to URL
agent-browser back                    # Go back
agent-browser forward                 # Go forward
agent-browser reload                  # Reload page

# Get page state (ALWAYS do this after navigating)
agent-browser snapshot                # Get elements with refs
agent-browser snapshot -i             # Interactive elements only (recommended)

# Click elements
agent-browser click @e2               # Click by ref from snapshot
agent-browser click "text=Submit"     # Click by visible text
agent-browser click "#login-btn"      # Click by CSS selector

# Fill forms
agent-browser fill @e3 "user@example.com"   # Fill input by ref
agent-browser type @e4 "password"           # Type character by character
agent-browser press Enter                    # Press key

# Select dropdowns
agent-browser select @e5 "option-value"

# Extract content
agent-browser get text                # Get all page text
agent-browser get text @e1            # Get element text
agent-browser get html                # Get page HTML
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title

# Screenshots
agent-browser screenshot              # Viewport screenshot
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot page.png     # Save to file

# Wait
agent-browser wait @e1                # Wait for element
agent-browser wait 2000               # Wait 2 seconds

# Scroll
agent-browser scroll down 500         # Scroll down 500px
agent-browser scrollintoview @e10     # Scroll element into view
```

## Understanding Refs

After `snapshot`, elements have refs like `@e1`, `@e2`. Use these refs for reliable interaction:

```bash
# Example snapshot output:
# @e1 link "Home"
# @e2 link "Products"
# @e3 textbox "Search..."
# @e4 button "Search"

# Then interact:
agent-browser fill @e3 "laptop"
agent-browser click @e4
```

## Advanced Options

```bash
# Run headed (visible browser)
agent-browser --headed open example.com

# Use proxy
agent-browser --proxy "http://127.0.0.1:8888" open example.com

# Ignore HTTPS errors
agent-browser --ignore-https-errors open https://self-signed.example.com

# JSON output (for parsing)
agent-browser --json snapshot
agent-browser --json get text

# Custom user agent
agent-browser --user-agent "Mozilla/5.0..." open example.com

# Persistent profile (keeps cookies/state)
agent-browser --profile ~/.browser-profile open example.com
```

## Common Workflows

### Login to a website

```bash
agent-browser open https://example.com/login
agent-browser snapshot -i
# Find email/password fields from snapshot
agent-browser fill @e2 "user@example.com"
agent-browser fill @e3 "password123"
agent-browser click @e4  # Submit button
agent-browser wait 2000
agent-browser get url    # Verify redirect
```

### Search and extract results

```bash
agent-browser open https://search.example.com
agent-browser snapshot -i
agent-browser fill @e1 "search query"
agent-browser press Enter
agent-browser wait 2000
agent-browser get text   # Get search results
```

### Take screenshot for visual analysis

```bash
agent-browser open https://example.com
agent-browser wait 2000
agent-browser screenshot --full page.png
```

### Scrape content from page

```bash
agent-browser open https://news.example.com/article
agent-browser wait 1000
agent-browser get text
```

## Session Management

Sessions keep browser state between commands:

```bash
# All commands in same session share state
export AGENT_BROWSER_SESSION="my-session"
agent-browser open https://example.com
agent-browser snapshot
agent-browser click @e1
# Browser stays open between commands

# Close when done
agent-browser close
```

## Tips

1. **Always snapshot after navigation** - refs change when page changes
2. **Use `-i` flag** for snapshot to see only interactive elements
3. **Use `--json` flag** when you need to parse output programmatically
4. **Wait after actions** that trigger page loads
5. **Use refs (@e1)** instead of CSS selectors when possible - more reliable
6. **Check `get url`** after clicks to verify navigation happened
