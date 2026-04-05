# Personas

Per-channel agent presets. Each `*.json` file in this directory is a
reusable persona that can be attached to a Discord channel via
`/persona load <name>` (the `<name>` is the filename without `.json`).

The bot loads every `*.json` here at startup and exposes them via
`/persona list`. Run `/persona reload` to hot-swap after editing.

## Schema

```json
{
  "description": "Shown in /persona list. Required.",
  "appendSystemPrompt": "Appended to Claude Code's default system prompt.",
  "model": "opus | sonnet | haiku | <pinned-model-id>",
  "allowedTools": ["Read", "Write", "WebFetch"],
  "disallowedTools": ["Bash"],
  "mcpServers": {
    "name": { "type": "stdio", "command": "…", "args": ["…"] }
  },
  "agents": {
    "scraper": {
      "description": "…",
      "tools": ["WebFetch"],
      "prompt": "…"
    }
  },
  "agent": "scraper",
  "plugins": [{ "type": "local", "path": "/abs/path" }],
  "skills": ["plugin-name:skill-name"]
}
```

Only `description` is required. Anything else omitted falls through to
the bot's defaults (global `WORK_DIR`, default model, full tool set).

## Fields

| Field | Maps to | Notes |
|---|---|---|
| `description` | `/persona list` / `/persona show` | Free-form, one sentence. |
| `appendSystemPrompt` | SDK `systemPrompt.append` | Concatenated with any existing append. |
| `model` | SDK `model` | `opus`, `sonnet`, `haiku`, or a full model ID. |
| `allowedTools` / `disallowedTools` | SDK tool allow/deny lists | Denylist wins. |
| `mcpServers` | SDK `mcpServers` | Merged with `<workDir>/.claude/mcp.json`. |
| `agents` | SDK `agents` | Sub-agent definitions. |
| `agent` | SDK `agent` | Main-thread agent name — must exist in `agents`. |
| `plugins` | SDK `plugins` | Claude Code local plugins. |
| `skills` | SDK `skills` | Namespaced skill names. |

## Seed presets

- **default** — Claude Code base, no overrides.
- **docs-writer** — writing/editing focus, sonnet, Read+Write+Edit+Glob+Grep only.
- **market-researcher** — research focus, sonnet, WebFetch+WebSearch. Hook point for OpenClaw MCP delegation.
- **bot-maintainer** — maintains this repo, opus, full tools, knows the architecture.
- **code-reviewer** — read-only audit mode, sonnet, denies Write/Edit/Bash.

## Adding a persona

1. Create `personas/my-persona.json` with at least a `description`.
2. In Discord, run `/persona reload`.
3. `/persona load my-persona` in a channel.
4. `/claude …` — queries in that channel now use your persona.

## CLAUDE.md companion

A persona configures *how* Claude behaves. Persistent *project
knowledge* lives in a `CLAUDE.md` inside the workDir — it's loaded
automatically via the SDK's `settingSources: ['project', 'local']`.
Use both together: persona for style/tools, CLAUDE.md for facts.
