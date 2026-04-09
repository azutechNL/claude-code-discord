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
| `agents` | SDK `agents` | Sub-agent definitions (see below). |
| `agent` | SDK `agent` | Main-thread agent name — must exist in `agents`. Omit to let Claude act as the "lead" with the persona's `appendSystemPrompt`. |
| `permissionMode` | SDK `permissionMode` | `bypassPermissions` (YOLO), `acceptEdits`, `plan`, `dontAsk`, `default`. Runtime falls back to `bypassPermissions` when omitted (the bot is YOLO by default). |
| `enableOpenclaw` | — (bot-specific) | When true, the bot injects its in-process OpenClaw MCP server into this persona's `mcpServers` so the agent can delegate to OpenClaw via `openclaw_delegate`. |
| `enableHoncho` | — (bot-specific) | When true, the bot (1) fetches user context from Honcho before each query and injects it into the system prompt, (2) stores conversation turns after each response, and (3) exposes `honcho_context`, `honcho_search`, `honcho_ask`, `honcho_remember` MCP tools. Requires `HONCHO_API_URL` env. |
| `plugins` | SDK `plugins` | Claude Code local plugins. |
| `skills` | SDK `skills` | Namespaced skill names. |

## Subagents (`agents` field)

Personas can declare specialized subagents the lead can delegate to.
Each entry is a full `AgentDefinition`:

```json
"agents": {
  "scraper": {
    "description": "Shown to the lead; guides when to delegate.",
    "tools": ["WebFetch"],                       // tool allowlist for this subagent
    "disallowedTools": ["Bash"],                 // optional denylist
    "prompt": "System prompt for the subagent.",
    "model": "inherit"                           // or "sonnet"/"opus"/"haiku"
  }
}
```

The lead persona invokes a subagent when it decides the subagent's
description matches the task. Delegation rules live in the lead's
`appendSystemPrompt`. Subagents run in their own context window and
return a single response back to the lead.

Don't set `agent` unless you want a named agent to *be* the lead. When
`agent` is omitted, Claude acts as the lead directly.

## Seed presets

- **default** — Claude Code base, no overrides.
- **docs-writer** — sonnet, Read+Write+Edit+Glob+Grep. Subagents: `outliner`, `proofreader`.
- **market-researcher** — sonnet, YOLO, OpenClaw delegation enabled. Subagents: `scraper`, `summariser`, `verifier`.
- **bot-maintainer** — maintains this repo, opus, full tools, knows the architecture. Honcho enabled.
- **code-reviewer** — read-only audit mode, sonnet, denies Write/Edit/Bash.
- **memory-enhanced** — sonnet, YOLO, Honcho + OpenClaw. Best for daily work sessions.

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
