/**
 * In-process SDK MCP server exposing read/write access to team.json
 * for the project-manager persona. Lets Claude add/update members and
 * look up identity facts (Jira accountId, Discord user ID, skills)
 * without needing general Write/Edit tools.
 *
 * @module claude/team-mcp
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "npm:zod@4.3.6";
import type { TeamClient, TeamMember } from "./team-client.ts";

function formatMember(m: TeamMember): string {
  const aliasSuffix = m.alias ? ` (alias: ${m.alias})` : "";
  const lines = [
    `**${m.id}** (${m.kind}) — ${m.display_name}${aliasSuffix}`,
  ];
  if (m.persona) lines.push(`  persona: ${m.persona}`);
  if (m.jira_account_id) lines.push(`  jira accountId: ${m.jira_account_id}`);
  if (m.discord_user_id) lines.push(`  discord user id: ${m.discord_user_id}`);
  lines.push(`  skills: ${m.skills.length ? m.skills.join(", ") : "(none)"}`);
  if (m.notes) lines.push(`  notes: ${m.notes}`);
  return lines.join("\n");
}

export function buildTeamMcpServer(
  client: TeamClient,
): McpSdkServerConfigWithInstance {
  const listTool = tool(
    "team_list",
    "List every member of the project team (humans + agent personas). Returns id, kind, display name, skills, Jira accountId, and Discord user ID where known. Use this to understand who is available before routing a task.",
    {},
    async () => {
      try {
        const members = await client.list();
        if (members.length === 0) {
          return { content: [{ type: "text" as const, text: "(no team members registered)" }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: `${members.length} team member(s):\n\n${members.map(formatMember).join("\n\n")}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `team_list failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const getTool = tool(
    "team_get_member",
    "Look up a single member by id, alias, name substring, Discord user ID, or Jira accountId. Exactly one lookup key must be provided.",
    {
      id: z.string().optional().describe("Stable team id, e.g. 'karim'."),
      name: z.string().optional().describe("Alias or display name substring, case-insensitive (e.g. 'Mo', 'Mohamed', 'karim')."),
      discord_user_id: z.string().optional().describe("Discord snowflake."),
      jira_account_id: z.string().optional().describe("Atlassian accountId."),
    },
    async (args) => {
      try {
        const keys = [args.id, args.name, args.discord_user_id, args.jira_account_id].filter(Boolean);
        if (keys.length !== 1) {
          return {
            content: [{ type: "text" as const, text: "team_get_member: provide exactly one of id / name / discord_user_id / jira_account_id" }],
            isError: true,
          };
        }
        let member: TeamMember | undefined;
        if (args.id) member = await client.findById(args.id);
        else if (args.name) member = await client.findByName(args.name);
        else if (args.discord_user_id) member = await client.findByDiscordId(args.discord_user_id);
        else if (args.jira_account_id) member = await client.findByJiraAccountId(args.jira_account_id);
        if (!member) {
          return { content: [{ type: "text" as const, text: "(no match)" }] };
        }
        return { content: [{ type: "text" as const, text: formatMember(member) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `team_get_member failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const upsertTool = tool(
    "team_upsert_member",
    "Create a new team member or update an existing one. Matches on `id`; if no member with that id exists, a new one is appended. When updating, non-empty fields replace old values and skills are unioned (never removed). Writes are atomic. Use this to store a new member's Jira accountId or Discord user ID once you've learned it — preferred over Honcho for structured identity facts.",
    {
      id: z.string().min(1).describe("Stable team id, e.g. 'karim', 'mohamed', 'bot-maintainer'. Lowercase kebab-case."),
      kind: z.enum(["human", "agent"]).describe("Is this a person or a bot persona?"),
      display_name: z.string().min(1).describe("Human-readable name, e.g. 'Karim Azzouz'."),
      alias: z.string().optional().describe("Short nickname/handle, e.g. 'Mo' for 'Mohamed Chilh'. Used for lookups via team_get_member."),
      jira_account_id: z.string().optional().describe("Atlassian accountId (e.g. '712020:c2ad...'). Omit when unknown."),
      discord_user_id: z.string().optional().describe("Discord snowflake ID. Omit when unknown."),
      persona: z.string().optional().describe("For agents only: the persona preset name, e.g. 'bot-maintainer'."),
      skills: z.array(z.string()).optional().describe("Skill tags for routing, e.g. ['backend','docs']."),
      notes: z.string().optional().describe("Short free-form notes about preferences or context."),
    },
    async (args) => {
      try {
        const { member, created } = await client.upsertMember({
          id: args.id,
          kind: args.kind,
          display_name: args.display_name,
          alias: args.alias,
          jira_account_id: args.jira_account_id,
          discord_user_id: args.discord_user_id,
          persona: args.persona,
          skills: args.skills ?? [],
          notes: args.notes,
        });
        return {
          content: [{
            type: "text" as const,
            text: `${created ? "Created" : "Updated"} team member:\n\n${formatMember(member)}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `team_upsert_member failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return createSdkMcpServer({
    name: "team",
    version: "0.1.0",
    tools: [listTool, getTool, upsertTool],
  });
}
