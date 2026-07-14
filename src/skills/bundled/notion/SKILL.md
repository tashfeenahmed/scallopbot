---
name: notion
description: Typed Notion API access for searching, inspecting schemas, querying data sources, and verified page writes. Prefer this over raw curl or notion-cli.
user-invocable: true
triggers: [notion, database, tracker]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: [search, schema, query, create, update]
    query:
      type: string
      description: Search text for action=search
    object_type:
      type: string
      enum: [page, data_source]
    database_id:
      type: string
      description: Database ID; query/schema automatically resolve its current data source
    data_source_id:
      type: string
      description: Current Notion data-source ID
    page_id:
      type: string
      description: Page ID for action=update
    properties:
      type: object
      description: Exact typed Notion properties for create/update; inspect schema first
    filter:
      type: object
    sorts:
      type: array
      items:
        type: object
    page_size:
      type: integer
      minimum: 1
      maximum: 100
    start_cursor:
      type: string
  required: [action]
metadata:
  openclaw:
    emoji: "📝"
    primaryEnv: NOTION_TOKEN
    evidence:
      authoritative: true
      source: notion-api:v2025-09-03
    requires:
      bins: []
---

# Typed Notion API

Use this tool instead of raw shell requests. It handles Notion API version
`2025-09-03`, resolves a database to its current data source, checks HTTP status,
and returns structured JSON.

Workflow:

1. `search` when the database ID is unknown.
2. `schema` before writing; never guess property names or types.
3. `query` for existing rows.
4. `create` or `update`, then trust completion only when the tool returns success.

Search returns explicit `database_id` and `data_source_id` fields. Pass the
matching field to later calls. The client also recovers safely when a returned
data-source ID is accidentally supplied as `database_id`; do not interpret that
identifier mismatch as a permission problem or ask the user to re-share an
integration unless both typed paths genuinely fail.

Query responses are compact and date-sorted. For repeated entities, use
`result.stats_by_title[].latest` for the newest dated record and `maxima` for
numeric records. Never infer a personal record, improvement, increase, or trend
from an arbitrary row or from response order. A comparison is factual only when
the returned latest/max evidence supports it. Preserve user-supplied titles and
labels exactly on writes; do not add modalities such as “Dumbbell” or “each arm”.

Examples:

```json
{"action":"schema","database_id":"..."}
```

```json
{"action":"query","database_id":"...","filter":{"property":"Date","date":{"equals":"2026-07-13"}}}
```

```json
{"action":"create","database_id":"...","properties":{"Name":{"title":[{"text":{"content":"Example"}}]}}}
```
