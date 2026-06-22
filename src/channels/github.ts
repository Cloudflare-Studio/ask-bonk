import { createBonkGitHubChannel } from "../github-channel";
import { handleGitHubDelivery } from "../app";

// If the runtime secret binding is missing, use an unguessable value so the
// generated Flue webhook route fails closed instead of accepting a public secret.
const missingWebhookSecret = crypto.randomUUID();

export function createGitHubWebhookChannel(webhookSecret: string) {
  return createBonkGitHubChannel(webhookSecret, ({ c, delivery }) =>
    handleGitHubDelivery(delivery, c.env),
  );
}

export const channel = createGitHubWebhookChannel(
  process.env.GITHUB_WEBHOOK_SECRET || missingWebhookSecret,
);
