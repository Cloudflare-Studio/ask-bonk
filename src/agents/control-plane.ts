import { defineAgent } from "@flue/runtime";

export default defineAgent(() => ({
  model: "anthropic/claude-haiku-4-5",
  instructions: "Bonk control-plane anchor for Flue channel and Cloudflare target discovery.",
}));
