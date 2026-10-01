#!/usr/bin/env sh
# List merged commit subjects since a tag (helper referenced by SKILL.md).
set -eu
since="${1:?usage: collect_changes.sh <since-tag>}"
git log --merges --pretty=format:'%s' "${since}..HEAD"
