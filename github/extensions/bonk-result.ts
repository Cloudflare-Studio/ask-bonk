import { Type } from "typebox";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Keep the extension independent of a repository dependency on Pi. The Action
// installs Pi globally, and this is the only API surface the extension uses.
interface ExtensionAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: unknown,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
    }>;
  }): void;
}

const MAX_BODY_LENGTH = 65_000;
const MAX_FINDINGS = 100;
const MAX_FINDING_BODY_LENGTH = 10_000;

export interface BonkFinding {
  path: string;
  line: number;
  endLine?: number;
  severity?: "info" | "warning" | "error";
  body: string;
}

export type BonkResult =
  | { kind: "answer"; body: string }
  | { kind: "review"; body: string; findings: BonkFinding[] }
  | {
      kind: "change";
      body: string;
      commitTitle?: string;
      pullRequestTitle?: string;
      pullRequestBody?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new Error(`${key} exceeds ${maxLength} characters`);
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string when provided`);
  }
  if (value.length > maxLength) throw new Error(`${key} exceeds ${maxLength} characters`);
  return value.trim();
}

function optionalTitle(record: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(record, key, 200);
  if (value?.includes("\n") || value?.includes("\r")) {
    throw new Error(`${key} must be a single line`);
  }
  return value;
}

function parseFinding(value: unknown): BonkFinding {
  if (!isRecord(value)) throw new Error("Each finding must be an object");
  const path = requiredString(value, "path", 1_000);
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Finding path must be repository-relative: ${path}`);
  }
  const line = value.line;
  if (!Number.isSafeInteger(line) || (line as number) < 1) {
    throw new Error("Finding line must be a positive integer");
  }
  const endLine = value.endLine;
  if (
    endLine !== undefined &&
    (!Number.isSafeInteger(endLine) || (endLine as number) < (line as number))
  ) {
    throw new Error("Finding endLine must be an integer greater than or equal to line");
  }
  const severity = value.severity;
  if (
    severity !== undefined &&
    severity !== "info" &&
    severity !== "warning" &&
    severity !== "error"
  ) {
    throw new Error("Finding severity must be info, warning, or error");
  }
  return {
    path,
    line: line as number,
    ...(endLine === undefined ? {} : { endLine: endLine as number }),
    ...(severity === undefined ? {} : { severity }),
    body: requiredString(value, "body", MAX_FINDING_BODY_LENGTH),
  };
}

export function parseBonkResult(value: unknown): BonkResult {
  if (!isRecord(value)) throw new Error("Bonk result must be an object");
  const kind = value.kind;
  const body = requiredString(value, "body", MAX_BODY_LENGTH);

  if (kind === "answer") return { kind, body };
  if (kind === "review") {
    if (!Array.isArray(value.findings)) throw new Error("Review findings must be an array");
    if (value.findings.length > MAX_FINDINGS) {
      throw new Error(`Review findings exceed the ${MAX_FINDINGS}-finding limit`);
    }
    return { kind, body, findings: value.findings.map(parseFinding) };
  }
  if (kind === "change") {
    return {
      kind,
      body,
      commitTitle: optionalTitle(value, "commitTitle"),
      pullRequestTitle: optionalTitle(value, "pullRequestTitle"),
      pullRequestBody: optionalString(value, "pullRequestBody", MAX_BODY_LENGTH),
    };
  }
  throw new Error("Bonk result kind must be answer, review, or change");
}

export default function bonkResultExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_result",
    label: "Submit Bonk result",
    description:
      "Submit the final structured result to the Bonk harness. Call this once after all inspection, edits, and validation. The harness—not Pi—publishes GitHub comments, reviews, commits, pushes, and pull requests. For reviews, findings must be discrete inline comments and body must not repeat them.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("answer"), Type.Literal("review"), Type.Literal("change")]),
      body: Type.String(),
      findings: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String(),
            line: Type.Integer({ minimum: 1 }),
            endLine: Type.Optional(Type.Integer({ minimum: 1 })),
            severity: Type.Optional(
              Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
            ),
            body: Type.String(),
          }),
        ),
      ),
      commitTitle: Type.Optional(Type.String()),
      pullRequestTitle: Type.Optional(Type.String()),
      pullRequestBody: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const result = parseBonkResult(params);
      const resultPath = process.env.BONK_RESULT_PATH;
      if (!resultPath) throw new Error("BONK_RESULT_PATH is not configured");

      mkdirSync(dirname(resultPath), { recursive: true });
      const temporaryPath = `${resultPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
      // Some Node-compatible filesystems do not honor the create mode passed
      // to writeFileSync, so enforce it before the atomic rename as well.
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, resultPath);

      return {
        content: [{ type: "text", text: `Structured ${result.kind} result accepted by Bonk.` }],
        details: { kind: result.kind },
      };
    },
  });
}
