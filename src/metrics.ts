import type { Env } from "./types";
import eventsPerRepoQuery from "../ae_queries/events_per_repo.sql";

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

// Row shape returned by events_per_repo.sql query
interface EventsPerRepoRow {
  repo: string;
  event_type: string;
  event_count: number;
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

// Render ASCII bar chart for events per repo
export function renderBarChart(
  data: EventsPerRepoRow[],
  title: string,
): string {
  if (!data.length) return "No data available";

  const maxCount = Math.max(...data.map((d) => d.event_count));
  const maxLabel = Math.max(
    ...data.map((d) => `${d.repo} (${d.event_type})`.length),
  );
  const barWidth = 40;

  const header = `${title}\n${"─".repeat(maxLabel + barWidth + 10)}\n`;
  const rows = data.map((row) => {
    const label = `${row.repo} (${row.event_type})`.padEnd(maxLabel);
    const barLen =
      maxCount > 0 ? Math.round((row.event_count / maxCount) * barWidth) : 0;
    const bar = "█".repeat(barLen);
    return `${label} | ${bar.padEnd(barWidth)} | ${row.event_count}`;
  });

  return header + rows.join("\n");
}

// Bundled SQL query for events per repo
export { eventsPerRepoQuery };
