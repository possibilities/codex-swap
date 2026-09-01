import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSparkModel,
  meteredLaneHeadroom,
  SPARK_METERED_LANE,
} from "../../src/selection/metered-lane.ts";
import type { UsageMeasurement, UsageWindow } from "../../src/usage/types.ts";

function measurement(windows: UsageWindow[]): UsageMeasurement {
  return {
    schemaVersion: 1,
    probeKind: "direct-wham",
    windows,
    fetchedAt: "2026-09-01T00:00:00.000Z",
  };
}

function otherWindow(options: {
  usedPercent: number;
  limitName?: string;
  meteredFeature?: string;
}): UsageWindow {
  return {
    kind: "other",
    label: "5h",
    usedPercent: options.usedPercent,
    remainingPercent: 100 - options.usedPercent,
    ...(options.limitName !== undefined ? { limitName: options.limitName } : {}),
    ...(options.meteredFeature !== undefined
      ? { meteredFeature: options.meteredFeature }
      : {}),
  };
}

test("isSparkModel matches a normalized name containing 'spark'", () => {
  assert.equal(isSparkModel("gpt-5.3-codex-spark"), true);
  assert.equal(isSparkModel("GPT-5.3-CODEX-SPARK"), true);
  assert.equal(isSparkModel("codex-Spark-preview"), true);
  assert.equal(isSparkModel("gpt-5.3-codex"), false);
  assert.equal(isSparkModel(""), false);
});

test("no matching lane window is unavailable, not zero headroom", () => {
  const result = meteredLaneHeadroom(
    measurement([{ kind: "primary", label: "5h", usedPercent: 10, remainingPercent: 90 }]),
    SPARK_METERED_LANE,
  );
  assert.deepEqual(result, { kind: "unavailable" });
});

test("primary/secondary/code_review windows never satisfy a metered lane, even if tagged", () => {
  const result = meteredLaneHeadroom(
    measurement([
      {
        kind: "primary",
        label: "5h",
        usedPercent: 10,
        remainingPercent: 90,
        limitName: "codex-spark",
      },
      {
        kind: "code_review",
        label: "5h",
        usedPercent: 10,
        remainingPercent: 90,
        limitName: "codex-spark",
      },
    ]),
    SPARK_METERED_LANE,
  );
  assert.deepEqual(result, { kind: "unavailable" });
});

test("limitName identifies the lane and wins over a conflicting meteredFeature", () => {
  const result = meteredLaneHeadroom(
    measurement([
      otherWindow({ usedPercent: 30, limitName: "codex-spark", meteredFeature: "not-spark" }),
    ]),
    SPARK_METERED_LANE,
  );
  assert.deepEqual(result, { kind: "available", headroomPercent: 70 });
});

test("a limitName that does not match the lane refuses even when meteredFeature does", () => {
  const result = meteredLaneHeadroom(
    measurement([
      otherWindow({ usedPercent: 30, limitName: "not-spark", meteredFeature: "codex-spark" }),
    ]),
    SPARK_METERED_LANE,
  );
  assert.deepEqual(result, { kind: "unavailable" });
});

test("meteredFeature is consulted only when limitName is absent, case-insensitively", () => {
  const result = meteredLaneHeadroom(
    measurement([otherWindow({ usedPercent: 45, meteredFeature: "CODEX-SPARK" })]),
    SPARK_METERED_LANE,
  );
  assert.deepEqual(result, { kind: "available", headroomPercent: 55 });
});

test("headroom is the conservative minimum across every window in the lane", () => {
  const result = meteredLaneHeadroom(
    measurement([
      otherWindow({ usedPercent: 20, limitName: "codex-spark" }),
      otherWindow({ usedPercent: 80, limitName: "codex-spark" }),
    ]),
    SPARK_METERED_LANE,
  );
  assert.deepEqual(result, { kind: "available", headroomPercent: 20 });
});

test("full usage in any lane window is exhausted (zero headroom), not unavailable", () => {
  const result = meteredLaneHeadroom(
    measurement([
      otherWindow({ usedPercent: 10, limitName: "codex-spark" }),
      otherWindow({ usedPercent: 100, limitName: "codex-spark" }),
    ]),
    SPARK_METERED_LANE,
  );
  assert.deepEqual(result, { kind: "available", headroomPercent: 0 });
});
