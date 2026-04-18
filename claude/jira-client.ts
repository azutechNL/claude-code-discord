/**
 * Thin Jira Cloud REST v3 client for the project-manager persona.
 *
 * Handles auth (Basic email:token), ADF-wrapped descriptions/comments,
 * and status-category mapping so the bot stays language-independent on
 * workflows whose display names are localized (NLITX uses Dutch).
 *
 * Toggled off entirely when any of JIRA_BASE_URL / JIRA_EMAIL /
 * JIRA_API_TOKEN / JIRA_PROJECT_KEY are missing from the environment.
 *
 * @module claude/jira-client
 */

import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  boardId?: number;
  defaultIssueType: string;
  botLabel: string;
}

export function getJiraConfig(): JiraClientConfig | undefined {
  const baseUrl = Deno.env.get("JIRA_BASE_URL");
  const email = Deno.env.get("JIRA_EMAIL");
  const apiToken = Deno.env.get("JIRA_API_TOKEN");
  const projectKey = Deno.env.get("JIRA_PROJECT_KEY");
  if (!baseUrl || !email || !apiToken || !projectKey) return undefined;
  const boardId = Deno.env.get("JIRA_BOARD_ID");
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    email,
    apiToken,
    projectKey,
    boardId: boardId ? Number(boardId) : undefined,
    defaultIssueType: Deno.env.get("JIRA_DEFAULT_ISSUE_TYPE") ?? "Task",
    botLabel: Deno.env.get("JIRA_BOT_LABEL") ?? "pm-bot",
  };
}

/** Wrap plain text into a minimal Atlassian Document Format doc. */
export function textToAdf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).map((p) => ({
    type: "paragraph",
    content: [{ type: "text", text: p.trim() || " " }],
  }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph", content: [] }],
  };
}

/** Flatten ADF back to plain text (best-effort, for display). */
// deno-lint-ignore no-explicit-any
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text ?? "";
  if (Array.isArray(node.content)) {
    const inner = node.content.map(adfToText).join("");
    return node.type === "paragraph" ? inner + "\n" : inner;
  }
  return "";
}

export interface CreateIssueInput {
  summary: string;
  description?: string;
  issueType?: string;
  labels?: string[];
  assigneeAccountId?: string | null;
  parentKey?: string;
  priority?: string;
}

export interface JiraIssue {
  key: string;
  id: string;
  url: string;
  summary: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done" | string;
  type: string;
  labels: string[];
  assignee: { accountId: string; displayName: string } | null;
  reporter: { accountId: string; displayName: string } | null;
  description: string;
  updated: string;
}

// deno-lint-ignore no-explicit-any
function parseIssue(raw: any, baseUrl: string): JiraIssue {
  const f = raw.fields ?? {};
  return {
    key: raw.key,
    id: raw.id,
    url: `${baseUrl}/browse/${raw.key}`,
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    statusCategory: f.status?.statusCategory?.key ?? "",
    type: f.issuetype?.name ?? "",
    labels: Array.isArray(f.labels) ? f.labels : [],
    assignee: f.assignee
      ? { accountId: f.assignee.accountId, displayName: f.assignee.displayName }
      : null,
    reporter: f.reporter
      ? { accountId: f.reporter.accountId, displayName: f.reporter.displayName }
      : null,
    description: adfToText(f.description).trim(),
    updated: f.updated ?? "",
  };
}

export class JiraClient {
  private authHeader: string;

  constructor(public readonly config: JiraClientConfig) {
    this.authHeader = `Basic ${encodeBase64(`${config.email}:${config.apiToken}`)}`;
  }

  private async request(
    method: string,
    pathStr: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${pathStr}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  private async requestJson<T = unknown>(
    method: string,
    pathStr: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.request(method, pathStr, body);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jira ${method} ${pathStr} → HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Verify auth + project access. Returns the authenticated accountId. */
  async verifyAuth(): Promise<string> {
    const me = await this.requestJson<{ accountId: string; emailAddress: string }>(
      "GET",
      "/rest/api/3/myself",
    );
    return me.accountId;
  }

  /** Create a new issue. The bot label is always auto-injected. */
  async createIssue(input: CreateIssueInput): Promise<JiraIssue> {
    const labels = Array.from(new Set([...(input.labels ?? []), this.config.botLabel]));
    // deno-lint-ignore no-explicit-any
    const fields: Record<string, any> = {
      project: { key: this.config.projectKey },
      summary: input.summary,
      issuetype: { name: input.issueType ?? this.config.defaultIssueType },
      labels,
    };
    if (input.description) {
      fields.description = textToAdf(input.description);
    }
    if (input.assigneeAccountId !== undefined) {
      fields.assignee = input.assigneeAccountId === null
        ? null
        : { accountId: input.assigneeAccountId };
    }
    if (input.parentKey) {
      fields.parent = { key: input.parentKey };
    }
    if (input.priority) {
      fields.priority = { name: input.priority };
    }
    const created = await this.requestJson<{ id: string; key: string }>(
      "POST",
      "/rest/api/3/issue",
      { fields },
    );
    return await this.getIssue(created.key);
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const fields = "summary,status,issuetype,labels,assignee,reporter,description,updated";
    const raw = await this.requestJson<unknown>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`,
    );
    return parseIssue(raw, this.config.baseUrl);
  }

  async updateIssue(
    key: string,
    patch: Partial<CreateIssueInput> & { addLabels?: string[]; removeLabels?: string[] },
  ): Promise<void> {
    // deno-lint-ignore no-explicit-any
    const fields: Record<string, any> = {};
    // deno-lint-ignore no-explicit-any
    const update: Record<string, any> = {};
    if (patch.summary !== undefined) fields.summary = patch.summary;
    if (patch.description !== undefined) fields.description = textToAdf(patch.description);
    if (patch.issueType !== undefined) fields.issuetype = { name: patch.issueType };
    if (patch.priority !== undefined) fields.priority = { name: patch.priority };
    if (patch.assigneeAccountId !== undefined) {
      fields.assignee = patch.assigneeAccountId === null
        ? null
        : { accountId: patch.assigneeAccountId };
    }
    if (patch.addLabels || patch.removeLabels) {
      // deno-lint-ignore no-explicit-any
      const ops: any[] = [];
      for (const l of patch.addLabels ?? []) ops.push({ add: l });
      for (const l of patch.removeLabels ?? []) ops.push({ remove: l });
      update.labels = ops;
    }
    // deno-lint-ignore no-explicit-any
    const body: Record<string, any> = {};
    if (Object.keys(fields).length) body.fields = fields;
    if (Object.keys(update).length) body.update = update;
    if (!Object.keys(body).length) return;
    await this.requestJson<void>(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(key)}`,
      body,
    );
  }

  async addComment(key: string, text: string): Promise<void> {
    await this.requestJson<void>(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { body: textToAdf(text) },
    );
  }

  /**
   * Uses /rest/api/3/search/jql — the successor to the removed
   * /rest/api/3/search endpoint. Single-page only (no nextPageToken
   * handling) which is fine for our typical 30-item status digests.
   */
  async searchIssues(jql: string, maxResults = 30): Promise<JiraIssue[]> {
    const fields = "summary,status,issuetype,labels,assignee,reporter,description,updated";
    const qs = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields,
    });
    const res = await this.requestJson<{ issues: unknown[] }>(
      "GET",
      `/rest/api/3/search/jql?${qs.toString()}`,
    );
    return (res.issues ?? []).map((i) => parseIssue(i, this.config.baseUrl));
  }

  /** Convenience: list bot-label tickets not in the `done` category. */
  async listOpenBotIssues(maxResults = 30): Promise<JiraIssue[]> {
    const jql =
      `project = ${this.config.projectKey} AND labels = "${this.config.botLabel}" AND statusCategory != Done ORDER BY updated DESC`;
    return await this.searchIssues(jql, maxResults);
  }

  async listTransitions(key: string): Promise<
    { id: string; name: string; toName: string; toCategory: string }[]
  > {
    // deno-lint-ignore no-explicit-any
    const res = await this.requestJson<{ transitions: any[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    return (res.transitions ?? []).map((t) => ({
      id: String(t.id),
      name: t.name,
      toName: t.to?.name ?? "",
      toCategory: t.to?.statusCategory?.key ?? "",
    }));
  }

  /**
   * Transition by category ("new" | "indeterminate" | "done") — picks the
   * first transition whose target status falls into that category. Falls
   * back to explicit transitionId when `targetCategory` isn't supplied.
   */
  async transitionIssue(
    key: string,
    opts: { transitionId?: string; targetCategory?: "new" | "indeterminate" | "done" },
  ): Promise<string> {
    let transitionId = opts.transitionId;
    let resolvedName = "";
    if (!transitionId) {
      if (!opts.targetCategory) {
        throw new Error("transitionIssue: must provide transitionId or targetCategory");
      }
      const transitions = await this.listTransitions(key);
      const match = transitions.find((t) => t.toCategory === opts.targetCategory);
      if (!match) {
        throw new Error(
          `No transition leads to category '${opts.targetCategory}' for ${key}. Available: ${
            transitions.map((t) => `${t.name}→${t.toCategory}`).join(", ")
          }`,
        );
      }
      transitionId = match.id;
      resolvedName = match.toName;
    }
    await this.requestJson<void>(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { transition: { id: transitionId } },
    );
    return resolvedName || `transition ${transitionId}`;
  }

  /**
   * Transition an issue to whichever workflow step matches `targetStatusName`
   * (case-insensitive). Use this when the persona has picked a specific
   * board column like "Te doen" or "IN ONTWIKKELING".
   */
  async transitionToStatus(key: string, targetStatusName: string): Promise<string> {
    const transitions = await this.listTransitions(key);
    const want = targetStatusName.toLowerCase().trim();
    const match = transitions.find((t) => t.toName.toLowerCase().trim() === want);
    if (!match) {
      throw new Error(
        `No transition to status '${targetStatusName}' for ${key}. Available: ${
          transitions.map((t) => t.toName).join(", ")
        }`,
      );
    }
    await this.requestJson<void>(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { transition: { id: match.id } },
    );
    return match.toName;
  }

  // ── Agile / board / sprint API (rest/agile/1.0) ──────────────────

  /**
   * Get the configured columns for a board. Each column is one workflow
   * step on the kanban/scrum board. Returns the column name plus the list
   * of statuses that map onto it.
   */
  async getBoardColumns(
    boardId: number,
  ): Promise<{ name: string; statusIds: string[]; statusNames: string[] }[]> {
    // deno-lint-ignore no-explicit-any
    const cfg = await this.requestJson<any>(
      "GET",
      `/rest/agile/1.0/board/${boardId}/configuration`,
    );
    const cols = cfg?.columnConfig?.columns ?? [];
    // deno-lint-ignore no-explicit-any
    return cols.map((c: any) => ({
      name: c.name ?? "(unnamed)",
      statusIds: (c.statuses ?? []).map((s: { id?: string }) => s.id ?? ""),
      statusNames: (c.statuses ?? []).map((s: { name?: string }) => s.name ?? ""),
    }));
  }

  /** Return the active sprint for a board (or undefined if none). */
  async getActiveSprint(
    boardId: number,
  ): Promise<{ id: number; name: string; state: string; startDate?: string } | undefined> {
    // deno-lint-ignore no-explicit-any
    const res = await this.requestJson<any>(
      "GET",
      `/rest/agile/1.0/board/${boardId}/sprint?state=active`,
    );
    const sprints = res?.values ?? [];
    if (sprints.length === 0) return undefined;
    const s = sprints[0];
    return { id: s.id, name: s.name, state: s.state, startDate: s.startDate };
  }

  /** Add an issue to a sprint by sprint id. */
  async addIssueToSprint(sprintId: number, issueKey: string): Promise<void> {
    await this.requestJson<void>(
      "POST",
      `/rest/agile/1.0/sprint/${sprintId}/issue`,
      { issues: [issueKey] },
    );
  }
}

export function buildJiraClient(): JiraClient | undefined {
  const cfg = getJiraConfig();
  if (!cfg) return undefined;
  return new JiraClient(cfg);
}
