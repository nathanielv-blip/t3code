import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import { kimiUsageFormat, kimiUsageReader } from "./kimiUsage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const status = {
  timestamp: 1793757885.812,
  message: {
    type: "StatusUpdate",
    payload: {
      context_tokens: 45455,
      token_usage: {
        input_other: 37519,
        output: 198,
        input_cache_read: 7936,
        input_cache_creation: 12,
      },
      message_id: "response-1",
    },
  },
};

describe("Kimi usage", () => {
  it("counts disjoint request tokens and preserves missing model attribution", () => {
    const state = { sessionId: "session-1" };
    expect(
      kimiUsageFormat.state?.initial("/home/.kimi/sessions/work/session-1/wire.jsonl"),
    ).toEqual(state);
    const records = kimiUsageFormat.parseLine(JSON.stringify(status), state);
    expect(records).toEqual([
      {
        provider: "kimi",
        timestampMs: 1793757885812,
        model: "unknown",
        sessionId: "session-1",
        totals: {
          uncachedInputTokens: 37519,
          cachedInputTokens: 7936,
          cacheCreationTokens: 12,
          outputTokens: 198,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: "kimi:response-1",
      },
    ]);
    expect(kimiUsageFormat.parseProjected(status, state)).toEqual(records);
    expect(
      kimiUsageFormat.parseLine(
        JSON.stringify({
          ...status,
          message: { type: "SubagentEvent", payload: { event: status.message } },
        }),
        state,
      ),
    ).toEqual([]);
    expect(
      kimiUsageFormat.parseLine(
        JSON.stringify({
          ...status,
          message: { type: "StatusUpdate", payload: { context_tokens: 99999, token_usage: null } },
        }),
        state,
      ),
    ).toEqual([]);
    expect(kimiUsageFormat.parseLine("malformed", state)).toEqual([]);
    expect(kimiUsageFormat.parseProjected({ ...status, timestamp: Infinity }, state)).toEqual([]);
  });

  it.effect("discovers Kimi homes without attributing other ACP agents' histories to Kimi", () =>
    Effect.gen(function* () {
      const config = decodeSettings({ agentId: "kimi" });
      const instance = {
        config,
        environment: { HOME: "/account", KIMI_SHARE_DIR: "~/custom-kimi" },
        configured: true,
        instanceId: ProviderInstanceId.make("kimi-test"),
      };
      expect(yield* kimiUsageReader.directories(instance)).toEqual([
        { dir: "/account/custom-kimi/sessions", fileName: "wire.jsonl" },
      ]);
      expect(
        yield* kimiUsageReader.directories({
          ...instance,
          config: { ...config, agentId: "other" },
        }),
      ).toEqual([]);
      expect(
        yield* kimiUsageReader.directories({ ...instance, environment: { HOME: "/account" } }),
      ).toEqual([
        { dir: "/account/.kimi/sessions", fileName: "wire.jsonl" },
        { dir: "/account/.kimi-code/sessions", fileName: "wire.jsonl" },
      ]);
    }).pipe(Effect.provide(Path.layer)),
  );
});
