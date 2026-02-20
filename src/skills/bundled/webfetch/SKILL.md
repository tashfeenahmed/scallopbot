---
name: webfetch
description: Fetch and extract text content from a URL
user-invocable: false
triggers: [fetch, http, url, webpage, download, curl, web]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    url:
      type: string
      description: "URL to fetch content from"
    max_length:
      type: number
      description: "Maximum characters to return (default: 50000)"
  required: [url]
metadata:
  openclaw:
    emoji: "\U0001F310"
    requires:
      bins: []
---

# Web Fetch Skill

Fetch a URL and extract its text content, stripping HTML markup.

## When to Use

Use webfetch for:

- **Reading documentation**: Fetch API docs, guides
- **Checking web content**: Verify what a URL contains
- **Extracting text**: Get clean text from HTML pages
- **Fetching data**: Download JSON or text data

## Input Format

```json
{
  "url": "https://example.com/docs",
  "max_length": 10000
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | URL to fetch (must be http/https) |
| `max_length` | number | No | 50000 | Max characters to return |

## Security

- SSRF protection: blocks private/internal IP ranges
- Only HTTP and HTTPS URLs allowed
- 30-second request timeout

## Limitations

- Maximum 50000 characters by default
- Basic HTML-to-text conversion (no JavaScript rendering)
- May not work with sites that require authentication
