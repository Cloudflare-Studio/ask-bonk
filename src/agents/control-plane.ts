import { createAgent } from "@flue/runtime";

export default createAgent(() => ({
  model: "anthropic/claude-haiku-4-5",
  instructions: "Bonk control-plane anchor for Flue channel and Cloudflare target discovery.",
}));
