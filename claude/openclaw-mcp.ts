/**
 * In-process SDK MCP server that delegates to OpenClaw agents via the
 * host HTTP bridge. Attached to personas that opt in via
 * `enableOpenclaw: true`.
 *
 * When Claude calls the `openclaw_delegate` tool, this module POSTs the
 * request to the bridge (default `host.docker.internal:8901`) which
 * shells out to `openclaw agent --json` on the host and returns the
 * agent's reply. No openclaw CLI is required inside the bot container.
 *
 * Toggled off entirely when `OPENCLAW_BRIDGE_URL` or
 * `OPENCLAW_BRIDGE_TOKEN` is missing from the environment.
 *
 * @module claude/openclaw-mcp
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "npm:zod@4.3.6";

export interface OpenclawBridgeConfig {
  /** Full URL of the bridge, e.g. http://host.docker.internal:8901 */
  url: string;
  /** Bearer token shared with the bridge. */
  token: string;
  /** Optional per-call timeout override (seconds). */
  defaultTimeoutSec?: number;
}

/**
 * Resolve bridge config from environment. Returns undefined when the
 * feature is not configured — callers should no-op in that case.
 */
export function getOpenclawBridgeConfig(): OpenclawBridgeConfig | undefined {
  const url = Deno.env.get("OPENCLAW_BRIDGE_URL");
  const token = Deno.env.get("OPENCLAW_BRIDGE_TOKEN");
  if (!url || !token) return undefined;
  return { url: url.replace(/\/+$/, ""), token };
}

type BridgeResponse = {
  ok?: boolean;
  error?: string;
  elapsed_ms?: number;
  // deno-lint-ignore no-explicit-any
  result?: any;
};

/**
 * Extract the human-readable text reply from OpenClaw's JSON result.
 * Handles both the structured payload shape (result.payloads[].text)
 * and the raw fallback shape (result.raw).
 */
function extractReplyText(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result);
  // deno-lint-ignore no-explicit-any
  const r = result as any;
  // The bridge sometimes wraps the JSON as { raw: "<stringified>" } when
  // it can't parse; unwrap that first.
  if (typeof r.raw === "string") {
    try {
      return extractReplyText(JSON.parse(r.raw));
    } catch {
      return r.raw;
    }
  }
  // Standard shape: { runId, status, result: { payloads: [{ text }], meta } }
  const payloads = r?.result?.payloads;
  if (Array.isArray(payloads) && payloads.length > 0) {
    return payloads.map((p: { text?: string }) => p.text ?? "").filter(Boolean).join("\n");
  }
  if (typeof r.summary === "string") return r.summary;
  return JSON.stringify(r);
}

/**
 * Build the in-process SDK MCP server that exposes `openclaw_delegate`.
 * Returns undefined when the bridge is not configured.
 */
export function buildOpenclawMcpServer(
  cfg?: OpenclawBridgeConfig,
): McpSdkServerConfigWithInstance | undefined {
  const config = cfg ?? getOpenclawBridgeConfig();
  if (!config) return undefined;

  const delegateTool = tool(
    "openclaw_delegate",
    "Delegate a repetitive or time-consuming task (market research, scraping, cron-triggered work, etc.) to an OpenClaw agent running on the host. The OpenClaw agent has its own tools (web_search, web_fetch, memory, cron, sessions_send, …) and returns a summarized result. Use this for tasks that would blow up your own context window or require sustained background work.",
    {
      message: z.string().describe(
        "The instruction for the OpenClaw agent. Be specific about the desired output format.",
      ),
      agent: z.string().optional().describe(
        "Which OpenClaw agent to route to. Valid names come from `openclaw agents list`. Defaults to 'main' when omitted.",
      ),
      session_id: z.string().optional().describe(
        "Existing OpenClaw session ID to continue, if any.",
      ),
      thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional().describe(
        "OpenClaw thinking level — higher = more reasoning tokens.",
      ),
      timeout_sec: z.number().int().positive().max(1800).optional().describe(
        "Max seconds to wait for the agent reply (default 600).",
      ),
    },
    async (args) => {
      const body = {
        message: args.message,
        agent: args.agent ?? "main",
        ...(args.session_id ? { session_id: args.session_id } : {}),
        ...(args.thinking ? { thinking: args.thinking } : {}),
        ...(args.timeout_sec ? { timeout: args.timeout_sec } : {}),
      };

      try {
        const res = await fetch(`${config.url}/agent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return {
            content: [{
              type: "text" as const,
              text: `OpenClaw bridge HTTP ${res.status}: ${text || "(no body)"}`,
            }],
            isError: true,
          };
        }

        const data = (await res.json()) as BridgeResponse;
        if (!data.ok) {
          return {
            content: [{
              type: "text" as const,
              text: `OpenClaw error: ${data.error ?? "unknown"}`,
            }],
            isError: true,
          };
        }

        const replyText = extractReplyText(data.result);
        const elapsed = typeof data.elapsed_ms === "number"
          ? ` (${(data.elapsed_ms / 1000).toFixed(1)}s)`
          : "";
        return {
          content: [{
            type: "text" as const,
            text: `${replyText}\n\n_openclaw:${args.agent ?? "main"}${elapsed}_`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `OpenClaw bridge unreachable: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  return createSdkMcpServer({
    name: "openclaw",
    version: "0.1.0",
    tools: [delegateTool],
  });
}
