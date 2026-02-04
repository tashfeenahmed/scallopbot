# Roadmap: SmartBot

## Overview

Transform SmartBot into a proactive personal assistant with skills-only architecture, enhanced agentic loop, and multiple trigger sources (Telegram, Web UI, Cron).

## Domain Expertise

None

## Milestones

- ✅ **v1.0 Skills-Only Architecture** - Phases 1-7 (shipped 2026-02-04)
- 🚧 **v2.0 Agent Polish & Enhanced Loop** - Phases 9-17 (in progress)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

<details>
<summary>✅ v1.0 Skills-Only Architecture (Phases 1-7) - SHIPPED 2026-02-04</summary>

### Phase 1: Skill System Foundation
**Goal**: Define SKILL.md format with YAML frontmatter, implement skill discovery, and create loading infrastructure
**Plans**: 1/3 complete (remaining plans superseded by later phases)

Plans:
- [x] 01-01: Define SKILL.md schema and frontmatter format

### Phase 2: Bash Skill
**Goal**: Implement bash skill as first complete skill with scripts folder execution
**Plans**: 2/2 complete

Plans:
- [x] 02-01: Create bash skill folder structure and SKILL.md
- [x] 02-02: Implement bash execution script with sandboxing

### Phase 3: Skill Executor
**Goal**: Build infrastructure to run skill scripts (spawn process, pass SKILL_ARGS, capture output)
**Plans**: 1/1 complete

Plans:
- [x] 03-01: Create SkillExecutor class with script spawning, output capture, and timeout handling

### Phase 4: Web Search Skill
**Goal**: Implement web search skill using Brave Search API
**Plans**: 1/1 complete

Plans:
- [x] 04-01: Create web_search skill structure with SKILL.md and run.ts

### Phase 5: Browser Skill
**Goal**: Implement browser skill for web page browsing and content extraction
**Plans**: 1/1 complete

Plans:
- [x] 05-01: Create browser skill wrapping existing BrowserSession

### Phase 6: Telegram & Memory Skills
**Goal**: Implement telegram messaging and semantic memory search skills
**Plans**: 2/2 complete

Plans:
- [x] 06-01: Create memory_search skill for semantic memory queries
- [x] 06-02: Create telegram_send skill wrapping existing functionality

### Phase 7: Agent Loop Refactor
**Goal**: Replace tool-based execution with skills-only agent loop
**Plans**: 3/3 complete

Plans:
- [x] 07-01: Update system prompt to include skill descriptions
- [x] 07-02: Implement skill selection and invocation in agent loop
- [x] 07-03: Make toolRegistry optional and wire SkillExecutor in Gateway

</details>

### 🚧 v2.0 Agent Polish & Enhanced Loop (In Progress)

**Milestone Goal:** Clean up codebase, add tests, build web UI, and transform the agent into a proactive personal assistant that loops until task completion with human-like messaging.

#### Phase 9: Code Cleanup
**Goal**: Delete unused tool code, dead imports, deprecation leftovers
**Depends on**: v1.0 complete
**Research**: Unlikely (internal cleanup)
**Plans**: TBD

Plans:
- [ ] 09-01: TBD (run /gsd:plan-phase 9 to break down)

#### Phase 10: Test Infrastructure
**Goal**: Test framework setup, skill tests, agent loop tests
**Depends on**: Phase 9
**Research**: Unlikely (Jest/Vitest patterns established)
**Plans**: TBD

Plans:
- [ ] 10-01: TBD

#### Phase 11: Web UI
**Goal**: Local web interface for testing alongside Telegram
**Depends on**: Phase 10
**Research**: Likely (framework choice: Express+static, Next.js, simple HTML+WS)
**Research topics**: WebSocket vs SSE for streaming, simple UI framework choice
**Plans**: TBD

Plans:
- [ ] 11-01: TBD

#### Phase 12: Loop Until Done
**Goal**: Agent continues in loops until task complete (stop vs next-task decision each iteration)
**Depends on**: Phase 11
**Research**: Unlikely (extending existing agent loop)
**Plans**: TBD

Plans:
- [ ] 12-01: TBD

#### Phase 13: Unified Triggers
**Goal**: Telegram, Web UI, and Cron (reminders) as trigger sources
**Depends on**: Phase 12
**Research**: Unlikely (existing reminder system, adding trigger abstraction)
**Plans**: TBD

Plans:
- [ ] 13-01: TBD

#### Phase 14: Proactive Execution
**Goal**: Download npm modules, find workarounds, ask user when blocked
**Depends on**: Phase 13
**Research**: Unlikely (bash skill can npm install, prompt engineering)
**Plans**: TBD

Plans:
- [ ] 14-01: TBD

#### Phase 15: Human-like Messaging
**Goal**: Short punchy messages, multiple sends, conversational style
**Depends on**: Phase 14
**Research**: Unlikely (prompt engineering + send_message skill usage)
**Plans**: TBD

Plans:
- [ ] 15-01: TBD

#### Phase 16: System Prompt Refinement
**Goal**: Simplify prompt for achievement focus + personal assistant tone
**Depends on**: Phase 15
**Research**: Unlikely (prompt engineering)
**Plans**: TBD

Plans:
- [ ] 16-01: TBD

#### Phase 17: Kimi K2.5 Thinking Mode
**Goal**: Enable thinking mode with reasoning_content handling and temperature constraints
**Depends on**: Phase 16
**Research**: Unlikely (already researched in PROJECT.md)
**Plans**: TBD

Plans:
- [ ] 17-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-7 | v1.0 | 11/11 | Complete | 2026-02-04 |
| 9. Code Cleanup | v2.0 | 0/? | Not started | - |
| 10. Test Infrastructure | v2.0 | 0/? | Not started | - |
| 11. Web UI | v2.0 | 0/? | Not started | - |
| 12. Loop Until Done | v2.0 | 0/? | Not started | - |
| 13. Unified Triggers | v2.0 | 0/? | Not started | - |
| 14. Proactive Execution | v2.0 | 0/? | Not started | - |
| 15. Human-like Messaging | v2.0 | 0/? | Not started | - |
| 16. System Prompt Refinement | v2.0 | 0/? | Not started | - |
| 17. Kimi K2.5 Thinking Mode | v2.0 | 0/? | Not started | - |
