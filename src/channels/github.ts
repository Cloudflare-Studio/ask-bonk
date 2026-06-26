import { createGitHubChannel, type GitHubChannel } from "@flue/github";
import { handleGitHubDelivery } from "../app";
import type { Env } from "../types";

type GitHubChannelEnv = { Bindings: Env };

export function createGitHubWebhookChannel(webhookSecret: string) {
  return createGitHubChannel<GitHubChannelEnv>({
    webhookSecret,
    webhook: ({ c, delivery }) => handleGitHubDelivery(delivery, c.env),
  });
}

// Reuse upstream conversationKey/parseConversationKey behavior while replacing
// the route below so this sentinel secret is never used for webhook verification.
const conversationKeyChannel = createGitHubWebhookChannel("route-overridden");

// Resolve the secret from Worker bindings inside the handler. Secrets may not be
// available through process.env during module initialization, and global-scope
// fallbacks must not accept a public webhook secret.
export const channel: GitHubChannel<GitHubChannelEnv> = {
  ...conversationKeyChannel,
  routes: [
    {
      method: "POST",
      path: "/webhook",
      handler: async (c) => {
        const webhookSecret = c.env.GITHUB_WEBHOOK_SECRET;
        if (!webhookSecret) return new Response(null, { status: 401 });

        const webhookRoute = createGitHubWebhookChannel(webhookSecret).routes[0];
        if (!webhookRoute) {
          return new Response("GitHub webhook route is unavailable", { status: 500 });
        }
        return webhookRoute.handler(c, async () => undefined);
      },
    },
  ],
};
