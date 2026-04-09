/**
 * In-process SDK MCP server exposing Honcho tools to Claude.
 *
 * When attached to a persona via `enableHoncho: true`, Claude can
 * actively query the user's memory — searching past conversations,
 * asking the dialectic agent about the user, or explicitly storing
 * important facts for future sessions.
 *
 * Follows the openclaw-mcp.ts pattern: built once at startup with a
 * mutable context object that gets set per-query in runPromptInChannel.
 *
 * Tools:
 *   honcho_context   — compact user context for the current session
 *   honcho_search    — semantic search across user's conversation history
 *   honcho_ask       — ask the dialectic agent about the user
 *   honcho_remember  — store an important fact / conclusion
 *
 * @module claude/honcho-mcp
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "npm:zod@4.3.6";
import type { HonchoClient } from "./honcho-client.ts";

export interface HonchoMcpContext {
  userId: string;
  channelId: string;
}

/**
 * Build the in-process Honcho MCP server.
 * Returns undefined when client is not available.
 */
export function buildHonchoMcpServer(
  client: HonchoClient,
  getContext: () => HonchoMcpContext,
): McpSdkServerConfigWithInstance {
  const contextTool = tool(
    "honcho_context",
    "Get personalized context about the current user from Honcho's cross-session memory. Returns the user's profile/representation, session summary, and any stored conclusions. Use this when you need to understand the user's preferences, past decisions, or recent work context.",
    {},
    async () => {
      const ctx = getContext();
      try {
        const data = await client.getContext(ctx.channelId);
        const parts: string[] = [];
        if (data.peer_representation) parts.push(`Profile: ${data.peer_representation}`);
        if (data.peer_card) parts.push(`Card: ${data.peer_card}`);
        if (data.summary) parts.push(`Session summary: ${data.summary}`);
        if (parts.length === 0) {
          return { content: [{ type: "text" as const, text: "No user context available yet. Keep conversing — Honcho builds context over time." }] };
        }
        return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Honcho context unavailable: ${err instanceof Error ? err.message : err}` }], isError: true };
      }
    },
  );

  const searchTool = tool(
    "honcho_search",
    "Search across all of the current user's conversation history and conclusions in Honcho. Use when you need to find something specific the user said or decided in a past session.",
    {
      query: z.string().describe("Semantic search query — describe what you're looking for."),
    },
    async (args) => {
      const ctx = getContext();
      try {
        const results = await client.searchPeer(ctx.userId, args.query);
        const text = typeof results === "string" ? results : JSON.stringify(results, null, 2);
        return { content: [{ type: "text" as const, text: text.slice(0, 5000) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Honcho search failed: ${err instanceof Error ? err.message : err}` }], isError: true };
      }
    },
  );

  const askTool = tool(
    "honcho_ask",
    "Ask Honcho's dialectic reasoning agent a question about the current user. Unlike honcho_search (retrieval), this uses LLM reasoning to synthesize an answer from all stored observations. Good for questions like 'What communication style does this user prefer?' or 'What has this user been focused on recently?'",
    {
      question: z.string().describe("A natural language question about the user."),
    },
    async (args) => {
      const ctx = getContext();
      try {
        const answer = await client.chatPeer(ctx.userId, args.question);
        return { content: [{ type: "text" as const, text: answer }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Honcho ask failed: ${err instanceof Error ? err.message : err}` }], isError: true };
      }
    },
  );

  const rememberTool = tool(
    "honcho_remember",
    "Explicitly store an important fact, preference, or decision about the user in Honcho's long-term memory. Use when the user shares something worth remembering across sessions — a preference, a key decision, an important piece of context. The fact will be available in future sessions via honcho_context and honcho_search.",
    {
      content: z.string().describe("The fact, preference, or decision to store. Be specific and self-contained."),
    },
    async (args) => {
      const ctx = getContext();
      try {
        // Store as a message from the bot peer with metadata marking it as explicit memory
        await client.addMessages(ctx.channelId, [
          { content: `[REMEMBER] ${args.content}`, peer_id: "claude-bot" },
        ]);
        return { content: [{ type: "text" as const, text: `Stored: "${args.content.slice(0, 100)}${args.content.length > 100 ? "…" : ""}"` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Honcho remember failed: ${err instanceof Error ? err.message : err}` }], isError: true };
      }
    },
  );

  return createSdkMcpServer({
    name: "honcho",
    version: "0.1.0",
    tools: [contextTool, searchTool, askTool, rememberTool],
  });
}
