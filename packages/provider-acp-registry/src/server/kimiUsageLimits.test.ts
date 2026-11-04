import { ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as Schema from "effect/Schema";
import { buildCheckedAcpRegistrySnapshot } from "./driver.ts";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  kimiUsageResponseToLimits,
  readKimiUsageLimits,
  withKimiUsageLimits,
} from "./kimiUsageLimits.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const checkedAt = "2026-11-04T02:00:00.000Z";
const response = {
  usages: {
    limit_5h: { used_ratio: 0.4341, reset_time: "2026-11-04T06:41:17Z" },
    limit_month_total: { used_ratio: 0.0673, reset_time: "2026-12-05T00:00:00Z" },
    limit_month_code: { used_ratio: 0.0535, reset_time: "2026-12-05T00:00:00Z" },
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "43" },
    },
  ],
};

describe("Kimi subscription limits", () => {
  it("prefers precise ratios to duplicate rounded counters and retains each allowance", () => {
    expect(kimiUsageResponseToLimits(response, checkedAt)).toEqual({
      checkedAt,
      windows: [
        {
          id: "limit_5h",
          kind: "session",
          label: "5-hour",
          usedPercent: 43.41,
          resetsAt: "2026-11-04T06:41:17.000Z",
          windowDurationMins: 300,
        },
        {
          id: "limit_month_code",
          kind: "monthly",
          label: "Monthly coding",
          usedPercent: 5.35,
          resetsAt: "2026-12-05T00:00:00.000Z",
        },
        {
          id: "limit_month_total",
          kind: "monthly",
          label: "Monthly total",
          usedPercent: expect.closeTo(6.73, 8),
          resetsAt: "2026-12-05T00:00:00.000Z",
        },
      ],
    });
  });

  it("reads legacy numeric-string counters without inventing zero usage or reset times", () => {
    const limits = kimiUsageResponseToLimits(
      {
        usage: { limit: "100", remaining: "75", resetTime: "invalid" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", remaining: "0" },
          },
          { detail: { limit: "0", used: "4" } },
          { detail: { limit: "100" } },
        ],
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "limit_0",
        kind: "session",
        label: "5-hour",
        usedPercent: 100,
        windowDurationMins: 300,
      },
      { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 25, windowDurationMins: 10080 },
    ]);
    expect(
      kimiUsageResponseToLimits({ usages: { limit_5h: { used_ratio: Infinity } } }, checkedAt)
        .windows,
    ).toEqual([]);
    expect(
      kimiUsageResponseToLimits({ usages: { limit_5h: { used_ratio: 1.5 } } }, checkedAt).windows[0]
        ?.usedPercent,
    ).toBe(100);
    expect(kimiUsageResponseToLimits(null, checkedAt).unavailable?.reason).toBe("probeFailed");
  });

  it.effect(
    "reads the selected home, authenticates only to Kimi, and deduplicates refreshed account tokens",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const home = path.join(directory, "kimi-home");
        yield* fs.makeDirectory(path.join(home, "credentials"), { recursive: true });
        const client = HttpClient.make((request) => {
          expect(request.url).toBe("https://api.kimi.com/coding/v1/usages");
          expect(request.headers.authorization).toMatch(/^Bearer header\./);
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response)));
        });
        const fingerprints: (string | undefined)[] = [];
        for (const suffix of ["old", "new"]) {
          const token = `header.${Buffer.from(JSON.stringify({ user_id: "account-1", token_id: suffix })).toString("base64url")}.${suffix}`;
          yield* fs.writeFileString(
            path.join(home, "credentials", "kimi-code.json"),
            JSON.stringify({ access_token: token }),
          );
          const limits = yield* readKimiUsageLimits({ HOME: directory, KIMI_SHARE_DIR: home }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          );
          expect(limits.windows).toHaveLength(3);
          expect(limits.credentialFingerprint).not.toContain("account-1");
          fingerprints.push(limits.credentialFingerprint);
        }
        expect(fingerprints[0]).toBe(fingerprints[1]);
        expect(fingerprints[0]).toMatch(/^[a-f0-9]{64}$/);
        const settings = decodeSettings({ agentId: "kimi" });
        const provider = buildCheckedAcpRegistrySnapshot({
          instanceId: ProviderInstanceId.make("kimi-test"),
          displayName: undefined,
          accentColor: undefined,
          continuationKey: "kimi-test",
          settings,
          checkedAt,
          inspection: { status: "ready", agentId: "kimi", version: "1", distribution: "binary" },
        });
        expect(provider.auth.status).toBe("unknown");
        const enriched = yield* withKimiUsageLimits(
          provider,
          settings,
          { KIMI_SHARE_DIR: home },
          Effect.succeed(true),
        ).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(enriched.usageLimits?.windows).toHaveLength(3);
        for (const candidate of [
          provider,
          { ...provider, auth: { status: "unauthenticated" as const } },
        ]) {
          const skipped = yield* withKimiUsageLimits(
            candidate,
            settings,
            { KIMI_SHARE_DIR: home },
            Effect.succeed(false),
          ).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not probe an unconfirmed account")),
            ),
          );
          expect(skipped.usageLimits).toBeUndefined();
        }
        const refused = HttpClient.make(() =>
          Effect.die("must not send CLI credentials to a custom endpoint"),
        );
        for (const environment of [
          { KIMI_CODE_BASE_URL: "https://proxy.example" },
          { KIMI_API_KEY: "explicit-api-key" },
        ]) {
          expect(
            (yield* readKimiUsageLimits({ ...environment, KIMI_SHARE_DIR: home }).pipe(
              Effect.provideService(HttpClient.HttpClient, refused),
            )).unavailable?.reason,
          ).toBe("unsupported");
        }
        expect(
          (yield* readKimiUsageLimits({ KIMI_SHARE_DIR: path.join(directory, "missing") }).pipe(
            Effect.provideService(HttpClient.HttpClient, refused),
          )).unavailable?.reason,
        ).toBe("probeFailed");
        const unauthorized = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("Unauthorized", { status: 401 })),
          ),
        );
        expect(
          (yield* readKimiUsageLimits({ KIMI_SHARE_DIR: home }).pipe(
            Effect.provideService(HttpClient.HttpClient, unauthorized),
          )).unavailable?.reason,
        ).toBe("probeFailed");
        yield* fs.writeFileString(
          path.join(home, "credentials", "kimi-code.json"),
          JSON.stringify({ access_token: "expired-token" }),
        );
        const refresh = fs
          .writeFileString(
            path.join(home, "credentials", "kimi-code.json"),
            JSON.stringify({ access_token: "refreshed-token" }),
          )
          .pipe(Effect.orDie);
        let requests = 0;
        const retryClient = HttpClient.make((request) => {
          requests++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.headers.authorization === "Bearer expired-token"
                ? new Response("Unauthorized", { status: 401 })
                : Response.json(response),
            ),
          );
        });
        const renewed = yield* readKimiUsageLimits({ KIMI_SHARE_DIR: home }, refresh).pipe(
          Effect.provideService(HttpClient.HttpClient, retryClient),
        );
        expect(renewed.windows).toHaveLength(3);
        expect(requests).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
