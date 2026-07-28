"use agent";

import { useModel } from "@flue/runtime";

export function BonkControlPlane() {
  useModel("anthropic/claude-haiku-4-5");
  return "Bonk control-plane anchor for Flue channel and Cloudflare target discovery.";
}
