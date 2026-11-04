import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { AcpRegistrySettings } from "../settings.ts";

export function isKimiAgent(config: AcpRegistrySettings | undefined): boolean {
  return config?.source === "local"
    ? /(?:^|[/\\])kimi(?:\.exe)?$/.test(config.commandPath)
    : config?.agentId === "kimi";
}

export const kimiHomes = Effect.fn("kimiHomes")(function* (environment: NodeJS.ProcessEnv) {
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
  const override = environment.KIMI_CODE_HOME?.trim() || environment.KIMI_SHARE_DIR?.trim();
  return override
    ? [path.resolve(expandHomePath(override, home))]
    : [path.join(home, ".kimi"), path.join(home, ".kimi-code")];
});

const State = Schema.Struct({ sessionId: Schema.String });
const Status = Schema.Struct({
  timestamp: Schema.Number,
  message: Schema.Struct({
    type: Schema.Literal("StatusUpdate"),
    payload: Schema.Struct({
      model: Schema.optional(Schema.NonEmptyString),
      message_id: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
      token_usage: Schema.Struct({
        input_other: Schema.optional(Schema.Unknown),
        input_cache_read: Schema.optional(Schema.Unknown),
        input_cache_creation: Schema.optional(Schema.Unknown),
        output: Schema.optional(Schema.Unknown),
      }),
    }),
  }),
});
const decodeStatus = Schema.decodeUnknownOption(Status);

function parseRecord(value: unknown, state: typeof State.Type): readonly UsageRecord[] {
  const decoded = decodeStatus(value);
  if (Option.isNone(decoded)) return [];
  const {
    timestamp,
    message: { payload },
  } = decoded.value;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return [];
  const usage = payload.token_usage;
  const totals = {
    // Kimi's input_other excludes both cache counters; context_tokens is not billable usage.
    uncachedInputTokens: tokenCount(usage.input_other),
    cachedInputTokens: tokenCount(usage.input_cache_read),
    cacheCreationTokens: tokenCount(usage.input_cache_creation),
    outputTokens: tokenCount(usage.output),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "kimi",
      timestampMs: timestamp * 1000,
      // Older wire logs omit the model; today's default cannot identify historical requests.
      model: payload.model ?? "unknown",
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: payload.message_id ? `kimi:${payload.message_id}` : null,
    },
  ];
}

export const kimiUsageFormat: TranscriptUsageFormat<typeof State.Type> = {
  selectFields: {
    timestamp: true,
    message: {
      type: true,
      payload: {
        model: true,
        message_id: true,
        token_usage: {
          input_other: true,
          input_cache_read: true,
          input_cache_creation: true,
          output: true,
        },
      },
    },
  },
  usageMarkers: ["StatusUpdate"],
  sharedSessionsAcrossFiles: true,
  state: {
    schema: State,
    initial: (filePath) => ({ sessionId: filePath?.replace(/\\/g, "/").split("/").at(-2) ?? "" }),
  },
  parseLine: (line, state) => {
    try {
      return parseRecord(JSON.parse(line), state);
    } catch {
      return [];
    }
  },
  parseProjected: parseRecord,
};

export const kimiUsageReader: Extract<
  ProviderUsageReader<AcpRegistrySettings, Path.Path>,
  { readonly kind: "transcripts" }
> = {
  kind: "transcripts",
  provider: "kimi",
  format: kimiUsageFormat,
  directories: Effect.fn("kimiUsageReader.directories")(function* ({
    config,
    environment,
    configured,
  }) {
    if (configured && !isKimiAgent(config)) return [];
    const path = yield* Path.Path;
    const homes = yield* kimiHomes(environment);
    return homes.map((home) => ({ dir: path.join(home, "sessions"), fileName: "wire.jsonl" }));
  }),
};
