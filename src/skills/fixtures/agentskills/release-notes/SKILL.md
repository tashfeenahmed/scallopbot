---
name: release-notes
description: Drafts user-facing release notes from a list of merged changes. Use when the user asks for release notes, a changelog entry, or a "what's new" summary.
license: Apache-2.0
compatibility: Requires git for scripts/collect_changes.sh
allowed-tools: Bash(git:*) Read
metadata:
  author: example-org
  version: "1.0"
---

# Release notes

## Steps

1. Collect the merged changes. If the user did not paste them, run
   `scripts/collect_changes.sh <since-tag>` from this skill's folder.
2. Group changes into **New**, **Improved**, and **Fixed**. Drop internal
   refactors and CI-only changes.
3. Write one plain sentence per item, starting with a verb, in the voice
   described in [the style guide](references/STYLE.md).

RELEASE_NOTES_BODY_MARKER
