import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings } from "../../src/config/schema.ts";
import { selectAccount, type SelectionInput } from "../../src/selection/selector.ts";
import type {
  AccountExclusionReason,
  SnapshotAccountView,
} from "../../src/snapshot/types.ts";

const SETTINGS = defaultSettings().selection;

function view(options: {
  accountKey: string;
  headroom?: number | null;
  exclusions?: AccountExclusionReason[];
  activeLeases?: number;
  priority?: number;
  weight?: number;
  maxConcurrent?: number | null;
  resetsAt?: string;
}): SnapshotAccountView {
  const headroom = options.headroom ?? null;
  const exclusions = options.exclusions ?? (headroom === null ? ["usage_unknown"] : []);
  return {
    accountKey: options.accountKey,
    providerAccountId: `${options.accountKey}-id`,
    email: `${options.accountKey}@x.com`,
    label: null,
    enabled: true,
    present: true,
    ndyIndex: 0,
    auth: { status: "ready", reloginRequired: false },
    identityConflict: false,
    policy: {
      manuallyDisabled: false,
      priority: options.priority ?? 0,
      weight: options.weight ?? 1,
      maxConcurrent: options.maxConcurrent ?? null,
    },
    usage: {
      status: headroom !== null ? "ok" : "unknown",
      decisionGrade: headroom !== null,
      measurement:
        headroom !== null
          ? {
              schemaVersion: 1,
              probeKind: "direct-wham",
              windows: [
                {
                  kind: "primary",
                  label: "5h",
                  usedPercent: 100 - headroom,
                  remainingPercent: headroom,
                  ...(options.resetsAt !== undefined
                    ? { resetsAt: options.resetsAt }
                    : {}),
                },
              ],
              fetchedAt: "2026-08-08T20:00:00.000Z",
            }
          : null,
      fetchedAt: null,
      ageSeconds: null,
      nextPollAt: null,
      pollIntervalMs: null,
      lastError: null,
    },
    lastGoodUsage: null,
    selection: {
      eligible: exclusions.length === 0,
      exclusions,
      headroomPercent: headroom,
      activeLeases: options.activeLeases ?? 0,
    },
  };
}

function input(
  accounts: SnapshotAccountView[],
  overrides?: Partial<SelectionInput>,
): SelectionInput {
  return {
    accounts,
    strategy: "best",
    settings: SETTINGS,
    allowUnknown: false,
    lastSelectedAccountKey: null,
    sequence: 0,
    ...overrides,
  };
}

test("best picks the highest trusted headroom", () => {
  const result = selectAccount(
    input([
      view({ accountKey: "record:a", headroom: 40 }),
      view({ accountKey: "record:b", headroom: 72 }),
      view({ accountKey: "record:c", headroom: 15 }),
    ]),
  );
  assert.equal(result.kind, "selected");
  if (result.kind === "selected") {
    assert.equal(result.accountKey, "record:b");
    assert.equal(result.reason.headroomPercent, 72);
  }
});

test("unknown usage cannot win automatically; allow-unknown scores it at zero", () => {
  const strict = selectAccount(
    input([
      view({ accountKey: "record:known", headroom: 5 }),
      view({ accountKey: "record:mystery", headroom: null }),
    ]),
  );
  assert.equal(strict.kind, "selected");
  if (strict.kind === "selected") {
    assert.equal(strict.accountKey, "record:known", "known beats unknown");
  }

  const allowed = selectAccount(
    input(
      [
        view({ accountKey: "record:known", headroom: 5 }),
        view({ accountKey: "record:mystery", headroom: null }),
      ],
      { allowUnknown: true },
    ),
  );
  assert.equal(allowed.kind, "selected");
  if (allowed.kind === "selected") {
    assert.equal(allowed.accountKey, "record:known", "known still beats unknown");
  }

  const onlyUnknown = selectAccount(
    input([view({ accountKey: "record:mystery", headroom: null })], {
      allowUnknown: true,
    }),
  );
  assert.equal(onlyUnknown.kind, "selected");
});

test("all unknown returns none/all_unknown; empty pool returns no_accounts", () => {
  const unknown = selectAccount(
    input([
      view({ accountKey: "record:a", headroom: null }),
      view({ accountKey: "record:b", headroom: null }),
    ]),
  );
  assert.equal(unknown.kind, "none");
  if (unknown.kind === "none") {
    assert.equal(unknown.reason, "all_unknown");
    assert.equal(unknown.exclusions.length, 2);
  }

  const empty = selectAccount(input([]));
  assert.equal(empty.kind, "none");
  if (empty.kind === "none") assert.equal(empty.reason, "no_accounts");
});

test("all exhausted returns the earliest credible recovery", () => {
  const result = selectAccount(
    input([
      view({
        accountKey: "record:a",
        headroom: 0,
        exclusions: ["quota_exhausted"],
        resetsAt: "2026-08-09T02:00:00.000Z",
      }),
      view({
        accountKey: "record:b",
        headroom: 0,
        exclusions: ["quota_exhausted"],
        resetsAt: "2026-08-09T01:00:00.000Z",
      }),
    ]),
  );
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "all_exhausted");
    assert.equal(result.nextReadyAt, "2026-08-09T01:00:00.000Z");
  }
});

test("priority and weight cannot resurrect an excluded account", () => {
  const result = selectAccount(
    input([
      view({
        accountKey: "record:vip",
        headroom: 90,
        exclusions: ["manually_disabled"],
        priority: 1000,
        weight: 100,
      }),
      view({ accountKey: "record:normal", headroom: 10 }),
    ]),
  );
  assert.equal(result.kind, "selected");
  if (result.kind === "selected") {
    assert.equal(result.accountKey, "record:normal");
    const vip = result.exclusions.find((e) => e.accountKey === "record:vip");
    assert.deepEqual(vip?.exclusions, ["manually_disabled"]);
  }
});

test("active leases penalize; max concurrency excludes outright", () => {
  const penalized = selectAccount(
    input([
      view({ accountKey: "record:busy", headroom: 60, activeLeases: 3 }),
      view({ accountKey: "record:idle", headroom: 45 }),
    ]),
  );
  assert.equal(penalized.kind, "selected");
  if (penalized.kind === "selected") {
    // 60 - 3*10 = 30 < 45: the idle account wins.
    assert.equal(penalized.accountKey, "record:idle");
  }

  const capped = selectAccount(
    input([
      view({ accountKey: "record:capped", headroom: 90, activeLeases: 1, maxConcurrent: 1 }),
      view({ accountKey: "record:free", headroom: 20 }),
    ]),
  );
  assert.equal(capped.kind, "selected");
  if (capped.kind === "selected") {
    assert.equal(capped.accountKey, "record:free");
    const excluded = capped.exclusions.find((e) => e.accountKey === "record:capped");
    assert.ok(excluded?.exclusions.includes("max_concurrent_reached"));
  }
});

test("near-equal candidates rotate fairly instead of ping-ponging", () => {
  const accounts = [
    view({ accountKey: "record:a", headroom: 50 }),
    view({ accountKey: "record:b", headroom: 50 }),
    view({ accountKey: "record:c", headroom: 50 }),
  ];
  const first = selectAccount(
    input(accounts, { lastSelectedAccountKey: "record:a", sequence: 1 }),
  );
  assert.equal(first.kind, "selected");
  if (first.kind === "selected") {
    assert.equal(first.accountKey, "record:b", "advances past last selected");
    assert.equal(first.reason.tieBreak, "rotation");
  }
  const wrap = selectAccount(
    input(accounts, { lastSelectedAccountKey: "record:c", sequence: 5 }),
  );
  assert.equal(wrap.kind, "selected");
  if (wrap.kind === "selected") {
    assert.equal(wrap.accountKey, "record:a", "wraps around the tied set");
  }
});

test("next-available rotates in stable order, skipping excluded accounts", () => {
  const accounts = [
    view({ accountKey: "record:a", headroom: 10 }),
    view({ accountKey: "record:b", headroom: 90, exclusions: ["quota_exhausted"] }),
    view({ accountKey: "record:c", headroom: 30 }),
  ];
  const fromA = selectAccount(
    input(accounts, { strategy: "next-available", lastSelectedAccountKey: "record:a" }),
  );
  assert.equal(fromA.kind, "selected");
  if (fromA.kind === "selected") {
    assert.equal(fromA.accountKey, "record:c", "skips the exhausted account");
  }
  const fromC = selectAccount(
    input(accounts, { strategy: "next-available", lastSelectedAccountKey: "record:c" }),
  );
  assert.equal(fromC.kind, "selected");
  if (fromC.kind === "selected") {
    assert.equal(fromC.accountKey, "record:a", "wraps to the first eligible");
  }
});

test("disabled and quarantined pools report their dominant blocking reason", () => {
  const disabled = selectAccount(
    input([
      view({ accountKey: "record:a", headroom: 50, exclusions: ["ndy_disabled"] }),
      view({ accountKey: "record:b", headroom: 50, exclusions: ["manually_disabled"] }),
    ]),
  );
  assert.equal(disabled.kind, "none");
  if (disabled.kind === "none") assert.equal(disabled.reason, "all_disabled");

  const quarantined = selectAccount(
    input([
      view({ accountKey: "record:a", headroom: null, exclusions: ["relogin_required"] }),
    ]),
  );
  assert.equal(quarantined.kind, "none");
  if (quarantined.kind === "none") assert.equal(quarantined.reason, "all_quarantined");
});

test("a family block excludes its account and the rest of the pool competes", () => {
  const result = selectAccount(
    input(
      [
        view({ accountKey: "record:a", headroom: 99 }),
        view({ accountKey: "record:b", headroom: 60 }),
      ],
      {
        familyBlocks: new Map([
          ["record:a", { family: "gpt-5.2", untilMs: Date.parse("2026-08-17T13:44:41Z") }],
        ]),
      },
    ),
  );
  assert.equal(result.kind, "selected");
  if (result.kind === "selected") {
    assert.equal(result.accountKey, "record:b");
    assert.deepEqual(result.exclusions, [
      { accountKey: "record:a", exclusions: ["family_rate_limited"] },
    ]);
  }
});

test("a fully family-blocked pool refuses with the recorded reset as recovery", () => {
  const untilMs = Date.parse("2026-08-17T13:44:41Z");
  const result = selectAccount(
    input(
      [
        view({ accountKey: "record:a", headroom: 99 }),
        view({ accountKey: "record:b", headroom: 60 }),
      ],
      {
        familyBlocks: new Map([
          ["record:a", { family: "gpt-5.2", untilMs }],
          ["record:b", { family: "gpt-5.2", untilMs: untilMs + 60_000 }],
        ]),
      },
    ),
  );
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "all_family_blocked");
    assert.equal(result.nextReadyAt, new Date(untilMs).toISOString());
  }
});

test("family blocks stack with other exclusions without masking exhaustion", () => {
  const result = selectAccount(
    input(
      [
        view({
          accountKey: "record:a",
          headroom: 0,
          exclusions: ["quota_exhausted"],
          resetsAt: "2026-08-16T06:00:00.000Z",
        }),
      ],
      {
        familyBlocks: new Map([
          ["record:a", { family: "gpt-5.2", untilMs: Date.parse("2026-08-17T13:44:41Z") }],
        ]),
      },
    ),
  );
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "all_exhausted");
    assert.deepEqual(result.exclusions, [
      { accountKey: "record:a", exclusions: ["quota_exhausted", "family_rate_limited"] },
    ]);
    // The earlier quota reset wins as the credible recovery time.
    assert.equal(result.nextReadyAt, "2026-08-16T06:00:00.000Z");
  }
});
