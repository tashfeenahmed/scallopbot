---
name: notion
description: Typed Notion API access. Remembers databases across turns, accepts plain values for properties (Sets:3, Date:"2026-08-21"), and returns compact verified results. Prefer this over raw curl or notion-cli.
user-invocable: true
triggers: [notion, database, tracker]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: [known, search, schema, query, create, update]
      description: known=list remembered databases (no network); search; schema; query; create; update
    database:
      type: string
      description: Database title or fragment, e.g. "gym tracker". Resolved from memory or search. Use this when you do not have an ID.
    database_id:
      type: string
      description: Database ID (dashed or undashed). Never invent one; use database instead.
    data_source_id:
      type: string
      description: Data-source ID (dashed or undashed)
    query:
      type: string
      description: Search text for action=search
    object_type:
      type: string
      enum: [page, data_source]
    page_id:
      type: string
      description: Page ID for action=update
    properties:
      type: object
      description: Property values for create/update. Plain values are fine and are typed from the schema automatically - Name:"Leg Press", Sets:3, Reps:"8", Date:"2026-08-21", Type:"Cardio", Done:true. Property names are matched case-insensitively.
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
    verbose:
      type: boolean
      description: schema only - include the raw Notion payload
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

Handles Notion API version `2025-09-03`, resolves databases, types property
values from the schema, checks HTTP status, and returns compact JSON.

Workflow for a write (one call is usually enough):

1. `create` with `database` (a title such as "gym tracker") or a known
   `database_id`/`data_source_id`, and plain `properties`. The tool looks the
   database up in its memory or by search, fetches the schema, and types the
   values for you. The result includes `resolved_from` when it resolved a title.
2. Only if the database is unknown: `known` (remembered databases, free) or
   `search`. Never invent an ID.
3. `schema` only when a property error asks for it; errors already list the
   valid property names and types.
4. Trust completion only when the tool returns `success: true` with a `page_id`.

`create`/`update` return `{page_id, url, title, properties}` with flat values.
An `Unknown database id` error means the ID does not exist; it lists the
databases the tool knows. It is not a permission problem unless the error says
HTTP 401 or 403.

Query responses are compact and date-sorted. For repeated entities, use
`result.stats_by_title[].latest` for the newest dated record and `maxima` for
numeric records. Never infer a personal record, improvement, increase, or trend
from an arbitrary row or from response order. Preserve user-supplied titles and
labels exactly on writes; do not add modalities such as “Dumbbell” or “each arm”.

Examples:

```json
{"action":"create","database":"gym tracker","properties":{"Name":"Pectoral machine","Date":"2026-08-21","Type":"Machine","Sets":3,"Reps":6,"Weight (kg)":45}}
```

```json
{"action":"query","database":"gym tracker","filter":{"property":"Date","date":{"equals":"2026-07-13"}}}
```

```json
{"action":"known"}
```
