# claude-discord (fork of zebbern/claude-code-discord)

You are working in the bot-maintainer's source tree. This repo is a
Deno/TypeScript Discord bot that wraps `@anthropic-ai/claude-agent-sdk`
so each Discord channel can host its own Claude Code session.

## Repo layout at a glance

```
index.ts                         bootstrap, runPromptInChannel, forum + ambient handlers
discord/bot.ts                   discord.js client, event listeners, isOurChannel,
                                  guild-scoped command registration, ThreadCreate +
                                  MessageCreate listeners
discord/session-threads.ts       SessionThreadManager (persistence + restoreChannels)
discord/types.ts                 BotDependencies interface
core/handler-registry.ts         central handler wiring + per-channel state
core/command-wrappers.ts         slash command → handler dispatch
core/channel-bindings.ts         ChannelBindingManager + validateBindPath
core/bind-commands.ts            /bind /unbind /bindings slash commands
core/persona.ts                  PersonaConfig registry + mergePersonaIntoOptions
core/persona-commands.ts         /persona load/clear/show/list/reload
core/session-commands.ts         /session reset /session info
claude/client.ts                 SDK query wrapper (sendToClaudeCode)
claude/command.ts                /claude /claude-thread /resume /cancel handlers
claude/discord-sender.ts         full + quiet (CLI-footer) renderers
claude/dashboard-hooks.ts        SDK hook forwarders → monitor + observe
claude/openclaw-mcp.ts           in-process MCP server bridging to OpenClaw
util/persistence.ts              generic PersistenceManager<T> + singletons
personas/*.json                  persona presets (reloadable at runtime)
docker-compose.yml               bot + agent-monitor + agents-observe sidecars
```

## Deployment

- Container name: `claude-code-discord` (Docker Compose, `restart: unless-stopped`)
- Build + apply: `docker compose build claude-bot && docker compose up -d --force-recreate claude-bot`
- Logs: `docker logs --tail 30 claude-code-discord`
- Update Claude CLI inside container: `docker compose build --build-arg CLAUDE_BUILD_STAMP=$(date +%s) claude-bot`
- The host user can't access docker directly without newgrp, so shell commands that hit docker must be prefixed with `sg docker -c '<cmd>'` (or similar) on this machine.

## State that persists

- `.bot-data/channel-sessions.json` — channelId → sessionId
- `.bot-data/thread-sessions.json` — thread metadata (survives restart, ThreadChannel refs re-fetched)
- `.bot-data/channel-bindings.json` — channelId → ProjectConfig (incl. personaName)
- Volume `claude-config` — `/home/claude/.claude` (OAuth tokens persist here)

## Trust model

YOLO (bypassPermissions). Ambient + forum messages auto-set
`permissionMode: 'bypassPermissions'` in `runPromptInChannel` when the
persona doesn't override. `dontAsk` is the SDK default but it causes
Claude to pre-emptively refuse MCP tools without even trying, so we
override it.

## Session-locking gotcha

Resumed Claude sessions lock in their original MCP servers + system
prompt. When you change a persona or flip `enableOpenclaw`, you MUST
reset the channel's session for new tools to take effect. `/persona load`
and `/persona clear` auto-clear via `onPersonaChanged`. `/session reset`
is the manual escape hatch.

## Coding conventions

- Conventional commits: `feat(scope):`, `fix(scope):`, `chore(scope):`,
  `docs(scope):`. Look at recent `git log --oneline` for examples.
- Small, focused commits. Commit per logical change, not per task.
- Multi-line commit messages via HEREDOC (bash) so formatting is clean.
- Always include `Refs karpa-<id>` footer linking to the beads task.
- Test via rebuild + restart before committing: runtime errors surface
  on bot startup and show up in `docker logs`.
- `runPromptInChannel` is the hot path — changes here affect ambient
  messages, forum threads, and every Discord surface that isn't a slash
  command. Be careful about side effects.

## Task tracking

- Beads workspace: `pa` — use `WORKSPACE_NAME=pa bd <cmd>` explicitly.
- Parent feature: `karpa-opo` (Persistent Claude Code Discord bridge).
- `bd ready` shows unblocked work; `bd close <id> --reason="…"` when done.

## Dashboards

- agent-monitor: http://localhost:4820 (Kanban + D3)
- agents-observe: http://localhost:4981 (event stream, `AGENTS_OBSERVE_RUNTIME=local` to disable idle shutdown)

Hook events flow via `claude/dashboard-hooks.ts` → SDK hook callbacks →
fire-and-forget HTTP POSTs. Toggle off with `DASHBOARD_DISABLED=1`.

## OpenClaw delegation

Host bridge at `~/openclaw-bridge/bridge.mjs` exposes `POST /agent` on
`:8901` (bearer-token auth). Container reaches it via
`host.docker.internal:8901` (see `extra_hosts` in docker-compose.yml).
Bridge runs via `nohup node bridge.mjs &` for now — systemd unit is
tracked as `karpa-7sn`.

When `persona.enableOpenclaw: true`, the bot injects an in-process SDK
MCP server (`mcp__openclaw__openclaw_delegate`) that Claude can call to
hand off tasks to the local OpenClaw agents (`main`, `dev`, `content`).
