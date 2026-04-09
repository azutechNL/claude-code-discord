#!/bin/bash
# Initialize a project folder for Claude Code Discord sessions.
#
# Creates:
#   .claude/skills/     — project-specific skill files (auto-loaded by SDK)
#   .claude/settings.json — project-level Claude Code settings
#   CLAUDE.md           — project context (auto-loaded by SDK)
#   .beads/             — per-project beads task database (JSONL mode)
#
# Usage:
#   ./init-project.sh /path/to/project [project-label]
#
# Example:
#   ./init-project.sh ~/projects/nl-itx "NL-ITX Core Operations"

set -euo pipefail

PROJECT_DIR="${1:?Usage: init-project.sh <project-dir> [label]}"
PROJECT_LABEL="${2:-$(basename "$PROJECT_DIR")}"
PROJECT_NAME="$(basename "$PROJECT_DIR")"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "error: $PROJECT_DIR does not exist" >&2
  exit 1
fi

cd "$PROJECT_DIR"
echo "Initializing project: $PROJECT_NAME ($PROJECT_LABEL)"
echo "Directory: $PROJECT_DIR"
echo ""

# ── 1. .claude/skills/ ──────────────────────────────────────────────

mkdir -p .claude/skills

if [ ! -f .claude/skills/README.md ]; then
cat > .claude/skills/README.md << 'SKILL_README'
# Skills

Project-specific skills for Claude Code sessions. Each `.md` file here
is auto-loaded by the SDK via `settingSources: ['project']` when Claude
operates in this directory.

## Conventions

- One skill per file. Name = what the skill does (`deploy.md`, `testing.md`).
- Start with a `# Title` and a one-line description.
- Use imperative voice ("Run X", "Check Y", "Never do Z").
- Keep under 500 words — skills should be crisp instructions, not docs.
- Reference file paths relative to project root.

## How Claude uses these

Skills appear in Claude's context as available procedures. Claude can
invoke them by name when the user's request matches, or reference them
for project-specific conventions. They're not "called" like tools —
they're more like standing instructions that Claude knows about.
SKILL_README
echo "  ✓ .claude/skills/README.md"
fi

if [ ! -f .claude/skills/conventions.md ]; then
cat > .claude/skills/conventions.md << SKILL_CONV
# Project Conventions — $PROJECT_LABEL

## Coding style
- Follow existing patterns in the codebase. Read before writing.
- Prefer small, focused changes over sweeping refactors.

## Git
- Commit messages: imperative mood, under 72 chars.
- One logical change per commit.

## Task tracking
- This project uses beads (\`bd\` CLI) for task management.
- Run \`bd ready\` to see available work before starting.
- Run \`bd create --title="..." --description="..." --type=task --priority=2\` for new tasks.
- Run \`bd close <id> --reason="..."\` when done.
- Always claim work before starting: \`bd update <id> --claim\`.
SKILL_CONV
echo "  ✓ .claude/skills/conventions.md"
fi

# ── 2. .claude/settings.json ────────────────────────────────────────

if [ ! -f .claude/settings.json ]; then
cat > .claude/settings.json << 'SETTINGS'
{
  "permissions": {
    "allow": [
      "Bash(bd *)",
      "Bash(git status)",
      "Bash(git log *)",
      "Bash(git diff *)"
    ]
  }
}
SETTINGS
echo "  ✓ .claude/settings.json (pre-approved: bd, git read commands)"
fi

# ── 3. CLAUDE.md ────────────────────────────────────────────────────

if [ ! -f CLAUDE.md ]; then
cat > CLAUDE.md << CLAUDE_MD
# $PROJECT_LABEL

You are working in the **$PROJECT_NAME** project.

## Quick reference

- **Task tracker:** beads (\`bd ready\`, \`bd create\`, \`bd close\`)
- **Skills:** see \`.claude/skills/\` for project-specific procedures

## Project structure

$(find . -maxdepth 2 -not -path './.git/*' -not -path './.beads/*' -not -path './.claude/*' -not -path './node_modules/*' -not -name '.' | sort | head -30 | sed 's|^./|  |')

_Update this section as the project evolves._
CLAUDE_MD
echo "  ✓ CLAUDE.md"
else
  echo "  · CLAUDE.md already exists (skipped)"
fi

# ── 4. .beads/ ──────────────────────────────────────────────────────

if [ ! -d .beads ]; then
  echo ""
  echo "  Initializing beads..."
  echo "y" | BEADS_DIR="$(pwd)/.beads" /home/karim/.local/bin/bd.bin init 2>&1 | grep -E "✓|prefix|error" | sed 's/^/  /'
  sed -i 's/# no-db: false/no-db: true/' .beads/config.yaml
  # Stop any dolt server that init started
  kill "$(cat .beads/dolt-server.pid 2>/dev/null)" 2>/dev/null || true
  echo "  ✓ .beads/ (JSONL mode)"
else
  echo "  · .beads/ already exists (skipped)"
fi

echo ""
echo "Done. From Discord (after /bind folder:/workspaces/projects/$PROJECT_NAME):"
echo "  - Claude auto-loads CLAUDE.md + .claude/skills/*.md"
echo "  - Claude can run bd commands for task tracking"
echo "  - /persona load <name> to attach a specialized persona"
