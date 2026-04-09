/**
 * Persona system — per-channel agent personalities.
 *
 * A persona is a JSON preset in `personas/*.json` that configures how
 * Claude behaves in a particular Discord channel: its system-prompt
 * additions, model choice, tool allowlist, MCP servers, and optional
 * subagent definitions. Presets are loaded once at bot startup into an
 * in-memory registry and attached to channels via the `personaName`
 * field on ProjectConfig (set by `/persona load <name>`).
 *
 * Everything here is optional — a channel without a persona falls
 * through to the bot's global defaults. Fields that a persona doesn't
 * specify are also passed through as-is.
 *
 * @module core/persona
 */

import { ensureDir } from "https://deno.land/std@0.208.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.208.0/path/mod.ts";
import type {
  AgentDefinition as SDKAgentDefinition,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKPermissionMode } from "../claude/client.ts";

/**
 * The user-editable persona preset as stored in `personas/*.json`.
 * Every field except `description` is optional. Fields map directly
 * onto ClaudeModelOptions at query time — see
 * `mergePersonaIntoOptions()` below.
 */
export interface PersonaConfig {
  /** Shown in /persona list and /agents. Required. */
  description: string;
  /** Appended to the Claude Code preset system prompt. */
  appendSystemPrompt?: string;
  /** Model alias: opus | sonnet | haiku (or a pinned full model ID). */
  model?: string;
  /** SDK permission mode. When the user trusts this persona fully, set
   *  "bypassPermissions" (YOLO). Defaults come from the caller
   *  (runPromptInChannel → bypassPermissions; /claude → user settings). */
  permissionMode?: SDKPermissionMode;
  /** Whitelist of tool names (e.g. ["Read", "Write", "WebFetch"]). */
  allowedTools?: string[];
  /** Blacklist of tool names; takes precedence over allowedTools. */
  disallowedTools?: string[];
  /** Extra MCP servers for this persona, merged with <workDir>/.claude/mcp.json. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Sub-agent definitions the main agent can delegate to. */
  agents?: Record<string, SDKAgentDefinition>;
  /** Name of the agent to run as the main thread (must exist in `agents`). */
  agent?: string;
  /** Claude Code local plugins to load for this persona. */
  plugins?: { type: "local"; path: string }[];
  /** Named skills to enable (plugin/skill-name syntax). */
  skills?: string[];
  /** If true, the bot injects the in-process OpenClaw MCP server into
   *  this persona's mcpServers map so Claude can delegate tasks to
   *  local OpenClaw agents. Requires OPENCLAW_BRIDGE_URL + _TOKEN env. */
  enableOpenclaw?: boolean;
  /** If true, the bot fetches user context from Honcho before each query
   *  (injected into system prompt) and stores conversation turns after
   *  each response. Requires HONCHO_API_URL env. */
  enableHoncho?: boolean;
}

/**
 * Loaded persona with its name (derived from filename) attached.
 */
export interface LoadedPersona extends PersonaConfig {
  name: string;
}

/**
 * Loads and serves persona preset files from disk.
 */
export class PersonaManager {
  private personas = new Map<string, LoadedPersona>();
  private dir: string;

  constructor(personasDir: string) {
    this.dir = personasDir;
  }

  /**
   * Read all `*.json` files in the personas directory into memory.
   * Called once on bot startup. Safe to call again to hot-reload.
   */
  async load(): Promise<number> {
    this.personas.clear();
    try {
      await ensureDir(this.dir);
    } catch (err) {
      console.error(`[PersonaManager] cannot access ${this.dir}:`, err);
      return 0;
    }

    let count = 0;
    for await (const entry of Deno.readDir(this.dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      if (entry.name === "README.json") continue;
      const name = entry.name.replace(/\.json$/, "");
      const fullPath = path.join(this.dir, entry.name);
      try {
        const raw = await Deno.readTextFile(fullPath);
        const parsed = JSON.parse(raw) as PersonaConfig;
        if (!parsed || typeof parsed !== "object" || typeof parsed.description !== "string") {
          console.warn(`[PersonaManager] skipping ${entry.name}: missing 'description' field`);
          continue;
        }
        this.personas.set(name, { ...parsed, name });
        count++;
      } catch (err) {
        console.error(`[PersonaManager] failed to load ${entry.name}:`, err);
      }
    }

    console.log(`[PersonaManager] loaded ${count} persona preset(s) from ${this.dir}`);
    return count;
  }

  /** Reload all presets from disk (hot-swap during development). */
  async reload(): Promise<number> {
    return await this.load();
  }

  /** Get a persona by name, or undefined if not registered. */
  get(name: string): LoadedPersona | undefined {
    return this.personas.get(name);
  }

  /** Returns true if the persona name exists. */
  has(name: string): boolean {
    return this.personas.has(name);
  }

  /** List all loaded personas (sorted alphabetically by name). */
  list(): LoadedPersona[] {
    return Array.from(this.personas.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  /** Number of loaded presets. */
  size(): number {
    return this.personas.size;
  }

  /** Absolute path of the personas directory. */
  getDir(): string {
    return this.dir;
  }
}

/**
 * Merge a persona's SDK-facing fields into an existing options object.
 * Mutates and returns `target`. Persona MCP servers are union-merged:
 * persona entries replace same-named entries from `target`.
 */
export function mergePersonaIntoOptions<
  T extends {
    model?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    mcpServers?: Record<string, McpServerConfig>;
    agents?: Record<string, SDKAgentDefinition>;
    agent?: string;
    permissionMode?: SDKPermissionMode;
  },
>(target: T, persona: PersonaConfig | undefined): T {
  if (!persona) return target;
  if (persona.model && !target.model) target.model = persona.model;
  if (persona.permissionMode && !target.permissionMode) target.permissionMode = persona.permissionMode;
  if (persona.appendSystemPrompt) {
    target.appendSystemPrompt = target.appendSystemPrompt
      ? `${target.appendSystemPrompt}\n\n${persona.appendSystemPrompt}`
      : persona.appendSystemPrompt;
  }
  if (persona.allowedTools && !target.allowedTools) target.allowedTools = persona.allowedTools;
  if (persona.disallowedTools && !target.disallowedTools) target.disallowedTools = persona.disallowedTools;
  if (persona.mcpServers) {
    target.mcpServers = { ...(target.mcpServers ?? {}), ...persona.mcpServers };
  }
  if (persona.agents) {
    target.agents = { ...(target.agents ?? {}), ...persona.agents };
  }
  if (persona.agent && !target.agent) target.agent = persona.agent;
  return target;
}
