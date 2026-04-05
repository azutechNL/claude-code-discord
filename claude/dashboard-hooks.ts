/**
 * Dashboard hook forwarder — in-process SDK hooks that POST Claude Code
 * events to one or more monitoring dashboards running as Docker sidecars.
 *
 * Each hook is a fire-and-forget HTTP POST; failures are logged but never
 * propagated back to the SDK, so a dashboard outage can't break Claude
 * queries. Toggled off entirely via DASHBOARD_DISABLED=1.
 *
 * Two dashboard formats are supported (configured by URL):
 *   - agent-monitor (hoangsonww): POST /api/hooks/event
 *       { "hook_type": "<EventName>", "data": <raw-hook-input> }
 *   - agents-observe (simple10):  POST /api/events
 *       { "hook_payload": <raw-hook-input>, "meta": { "env": {...} } }
 *
 * @module claude/dashboard-hooks
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

export interface DashboardEndpoints {
  /** agent-monitor `/api/hooks/event` style endpoint. */
  monitorUrl?: string;
  /** agents-observe `/api/events` style endpoint. */
  observeUrl?: string;
}

export interface DashboardHookContext {
  /** Discord channel ID where the query originated. Used as project slug. */
  channelId: string;
  /** Persona name attached to the channel, if any. */
  personaName?: string;
  /** Name of the Discord guild/server. */
  guildName?: string;
}

/** Hook event names we forward to dashboards. */
const FORWARDED_EVENTS: HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
];

/**
 * Read dashboard endpoints from environment. Defaults assume the sidecars
 * are running on the same Docker network as the bot (service DNS).
 */
export function getDashboardEndpoints(): DashboardEndpoints {
  if (Deno.env.get("DASHBOARD_DISABLED") === "1") return {};
  return {
    monitorUrl: Deno.env.get("DASHBOARD_MONITOR_URL") ??
      "http://agent-monitor:4820/api/hooks/event",
    observeUrl: Deno.env.get("DASHBOARD_OBSERVE_URL") ??
      "http://agents-observe:4981/api/events",
  };
}

/**
 * Fire-and-forget POST with a short timeout. Never throws.
 */
async function postJson(url: string, body: unknown, timeoutMs = 3000): Promise<void> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(`[dashboard-hooks] POST ${url} → ${res.status}`);
    }
    // Drain the body so the connection returns to the pool.
    try { await res.body?.cancel(); } catch { /* ignore */ }
  } catch (err) {
    // Don't spam logs for network errors during dashboard downtime.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("ENOTFOUND") && !msg.includes("aborted") && !msg.includes("ECONNREFUSED")) {
      console.warn(`[dashboard-hooks] POST ${url} failed:`, msg);
    }
  }
}

/**
 * Build SDK hook callbacks that forward events to all configured
 * dashboards. Returns an empty object when no dashboards are configured
 * (or DASHBOARD_DISABLED=1), which is safe to spread into SDK options.
 */
export function buildDashboardHooks(
  endpoints: DashboardEndpoints,
  ctx: DashboardHookContext,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  if (!endpoints.monitorUrl && !endpoints.observeUrl) return {};

  const forward = (eventName: string, input: HookInput) => {
    // Fire-and-forget — don't await.
    if (endpoints.monitorUrl) {
      const body = { hook_type: eventName, data: input };
      void postJson(endpoints.monitorUrl, body);
    }
    if (endpoints.observeUrl) {
      const body = {
        hook_payload: input,
        meta: {
          env: {
            AGENTS_OBSERVE_PROJECT_SLUG: ctx.channelId,
            CHANNEL_ID: ctx.channelId,
            ...(ctx.personaName ? { PERSONA: ctx.personaName } : {}),
            ...(ctx.guildName ? { GUILD: ctx.guildName } : {}),
          },
        },
      };
      void postJson(endpoints.observeUrl, body);
    }
  };

  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const event of FORWARDED_EVENTS) {
    const cb: HookCallback = async (input: HookInput) => {
      forward(event, input);
      return { continue: true } satisfies SyncHookJSONOutput;
    };
    hooks[event] = [{ hooks: [cb] }];
  }
  return hooks;
}

/**
 * Merge two hook maps. Callers from the same event are concatenated so
 * both user-supplied and dashboard-forwarding hooks fire.
 */
export function mergeHooks(
  a: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  b: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (!a) return b;
  if (!b) return a;
  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...a };
  for (const [eventName, matchers] of Object.entries(b) as [HookEvent, HookCallbackMatcher[]][]) {
    const existing = merged[eventName];
    merged[eventName] = existing ? [...existing, ...matchers] : matchers;
  }
  return merged;
}
