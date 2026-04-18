/**
 * In-process SDK MCP server exposing Jira tools to the project-manager
 * persona. Every write operation auto-injects the `pm-bot` label (or
 * whatever JIRA_BOT_LABEL resolves to) so the team can always filter
 * bot-created tickets out of their normal view.
 *
 * Attached to personas that opt in via `enableJira: true`. No-op when
 * the underlying JiraClient is not configured.
 *
 * @module claude/jira-mcp
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "npm:zod@4.3.6";
import type { JiraClient, JiraIssue } from "./jira-client.ts";

function formatIssue(issue: JiraIssue): string {
  const assignee = issue.assignee?.displayName ?? "(unassigned)";
  const labels = issue.labels.length ? issue.labels.join(", ") : "(none)";
  return [
    `**${issue.key}** — ${issue.summary}`,
    `  type: ${issue.type} · status: ${issue.status} (${issue.statusCategory}) · assignee: ${assignee}`,
    `  labels: ${labels}`,
    `  url: ${issue.url}`,
  ].join("\n");
}

export function buildJiraMcpServer(
  client: JiraClient,
): McpSdkServerConfigWithInstance {
  const createIssue = tool(
    "jira_create_issue",
    `Create a new Jira issue in the configured project (${client.config.projectKey}). The '${client.config.botLabel}' label is ALWAYS added automatically so the team can filter bot-created tickets. IMPORTANT: you MUST create a beads task first via the Bash tool ('bd create ...') and include that beads ID in the description so both sides stay linked.`,
    {
      summary: z.string().min(1).describe("Short one-line ticket title."),
      description: z.string().optional().describe(
        "Multi-paragraph body. Should include the linked beads ID (e.g. 'Linked bead: pm-abc').",
      ),
      issue_type: z.string().optional().describe(
        `Jira issue type. Defaults to '${client.config.defaultIssueType}'. Valid for NLITX: Epic, Subtask, Task, Story, Feature, Bug, Wens.`,
      ),
      labels: z.array(z.string()).optional().describe(
        `Extra labels in addition to the auto-injected '${client.config.botLabel}'.`,
      ),
      assignee_account_id: z.string().optional().describe(
        "Atlassian accountId to assign. Omit for unassigned (default).",
      ),
      parent_key: z.string().optional().describe(
        "Parent epic key (e.g. NLITX-12) if this issue is a child of a larger epic.",
      ),
      priority: z.string().optional().describe(
        "Priority name (Highest, High, Medium, Low, Lowest).",
      ),
    },
    async (args) => {
      try {
        const issue = await client.createIssue({
          summary: args.summary,
          description: args.description,
          issueType: args.issue_type,
          labels: args.labels,
          assigneeAccountId: args.assignee_account_id,
          parentKey: args.parent_key,
          priority: args.priority,
        });
        return {
          content: [{
            type: "text" as const,
            text: `Created ${issue.key} → ${issue.url}\n\n${formatIssue(issue)}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_create_issue failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const getIssue = tool(
    "jira_get_issue",
    "Fetch full details of a single Jira issue by key (e.g. NLITX-54).",
    { key: z.string().describe("Issue key, e.g. NLITX-54.") },
    async (args) => {
      try {
        const issue = await client.getIssue(args.key);
        const body = [
          formatIssue(issue),
          "",
          "description:",
          issue.description || "(empty)",
        ].join("\n");
        return { content: [{ type: "text" as const, text: body }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_get_issue failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const updateIssue = tool(
    "jira_update_issue",
    "Update mutable fields on an existing issue. Pass only the fields you want to change. Use add_labels / remove_labels for label ops (never touch the bot label).",
    {
      key: z.string(),
      summary: z.string().optional(),
      description: z.string().optional(),
      issue_type: z.string().optional(),
      priority: z.string().optional(),
      assignee_account_id: z.union([z.string(), z.null()]).optional().describe(
        "Pass a string to assign, null to unassign, or omit to leave unchanged.",
      ),
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        // Guardrail: never let the agent remove the bot label.
        const removeLabels = (args.remove_labels ?? []).filter(
          (l) => l !== client.config.botLabel,
        );
        await client.updateIssue(args.key, {
          summary: args.summary,
          description: args.description,
          issueType: args.issue_type,
          priority: args.priority,
          assigneeAccountId: args.assignee_account_id,
          addLabels: args.add_labels,
          removeLabels,
        });
        const fresh = await client.getIssue(args.key);
        return {
          content: [{ type: "text" as const, text: `Updated ${args.key}.\n\n${formatIssue(fresh)}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_update_issue failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const addComment = tool(
    "jira_add_comment",
    "Post a comment to a Jira issue. Plain text is auto-wrapped in ADF.",
    {
      key: z.string(),
      text: z.string().describe("Comment body."),
    },
    async (args) => {
      try {
        await client.addComment(args.key, args.text);
        return { content: [{ type: "text" as const, text: `Comment added to ${args.key}.` }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_add_comment failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const listIssues = tool(
    "jira_list_issues",
    "Run a JQL search against Jira. Returns up to 30 issues by default. Use this to pull current state before planning.",
    {
      jql: z.string().describe(
        `JQL query. Example: 'project = ${client.config.projectKey} AND labels = "${client.config.botLabel}" AND statusCategory != Done'. NEVER hardcode Dutch status names — use statusCategory instead (new/indeterminate/done).`,
      ),
      max_results: z.number().int().positive().max(100).optional(),
    },
    async (args) => {
      try {
        const issues = await client.searchIssues(args.jql, args.max_results ?? 30);
        if (issues.length === 0) {
          return { content: [{ type: "text" as const, text: "(no issues matched)" }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: `${issues.length} issue(s):\n\n${issues.map(formatIssue).join("\n\n")}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_list_issues failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const listOpenBotIssues = tool(
    "jira_list_open_bot_issues",
    `Convenience wrapper: list all issues in ${client.config.projectKey} with the '${client.config.botLabel}' label that are not in the 'done' status category. Use this for status digests.`,
    { max_results: z.number().int().positive().max(100).optional() },
    async (args) => {
      try {
        const issues = await client.listOpenBotIssues(args.max_results ?? 30);
        if (issues.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No open bot-created issues." }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: `${issues.length} open bot issue(s):\n\n${issues.map(formatIssue).join("\n\n")}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_list_open_bot_issues failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const transitionIssue = tool(
    "jira_transition_issue",
    "Transition a Jira issue to a new status. Prefer target_category (new/indeterminate/done) over transition_id so the tool works on any localized workflow.",
    {
      key: z.string(),
      target_category: z.enum(["new", "indeterminate", "done"]).optional(),
      transition_id: z.string().optional().describe("Explicit transition id — only needed when target_category is ambiguous."),
    },
    async (args) => {
      try {
        if (!args.target_category && !args.transition_id) {
          return {
            content: [{ type: "text" as const, text: "jira_transition_issue needs either target_category or transition_id." }],
            isError: true,
          };
        }
        const name = await client.transitionIssue(args.key, {
          targetCategory: args.target_category,
          transitionId: args.transition_id,
        });
        return {
          content: [{ type: "text" as const, text: `Transitioned ${args.key} → ${name}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_transition_issue failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const transitionToColumn = tool(
    "jira_transition_to_column",
    "Move a Jira issue into a specific board column by name (e.g. 'Te doen', 'IN ONTWIKKELING', 'TE TESTEN'). Use this when the persona has decided which workflow column a ticket belongs in. Case-insensitive match against the issue's available transitions.",
    {
      key: z.string(),
      column_name: z.string().describe("Exact display name of the target column/status, e.g. 'Te doen'."),
    },
    async (args) => {
      try {
        const name = await client.transitionToStatus(args.key, args.column_name);
        return { content: [{ type: "text" as const, text: `Transitioned ${args.key} → ${name}.` }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_transition_to_column failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const listBoardColumns = tool(
    "jira_list_board_columns",
    `List the workflow columns configured on the active Jira board. Returns each column's name and the statuses that map to it. Use this when the user wants a ticket placed on the Board so you can pick the right column. Reads JIRA_BOARD_ID from env (currently ${client.config.boardId ?? "(unset)"}).`,
    {},
    async () => {
      try {
        if (!client.config.boardId) {
          return {
            content: [{ type: "text" as const, text: "JIRA_BOARD_ID is not configured." }],
            isError: true,
          };
        }
        const cols = await client.getBoardColumns(client.config.boardId);
        if (cols.length === 0) {
          return { content: [{ type: "text" as const, text: "(board has no columns)" }] };
        }
        const lines = cols.map((c, i) => `${i + 1}. **${c.name}** — statuses: ${c.statusNames.join(", ") || "(none)"}`);
        return { content: [{ type: "text" as const, text: `${cols.length} board columns:\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_list_board_columns failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const getActiveSprint = tool(
    "jira_get_active_sprint",
    "Return the currently active sprint on the configured board, or report none. The persona always uses the active sprint when adding tickets to the Board (per Mo's standing instructions).",
    {},
    async () => {
      try {
        if (!client.config.boardId) {
          return {
            content: [{ type: "text" as const, text: "JIRA_BOARD_ID is not configured." }],
            isError: true,
          };
        }
        const s = await client.getActiveSprint(client.config.boardId);
        if (!s) {
          return { content: [{ type: "text" as const, text: "No active sprint on the board." }] };
        }
        const started = s.startDate ? ` (started ${s.startDate.slice(0, 10)})` : "";
        return {
          content: [{
            type: "text" as const,
            text: `Active sprint: **${s.name}** (id ${s.id}, state ${s.state})${started}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_get_active_sprint failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const addToSprint = tool(
    "jira_add_to_sprint",
    "Add an issue to a sprint by sprint id. Pair with jira_get_active_sprint to put a ticket on the active Board.",
    {
      sprint_id: z.number().int().positive(),
      issue_key: z.string(),
    },
    async (args) => {
      try {
        await client.addIssueToSprint(args.sprint_id, args.issue_key);
        return {
          content: [{ type: "text" as const, text: `Added ${args.issue_key} to sprint ${args.sprint_id}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `jira_add_to_sprint failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return createSdkMcpServer({
    name: "jira",
    version: "0.1.0",
    tools: [
      createIssue,
      getIssue,
      updateIssue,
      addComment,
      listIssues,
      listOpenBotIssues,
      transitionIssue,
      transitionToColumn,
      listBoardColumns,
      getActiveSprint,
      addToSprint,
    ],
  });
}
