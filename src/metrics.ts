import type { Env } from "./types";
import eventsPerRepoQuery from "../ae_queries/events_per_repo.sql";
import errorsByRepoQuery from "../ae_queries/errors_by_repo.sql";
import eventsByActorQuery from "../ae_queries/events_by_actor.sql";

// Event types for categorizing metrics
export type EventType =
  | "webhook"
  | "track"
  | "finalize"
  | "setup"
  | "installation"
  | "failure_comment";

// Status values for tracking outcomes
export type EventStatus =
  | "success"
  | "failure"
  | "error"
  | "skipped"
  | "cancelled";

// Metric event structure matching WAE schema
// index1 (blob): {owner}/{repo} - primary grouping key
// blob1: event_type, blob2: event_subtype, blob3: status, blob4: actor, blob5: error_code
// double1: issue_number, double2: run_id, double3: duration_ms, double4: is_private, double5: is_pull_request
export interface MetricEvent {
  repo: string; // index1 - {owner}/{repo}
  eventType: EventType; // blob1
  eventSubtype?: string; // blob2 - e.g., 'issue_comment', 'schedule'
  status: EventStatus; // blob3
  actor?: string; // blob4
  errorCode?: string; // blob5
  issueNumber?: number; // double1
  runId?: number; // double2
  durationMs?: number; // double3
  isPrivate?: boolean; // double4
  isPullRequest?: boolean; // double5
}

// Emit a metric event to Analytics Engine
// Uses optional chaining to gracefully handle missing binding (e.g., in tests)
export function emitMetric(env: Env, event: MetricEvent): void {
  env.BONK_EVENTS?.writeDataPoint({
    indexes: [event.repo],
    blobs: [
      event.eventType,
      event.eventSubtype ?? "",
      event.status,
      event.actor ?? "",
      event.errorCode ?? "",
    ],
    doubles: [
      event.issueNumber ?? 0,
      event.runId ?? 0,
      event.durationMs ?? 0,
      event.isPrivate ? 1 : 0,
      event.isPullRequest ? 1 : 0,
    ],
  });
}

// Query Analytics Engine SQL API
// https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/
export async function queryAnalyticsEngine(
  env: Env,
  query: string,
): Promise<Record<string, unknown>[]> {
  const { CLOUDFLARE_ACCOUNT_ID, ANALYTICS_TOKEN } = env;
  if (!CLOUDFLARE_ACCOUNT_ID || !ANALYTICS_TOKEN) {
    throw new Error("Missing CLOUDFLARE_ACCOUNT_ID or ANALYTICS_TOKEN");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ANALYTICS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: query,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Analytics Engine query failed: ${response.status} ${text}`,
    );
  }

  const result = (await response.json()) as {
    data?: Record<string, unknown>[];
  };
  return result.data ?? [];
}

// Render ASCII bar chart from label/value pairs
export function renderBarChart(
  data: Record<string, unknown>[],
  title: string,
  labelKey: string,
  valueKey: string,
): string {
  if (!data.length) return "No data available";

  const labels = data.map((d) => String(d[labelKey] ?? ""));
  const values = data.map((d) => Number(d[valueKey]) || 0);

  const maxCount = Math.max(...values);
  const maxLabel = Math.max(...labels.map((l) => l.length));
  const barWidth = 40;

  const header = `${title}\n${"─".repeat(maxLabel + barWidth + 10)}\n`;
  const rows = data.map((_, i) => {
    const label = labels[i].padEnd(maxLabel);
    const barLen =
      maxCount > 0 ? Math.round((values[i] / maxCount) * barWidth) : 0;
    const bar = "█".repeat(barLen);
    return `${label} | ${bar.padEnd(barWidth)} | ${values[i]}`;
  });

  return header + rows.join("\n");
}

// Bundled SQL queries
export { eventsPerRepoQuery, errorsByRepoQuery, eventsByActorQuery };
