---
name: calendar
description: The owner's calendar. Google Calendar (read + write, writes ask the owner first) or any read-only ICS feed. Upcoming events, search, create, update, delete.
user-invocable: true
triggers: [calendar, agenda, schedule, meeting, event, appointment, free on, busy]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: [upcoming, search, get, create, update, delete]
      description: upcoming=events from now (or from/to); search=find events by text; get=one Google event; create/update/delete=Google Calendar writes
    days:
      type: integer
      minimum: 1
      maximum: 366
      description: upcoming - how many days ahead (default 7)
    from:
      type: string
      description: Window start, YYYY-MM-DD or ISO time (upcoming default now; search default 30 days ago)
    to:
      type: string
      description: Window end, YYYY-MM-DD or ISO time
    query:
      type: string
      description: search - text to find in title/location/description
    limit:
      type: integer
      minimum: 1
      maximum: 250
    event_id:
      type: string
      description: get/update/delete - the id from upcoming/search results (Google only)
    title:
      type: string
    start:
      type: string
      description: create/update - YYYY-MM-DD for all-day, YYYY-MM-DDTHH:MM in the owner's timezone, or ISO time with offset
    end:
      type: string
      description: Optional; default is 1 hour after start (timed) or the next day (all-day)
    all_day:
      type: boolean
    location:
      type: string
    description:
      type: string
    attendees:
      type: array
      items:
        type: string
      description: Attendee email addresses
    notify_attendees:
      type: boolean
      description: Email invites/updates to attendees (default false)
  required: [action]
metadata:
  openclaw:
    emoji: "📅"
    requires:
      anyEnv: [GOOGLE_REFRESH_TOKEN, CALENDAR_ICS_URL]
    optionalEnv:
      - GOOGLE_CLIENT_ID
      - GOOGLE_CLIENT_SECRET
      - GOOGLE_CALENDAR_ID
    evidence:
      authoritative: true
      source: calendar
    safety:
      confirmActions: [create, update, delete]
---

# Calendar

Reads the owner's calendar and, with Google Calendar, changes it.

- `upcoming` lists events from now for `days` days (default 7). Each event has
  a `when` string already in the owner's timezone; use it instead of
  converting `start` yourself. All-day events have date-only `start`/`end`
  (`end` is exclusive).
- `search` finds events by text (default window: 30 days back to a year
  ahead).
- `create`, `update` and `delete` need the owner's explicit approval every
  time: the first call is blocked and the owner gets a yes/no prompt. State the
  exact title, date, time and attendees first. After a yes, re-issue the
  identical call.
- Naive times like `2026-10-02T15:00` are in the owner's timezone.
- With only `CALENDAR_ICS_URL` the calendar is read-only.

Examples:

```json
{"action":"upcoming","days":2}
```

```json
{"action":"create","title":"Dentist","start":"2026-10-08T09:30","end":"2026-10-08T10:15","location":"Main St Clinic"}
```
