# Roadmap: SmartBot v2 Skills-Only Architecture

## Overview

Transform SmartBot from a tool-based architecture to a pure skills-only system where every capability is defined as a markdown skill file. Starting with the skill system foundation, we'll implement core skills (bash, files, web), integrate them into a simplified agent loop, and complete with Kimi K2.5 thinking mode support.

## Domain Expertise

None

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Skill System Foundation** - SKILL.md format, discovery, and loading infrastructure (In progress)
- [x] **Phase 2: Bash Skill** - Shell command execution as first complete skill (Complete)
- [x] **Phase 3: Skill Executor** - Infrastructure to run skill scripts with SKILL_ARGS (Complete)
- [x] **Phase 4: Web Search Skill** - Brave API integration for web search (Complete)
- [x] **Phase 5: Browser Skill** - Web browsing and content extraction (Complete)
- [x] **Phase 6: Telegram & Memory Skills** - Messaging and semantic memory search (Complete)
- [ ] **Phase 7: Agent Loop Refactor** - Skills-only execution loop replacing tools
- [ ] **Phase 8: Kimi K2.5 Thinking Mode** - Thinking mode with reasoning_content support

## Phase Details

### Phase 1: Skill System Foundation
**Goal**: Define SKILL.md format with YAML frontmatter, implement skill discovery, and create loading infrastructure
**Depends on**: Nothing (first phase)
**Research**: Unlikely (internal architecture, patterns from existing skill system)
**Plans**: TBD

Plans:
- [x] 01-01: Define SKILL.md schema and frontmatter format
- [ ] 01-02: Implement skill directory scanner and loader
- [ ] 01-03: Create skill registry and description aggregator

### Phase 2: Bash Skill
**Goal**: Implement bash skill as first complete skill with scripts folder execution
**Depends on**: Phase 1
**Research**: Unlikely (bash execution patterns exist in current tools)
**Plans**: TBD

Plans:
- [x] 02-01: Create bash skill folder structure and SKILL.md
- [x] 02-02: Implement bash execution script with sandboxing

### Phase 3: Skill Executor
**Goal**: Build infrastructure to run skill scripts (spawn process, pass SKILL_ARGS, capture output)
**Depends on**: Phase 2
**Research**: Unlikely (child_process patterns established in bash skill)
**Plans**: TBD

Plans:
- [x] 03-01: Create SkillExecutor class with script spawning, output capture, and timeout handling

### Phase 4: Web Search Skill
**Goal**: Implement web search skill using Brave Search API
**Depends on**: Phase 3
**Research**: Likely (external API integration)
**Research topics**: Current Brave Search API endpoints, rate limits, response format, API key handling
**Plans**: 1

Plans:
- [x] 04-01: Create web_search skill structure with SKILL.md and run.ts (includes search execution)

### Phase 5: Browser Skill
**Goal**: Implement browser skill for web page browsing and content extraction
**Depends on**: Phase 4
**Research**: Complete (Playwright already in use, wrapping existing BrowserSession)
**Plans**: 1

Plans:
- [x] 05-01: Create browser skill wrapping existing BrowserSession

### Phase 6: Telegram & Memory Skills
**Goal**: Implement telegram messaging and semantic memory search skills
**Depends on**: Phase 5
**Research**: Unlikely (existing implementations in current codebase)
**Plans**: TBD

Plans:
- [x] 06-01: Create memory_search skill for semantic memory queries
- [x] 06-02: Create telegram_send skill wrapping existing functionality

### Phase 7: Agent Loop Refactor
**Goal**: Replace tool-based execution with skills-only agent loop
**Depends on**: Phase 6
**Research**: Unlikely (internal refactor using established patterns)
**Plans**: TBD

Plans:
- [ ] 07-01: Update system prompt to include skill descriptions
- [ ] 07-02: Implement skill selection and invocation in agent loop
- [ ] 07-03: Remove old tool layer and update imports

### Phase 8: Kimi K2.5 Thinking Mode
**Goal**: Enable thinking mode with reasoning_content handling and temperature constraints
**Depends on**: Phase 7
**Research**: Unlikely (already researched in PROJECT.md)
**Plans**: TBD

Plans:
- [ ] 08-01: Implement enableThinking flag and temperature handling
- [ ] 08-02: Parse reasoning_content from responses
- [ ] 08-03: End-to-end testing with complex reasoning tasks

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Skill System Foundation | 1/3 | In progress | - |
| 2. Bash Skill | 2/2 | Complete | 2026-02-04 |
| 3. Skill Executor | 1/1 | Complete | 2026-02-04 |
| 4. Web Search Skill | 1/1 | Complete | 2026-02-04 |
| 5. Browser Skill | 1/1 | Complete | 2026-02-04 |
| 6. Telegram & Memory Skills | 2/2 | Complete | 2026-02-04 |
| 7. Agent Loop Refactor | 0/3 | Not started | - |
| 8. Kimi K2.5 Thinking Mode | 0/3 | Not started | - |
