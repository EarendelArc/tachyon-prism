import { describe, expect, it } from "vitest";
import { buildXrayOutboundDraft, parseSubscription } from "../subscriptions";

const liveSubscriptionUrl = process.env.TACHYON_LIVE_SUBSCRIPTION_URL?.trim();
const liveIt = liveSubscriptionUrl ? it : it.skip;

describe("live subscription smoke", () => {
  liveIt("fetches and parses a real subscription without exposing node details", async () => {
    const response = await fetch(liveSubscriptionUrl!, {
      headers: {
        accept: "text/plain, application/json, application/octet-stream, */*",
        "user-agent": "Tachyon-Prism/0.1",
      },
    });
    expect(response.ok).toBe(true);

    const nodes = parseSubscription(await response.text());
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.protocol).not.toBe("unknown");
      expect(() => buildXrayOutboundDraft(node)).not.toThrow();
    }
  });
});
