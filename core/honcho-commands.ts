/**
 * Slash commands for inspecting Honcho user-context state.
 *
 *   /honcho status   — overview: peers, sessions, messages, queue
 *   /honcho peer     — show current user's representation + card
 *   /honcho sessions — list active sessions with message counts
 *
 * @module core/honcho-commands
 */

import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import type { CommandHandlers, InteractionContext } from "../discord/index.ts";
import { createFormattedEmbed } from "../discord/index.ts";

export const honchoCommands = [
  new SlashCommandBuilder()
    .setName("honcho")
    .setDescription("Inspect Honcho user-context memory state")
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Overview: peers, sessions, messages, queue")
    )
    .addSubcommand((sub) =>
      sub.setName("peer").setDescription("Show your representation + peer card")
    )
    .addSubcommand((sub) =>
      sub.setName("sessions").setDescription("List active sessions with message counts")
    ),
];

export interface HonchoCommandDeps {
  /** Base URL for the Honcho API. */
  apiUrl: string;
  /** Workspace ID. */
  workspaceId: string;
}

async function honchoGet(deps: HonchoCommandDeps, path: string): Promise<unknown> {
  const res = await fetch(`${deps.apiUrl}/v3/workspaces/${deps.workspaceId}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function honchoPost(deps: HonchoCommandDeps, path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${deps.apiUrl}/v3/workspaces/${deps.workspaceId}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export function createHonchoCommandHandlers(deps: HonchoCommandDeps): CommandHandlers {
  const handlers: CommandHandlers = new Map();

  handlers.set("honcho", {
    execute: async (ctx: InteractionContext) => {
      await ctx.deferReply();
      const subcommand = ctx.getSubcommand(false);

      try {
        if (subcommand === "status") {
          // deno-lint-ignore no-explicit-any
          const peers = await honchoPost(deps, "/peers/list") as any;
          // deno-lint-ignore no-explicit-any
          const sessions = await honchoPost(deps, "/sessions/list") as any;
          // deno-lint-ignore no-explicit-any
          const queue = await honchoGet(deps, "/queue/status") as any;

          const peerLines = (peers.items || []).map((p: { id: string; configuration?: { observe_me?: boolean } }) => {
            const obs = p.configuration?.observe_me ? "observed" : "transparent";
            return `\`${p.id}\` (${obs})`;
          });

          const sessionCount = sessions.items?.length ?? 0;
          const queuePending = queue.pending ?? queue.total ?? 0;

          const { embed } = createFormattedEmbed(
            "🧠 Honcho Status",
            [
              `**Workspace:** \`${deps.workspaceId}\``,
              `**API:** \`${deps.apiUrl}\``,
              "",
              `**Peers (${peerLines.length}):**`,
              ...peerLines.map((l: string) => `  ${l}`),
              "",
              `**Sessions:** ${sessionCount} active`,
              `**Queue:** ${queuePending} pending items`,
            ].join("\n"),
            0x5865f2,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }

        if (subcommand === "peer") {
          const userId = ctx.getUserId();
          // Try the Discord user ID first, fall back to "karim"
          let peerId = userId;
          let peerCtx;
          try {
            // deno-lint-ignore no-explicit-any
            peerCtx = await honchoGet(deps, `/peers/${peerId}/context`) as any;
          } catch {
            peerId = "karim";
            // deno-lint-ignore no-explicit-any
            peerCtx = await honchoGet(deps, `/peers/${peerId}/context`) as any;
          }

          const rep = peerCtx.representation || "_No representation built yet. Keep chatting — the deriver builds it over time._";
          const card = peerCtx.peer_card || "_No peer card yet._";

          const { embed } = createFormattedEmbed(
            `🧠 Peer: ${peerId}`,
            [
              "**Representation:**",
              rep.slice(0, 1500),
              "",
              "**Peer Card:**",
              card.slice(0, 500),
            ].join("\n"),
            0x5865f2,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }

        if (subcommand === "sessions") {
          // deno-lint-ignore no-explicit-any
          const sessions = await honchoPost(deps, "/sessions/list") as any;
          const items = sessions.items || [];

          if (items.length === 0) {
            const { embed } = createFormattedEmbed("🧠 Sessions", "No active sessions.", 0x808080);
            await ctx.editReply({ embeds: [embed] });
            return;
          }

          const lines: string[] = [];
          for (const s of items.slice(0, 15)) {
            try {
              // deno-lint-ignore no-explicit-any
              const msgs = await honchoPost(deps, `/sessions/${s.id}/messages/list`, { page_size: 1 }) as any;
              const count = msgs.total ?? 0;
              const created = new Date(s.created_at).toLocaleDateString();
              lines.push(`<#${s.id}> — ${count} msgs (since ${created})`);
            } catch {
              lines.push(`\`${s.id}\` — ? msgs`);
            }
          }
          if (items.length > 15) lines.push(`_...and ${items.length - 15} more_`);

          const { embed } = createFormattedEmbed(
            `🧠 Sessions (${items.length})`,
            lines.join("\n"),
            0x5865f2,
          );
          await ctx.editReply({ embeds: [embed] });
          return;
        }

        const { embed } = createFormattedEmbed("❓", "Use `/honcho status`, `/honcho peer`, or `/honcho sessions`.", 0x808080);
        await ctx.editReply({ embeds: [embed] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const { embed } = createFormattedEmbed("❌ Honcho Error", `API call failed: ${msg}\n\nIs Honcho running? \`curl ${deps.apiUrl}/health\``, 0xff0000);
        await ctx.editReply({ embeds: [embed] });
      }
    },
  });

  return handlers;
}
