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

let conversationKeyChannel: GitHubChannel<GitHubChannelEnv> | undefined;

function getConversationKeyChannel(): GitHubChannel<GitHubChannelEnv> {
  // Cloudflare rejects runtime-only APIs during module initialization. Create
  // the unguessable fallback lazily, and never mount its generated route.
  conversationKeyChannel ??= createGitHubWebhookChannel(crypto.randomUUID());
  return conversationKeyChannel;
}

// Resolve the secret from Worker bindings inside the handler. Secrets may not be
// available through process.env during module initialization, and global-scope
// fallbacks must not accept a public webhook secret.
export const channel: GitHubChannel<GitHubChannelEnv> = {
  conversationKey(ref) {
    return getConversationKeyChannel().conversationKey(ref);
  },
  parseConversationKey(id) {
    return getConversationKeyChannel().parseConversationKey(id);
  },
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
