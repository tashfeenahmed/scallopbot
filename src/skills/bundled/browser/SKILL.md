---
name: browser
description: Browse websites, interact with elements, and extract content using Playwright
user-invocable: true
triggers: [browse, web, website, page, scrape, click, navigate, screenshot]
scripts:
  run: "scripts/run.ts"
metadata:
  openclaw:
    emoji: "\U0001F310"
    requires:
      bins: []
---

# Browser Skill

Browse websites, interact with page elements, extract content, and take screenshots. Wraps existing Playwright-based BrowserSession with stealth mode.

## When to Use

Use the browser skill for:

- **Browsing websites**: Navigate to URLs and explore web pages
- **Scraping content**: Extract text or HTML from web pages
- **Form automation**: Fill forms, click buttons, submit data
- **Screenshots**: Capture page screenshots for visual verification
- **Interactive workflows**: Multi-step flows requiring element interaction

## Input Format

The skill accepts JSON arguments via the `SKILL_ARGS` environment variable:

```json
{
  "operation": "navigate",
  "url": "https://example.com"
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `operation` | string | Yes | One of: navigate, snapshot, click, type, fill, extract, screenshot, close |
| `url` | string | navigate | URL to navigate to |
| `target` | string \| number | click, type, fill | Element ref number, CSS selector, or "text=..." |
| `text` | string | type, fill | Text to type or fill |
| `fullPage` | boolean | screenshot | Capture full page (default: false) |
| `format` | string | extract | "text" (default) or "html" |
| `selector` | string | extract | Optional selector to extract from |

## Output Format

The skill returns JSON to stdout:

```json
{
  "success": true,
  "output": "Navigation complete: https://example.com - Example Domain",
  "exitCode": 0
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | True if operation completed successfully |
| `output` | string | Operation result or extracted content |
| `error` | string | Error message if operation failed |
| `exitCode` | number | Process exit code (0 = success) |

## Operations Reference

### navigate

Navigate to a URL. Clears previous element refs.

```json
{ "operation": "navigate", "url": "https://example.com" }
```

**Output:** URL and page title

### snapshot

Get list of interactable elements with ref numbers for later operations.

```json
{ "operation": "snapshot" }
```

**Output:** Formatted list of elements with refs, e.g.:
```
[1] <a> "Click me" href=/page
[2] <input> placeholder="Search"
[3] <button> "Submit"
```

### click

Click an element by ref number, CSS selector, or text selector.

```json
{ "operation": "click", "target": 3 }
{ "operation": "click", "target": "#submit-btn" }
{ "operation": "click", "target": "text=Submit" }
```

**Output:** Confirmation of click

### type

Type text into an element character by character (with delay).

```json
{ "operation": "type", "target": 2, "text": "search query" }
```

**Output:** Confirmation of typing

### fill

Fill input field instantly (replaces existing content).

```json
{ "operation": "fill", "target": "input[name=email]", "text": "user@example.com" }
```

**Output:** Confirmation of fill

### extract

Extract content from page or specific element.

```json
{ "operation": "extract" }
{ "operation": "extract", "format": "html", "selector": "#main" }
```

**Output:** Extracted text or HTML content

### screenshot

Take a screenshot of the page.

```json
{ "operation": "screenshot" }
{ "operation": "screenshot", "fullPage": true }
```

**Output:** Screenshot metadata (dimensions, format)

### close

Close the browser session.

```json
{ "operation": "close" }
```

**Output:** Confirmation of close

## Workflow Example

Typical multi-step workflow:

1. Navigate to page:
   ```json
   { "operation": "navigate", "url": "https://example.com/login" }
   ```

2. Take snapshot to see elements:
   ```json
   { "operation": "snapshot" }
   ```

3. Fill form fields using refs from snapshot:
   ```json
   { "operation": "fill", "target": 1, "text": "user@example.com" }
   { "operation": "fill", "target": 2, "text": "password123" }
   ```

4. Click submit button:
   ```json
   { "operation": "click", "target": 3 }
   ```

5. Extract result:
   ```json
   { "operation": "extract" }
   ```

6. Close when done:
   ```json
   { "operation": "close" }
   ```

## Session Behavior

- **Singleton session**: All operations use the same browser instance
- **Stealth mode**: Anti-detection measures (user agent rotation, webdriver removal)
- **Headless by default**: Browser runs without visible window
- **Element refs reset**: After navigate, previous refs are invalid; run snapshot again

## Examples

### Check if website is accessible

```json
{ "operation": "navigate", "url": "https://status.example.com" }
```

### Scrape article text

```json
{ "operation": "navigate", "url": "https://news.example.com/article" }
{ "operation": "extract", "format": "text" }
```

### Submit search form

```json
{ "operation": "navigate", "url": "https://search.example.com" }
{ "operation": "snapshot" }
{ "operation": "fill", "target": "input[type=search]", "text": "query" }
{ "operation": "click", "target": "text=Search" }
```
