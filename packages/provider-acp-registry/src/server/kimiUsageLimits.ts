import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { kimiHomes } from "./kimiUsage.ts";

const Detail = Schema.Struct({
  used_ratio: Schema.optional(Schema.Unknown),
  usedRatio: Schema.optional(Schema.Unknown),
  limit: Schema.optional(Schema.Unknown),
  used: Schema.optional(Schema.Unknown),
  remaining: Schema.optional(Schema.Unknown),
  reset_time: Schema.optional(Schema.String),
  resetTime: Schema.optional(Schema.String),
  resetAt: Schema.optional(Schema.String),
});
const UsageResponse = Schema.Struct({
  usages: Schema.optional(Schema.Record(Schema.String, Detail)),
  usage: Schema.optional(Detail),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        window: Schema.optional(
          Schema.Struct({ duration: Schema.Unknown, timeUnit: Schema.String }),
        ),
        detail: Detail,
      }),
    ),
  ),
});
const decodeResponse = Schema.decodeUnknownOption(UsageResponse);
const Credentials = Schema.Struct({ access_token: Schema.NonEmptyString });
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(Credentials));
const Claims = Schema.Struct({
  user_id: Schema.optional(Schema.String),
  sub: Schema.optional(Schema.String),
});
const decodeClaims = Schema.decodeUnknownOption(Claims);

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function windowFromDetail(
  id: string,
  detail: typeof Detail.Type,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  windowDurationMins?: number,
): ServerProviderUsageWindow | null {
  const ratio = numeric(detail.used_ratio ?? detail.usedRatio);
  const limit = numeric(detail.limit);
  const used = numeric(detail.used);
  const remaining = numeric(detail.remaining);
  const usedPercent =
    ratio === null
      ? limit !== null && limit > 0 && (used !== null || remaining !== null)
        ? ((used ?? limit - (remaining ?? 0)) / limit) * 100
        : null
      : ratio * 100;
  if (usedPercent === null || !Number.isFinite(usedPercent)) return null;
  const reset = DateTime.make(detail.reset_time ?? detail.resetTime ?? detail.resetAt ?? "");
  return {
    id,
    kind,
    label,
    usedPercent: clampPercent(usedPercent),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
    ...(windowDurationMins !== undefined && windowDurationMins > 0
      ? { windowDurationMins: Math.trunc(windowDurationMins) }
      : {}),
  };
}

export function kimiUsageResponseToLimits(
  value: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  const decoded = decodeResponse(value);
  if (Option.isNone(decoded))
    return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
  const response = decoded.value;
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, detail] of Object.entries(response.usages ?? {})) {
    const session = id === "limit_5h";
    const weekly = /week|7d/.test(id);
    const monthly = /month/.test(id);
    const window = windowFromDetail(
      id,
      detail,
      session ? "session" : weekly ? "weekly" : monthly ? "monthly" : "other",
      session
        ? "5-hour"
        : weekly
          ? "Weekly"
          : id === "limit_month_total"
            ? "Monthly total"
            : id === "limit_month_code"
              ? "Monthly coding"
              : id.replace(/^limit_/, "").replaceAll("_", " "),
      session ? 300 : weekly ? 10080 : undefined,
    );
    if (window) windows.push(window);
  }
  // The ratio map is authoritative; limits repeats its five-hour window with rounded counters.
  if (windows.length === 0) {
    if (response.usage) {
      const window = windowFromDetail("weekly", response.usage, "weekly", "Weekly", 10080);
      if (window) windows.push(window);
    }
    for (const [index, entry] of (response.limits ?? []).entries()) {
      const duration = numeric(entry.window?.duration);
      const unit = entry.window?.timeUnit ?? "";
      const minutes =
        duration === null
          ? undefined
          : /MINUTE/.test(unit)
            ? duration
            : /HOUR/.test(unit)
              ? duration * 60
              : /DAY/.test(unit)
                ? duration * 1440
                : undefined;
      const window = windowFromDetail(
        `limit_${index}`,
        entry.detail,
        minutes === 300 ? "session" : minutes === 10080 ? "weekly" : "other",
        minutes === 300 ? "5-hour" : minutes === 10080 ? "Weekly" : `Limit ${index + 1}`,
        minutes,
      );
      if (window) windows.push(window);
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
}

function accountFingerprint(token: string): string {
  let identity = token;
  try {
    const encoded = token.split(".")[1];
    if (encoded) {
      const claims = decodeClaims(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
      if (Option.isSome(claims)) identity = claims.value.user_id || claims.value.sub || token;
    }
  } catch {
    /* Opaque tokens can still deduplicate identical logins. */
  }
  return bytesToHex(sha256(new TextEncoder().encode(`kimi:${identity}`)));
}

export const readKimiUsageLimits = Effect.fn("readKimiUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unavailable = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Kimi could not read subscription limits. Refresh the Kimi CLI login and try again.",
  });
  const baseUrl = environment.KIMI_CODE_BASE_URL?.trim().replace(/\/+$/, "");
  if (
    (baseUrl && baseUrl !== "https://api.kimi.com/coding/v1") ||
    environment.KIMI_API_KEY?.trim() ||
    environment.MOONSHOT_API_KEY?.trim()
  ) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message:
        "Kimi subscription limits require the default Kimi Code endpoint and CLI account login.",
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const home of yield* kimiHomes(environment)) {
    const credentials = yield* fs
      .readFileString(path.join(home, "credentials", "kimi-code.json"))
      .pipe(Effect.flatMap(decodeCredentials), Effect.option);
    if (Option.isNone(credentials)) continue;
    const token = credentials.value.access_token;
    return yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.get("https://api.kimi.com/coding/v1/usages").pipe(
          HttpClientRequest.bearerToken(token),
        ),
      );
      const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(
        yield* HttpClientResponse.filterStatusOk(response),
      );
      return {
        ...kimiUsageResponseToLimits(body, checkedAt),
        credentialFingerprint: accountFingerprint(token),
      };
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => unavailable),
    );
  }
  return unavailable;
});
