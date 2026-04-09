#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * Honcho MCP stdio adapter for Claude Code CLI.
 *
 * Implements the Model Context Protocol over stdio (JSON-RPC on
 * stdin/stdout) and proxies tool calls to the self-hosted Honcho
 * REST API. Register in .claude/mcp.json so Claude Code CLI sessions
 * get honcho_context, honcho_search, honcho_ask, honcho_remember tools.
 *
 * Env:
 *   HONCHO_API_URL       (default http://localhost:8000)
 *   HONCHO_WORKSPACE_ID  (default discord-bot)
 *   HONCHO_PEER_ID       (default "karim" — the current user)
 *   HONCHO_SESSION_ID    (default "cli" — CLI sessions share one session)
 */

const API = Deno.env.get("HONCHO_API_URL") ?? "http://localhost:8000";
const WS = Deno.env.get("HONCHO_WORKSPACE_ID") ?? "discord-bot";
const PEER = Deno.env.get("HONCHO_PEER_ID") ?? "karim";
const SESSION = Deno.env.get("HONCHO_SESSION_ID") ?? "cli";

const BASE = `${API}/v3/workspaces/${WS}`;

async function honchoGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

async function honchoPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: "honcho_context",
    description: "Get cross-session user context (profile, summary, card).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "honcho_search",
    description: "Semantic search across user conversation history.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "honcho_ask",
    description: "Ask Honcho's dialectic agent a question about the user.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "Question about the user" } },
      required: ["question"],
    },
  },
  {
    name: "honcho_remember",
    description: "Store an important fact about the user for future sessions.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "Fact to store" } },
      required: ["content"],
    },
  },
];

// ── Tool handlers ──

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "honcho_context": {
      const ctx = await honchoGet(`/sessions/${SESSION}/context`) as Record<string, unknown>;
      const parts: string[] = [];
      if (ctx.peer_representation) parts.push(`Profile: ${ctx.peer_representation}`);
      if (ctx.peer_card) parts.push(`Card: ${ctx.peer_card}`);
      if (ctx.summary) parts.push(`Summary: ${ctx.summary}`);
      return parts.length > 0 ? parts.join("\n\n") : "No context yet.";
    }
    case "honcho_search": {
      const results = await honchoPost(`/peers/${PEER}/search`, { query: args.query });
      return JSON.stringify(results, null, 2).slice(0, 5000);
    }
    case "honcho_ask": {
      const res = await honchoPost(`/peers/${PEER}/chat`, { query: args.question }) as Record<string, unknown>;
      return (res.content ?? res.response ?? JSON.stringify(res)) as string;
    }
    case "honcho_remember": {
      await honchoPost(`/sessions/${SESSION}/messages`, {
        messages: [{ content: `[REMEMBER] ${args.content}`, peer_id: "claude-cli" }],
      });
      return `Stored: "${String(args.content).slice(0, 100)}"`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ── JSON-RPC stdio loop ──

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function send(obj: unknown) {
  const json = JSON.stringify(obj);
  Deno.stdout.writeSync(encoder.encode(`Content-Length: ${json.length}\r\n\r\n${json}`));
}

async function processMessage(msg: { id?: number; method: string; params?: Record<string, unknown> }) {
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "honcho", version: "0.1.0" },
        },
      });
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      break;
    case "tools/call": {
      const { name, arguments: args } = msg.params as { name: string; arguments: Record<string, unknown> };
      try {
        const text = await handleTool(name, args ?? {});
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
      } catch (err) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }], isError: true },
        });
      }
      break;
    }
    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } });
      }
  }
}

// Read Content-Length framed messages from stdin
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);
    try {
      await processMessage(JSON.parse(body));
    } catch (err) {
      console.error("[honcho-mcp-stdio] parse error:", err);
    }
  }
}
