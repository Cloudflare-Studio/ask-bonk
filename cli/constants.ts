/**
 * Shared constants for the Bonk CLI
 */

export const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || "ask-bonk";
export const GITHUB_APP_URL = process.env.GITHUB_APP_URL || `https://github.com/apps/${GITHUB_APP_SLUG}`;
export const OIDC_BASE_URL = process.env.OIDC_BASE_URL || "https://ask-bonk.silverlock.workers.dev/auth";
export const BONK_REPO = process.env.BONK_REPO || "ask-bonk/ask-bonk";
export const DEFAULT_MODEL = "opencode/claude-opus-4-5";
export const BOT_MENTION = process.env.BOT_MENTION || "@ask-bonk";
export const BOT_COMMAND = process.env.BOT_COMMAND || "/bonk";
