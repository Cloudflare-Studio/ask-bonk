import { createGitHubChannel, type GitHubWebhookHandlerInput } from "@flue/github";
import type { Env } from "./types";

export type GitHubChannelEnv = { Bindings: Env };

export function createBonkGitHubChannel(
  webhookSecret: string,
  webhook: (input: GitHubWebhookHandlerInput<GitHubChannelEnv>) => Promise<Response>,
) {
  return createGitHubChannel<GitHubChannelEnv>({
    webhookSecret,
    webhook,
  });
}
