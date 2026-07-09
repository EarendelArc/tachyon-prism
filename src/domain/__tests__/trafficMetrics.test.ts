import { describe, expect, it } from "vitest";
import type { TelemetryData } from "../telemetry";
import {
  emptyXrayTrafficStats,
  hasTrafficSource,
  trafficRateSample,
  trafficSeriesFromSamples,
  trafficTotalsFromSources,
} from "../trafficMetrics";

const telemetry: TelemetryData = {
  decided_direct: 0,
  decided_drop: 0,
  decided_tgp: 1,
  goroutines: 8,
  handler_errors: 0,
  lookup_errors: 0,
  packets_read: 5,
  tgp_bytes_received: 1_500,
  tgp_bytes_sent: 2_000,
  tgp_sessions: 2,
  unsupported: 0,
};

describe("traffic metrics", () => {
  it("keeps overview metrics unknown when no real telemetry or stats source exists", () => {
    const totals = trafficTotalsFromSources(null, emptyXrayTrafficStats());

    expect(hasTrafficSource(totals)).toBe(false);
    expect(totals.totalUp).toBe(0);
    expect(totals.totalDown).toBe(0);
    expect(totals.activeConnections).toMatchObject({
      known: false,
      value: null,
    });
    expect(totals.memoryBytes).toMatchObject({
      detail: "process-memory-not-exposed",
      known: false,
      value: null,
    });
  });

  it("treats an xray stats query with zero bytes as a real zero source", () => {
    const totals = trafficTotalsFromSources(null, {
      bytesReceived: 0,
      bytesSent: 0,
      queriedAt: 1_789_999_001,
    });

    expect(hasTrafficSource(totals)).toBe(true);
    expect(totals.sources).toEqual({ tachyon: false, xray: true });
    expect(totals.totalUp).toBe(0);
    expect(totals.totalDown).toBe(0);
  });

  it("accepts legacy xray counters from telemetry as a real xray source", () => {
    const totals = trafficTotalsFromSources(
      {
        ...telemetry,
        xray_bytes_received: 4_096,
        xray_bytes_sent: 8_192,
      },
      emptyXrayTrafficStats(),
    );

    expect(totals.sources).toEqual({ tachyon: true, xray: true });
    expect(totals.xrayUp).toBe(8_192);
    expect(totals.xrayDown).toBe(4_096);
  });

  it("builds rates and chart series for both cores without assuming a single core", () => {
    const previous = trafficTotalsFromSources(telemetry, {
      bytesReceived: 4_096,
      bytesSent: 8_192,
      queriedAt: 1,
    });
    const current = trafficTotalsFromSources(
      {
        ...telemetry,
        tgp_bytes_received: 2_500,
        tgp_bytes_sent: 5_000,
      },
      {
        bytesReceived: 10_240,
        bytesSent: 20_480,
        queriedAt: 2,
      },
    );
    const sample = trafficRateSample(previous, current, 1_000);
    const series = trafficSeriesFromSamples([sample], {
      tachyonDown: "Tachyon down",
      tachyonUp: "Tachyon up",
      xrayDown: "Xray down",
      xrayUp: "Xray up",
    });

    expect(sample).toMatchObject({
      tachyonDown: 1_000,
      tachyonUp: 3_000,
      xrayDown: 6_144,
      xrayUp: 12_288,
    });
    expect(series.map((item) => `${item.core}:${item.direction}`)).toEqual([
      "tachyon:up",
      "tachyon:down",
      "xray:up",
      "xray:down",
    ]);
  });
});
