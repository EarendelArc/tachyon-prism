import type { XrayTrafficStats } from "./runtime";
import type { TelemetryData } from "./telemetry";

export type TrafficCore = "tachyon" | "xray";
export type TrafficDirection = "up" | "down";

export interface TrafficSample {
  tachyonDown: number;
  tachyonUp: number;
  xrayDown: number;
  xrayUp: number;
}

export interface TrafficSourceState {
  tachyon: boolean;
  xray: boolean;
}

export interface OptionalNumberMetric {
  detail: string;
  known: boolean;
  value: number | null;
}

export interface TrafficTotals {
  activeConnections: OptionalNumberMetric;
  memoryBytes: OptionalNumberMetric;
  sources: TrafficSourceState;
  tachyonDown: number;
  tachyonUp: number;
  totalDown: number;
  totalUp: number;
  xrayDown: number;
  xrayUp: number;
}

export interface TrafficSeries {
  className: string;
  core: TrafficCore;
  direction: TrafficDirection;
  label: string;
  values: number[];
}

export interface TrafficSeriesLabels {
  tachyonDown: string;
  tachyonUp: string;
  xrayDown: string;
  xrayUp: string;
}

export function trafficTotalsFromSources(
  data: TelemetryData | null,
  xrayStats: XrayTrafficStats,
): TrafficTotals {
  const tachyonKnown = data !== null;
  const xrayTelemetryKnown =
    typeof data?.xray_bytes_sent === "number" || typeof data?.xray_bytes_received === "number";
  const xrayKnown =
    xrayTelemetryKnown ||
    xrayStats.queriedAt !== null ||
    xrayStats.bytesSent > 0 ||
    xrayStats.bytesReceived > 0;
  const tachyonUp = tachyonKnown ? nonNegative(data.tgp_bytes_sent ?? data.bytes_tgp ?? 0) : 0;
  const tachyonDown = tachyonKnown ? nonNegative(data.tgp_bytes_received ?? 0) : 0;
  const xrayUp = xrayKnown ? nonNegative(xrayStats.bytesSent || data?.xray_bytes_sent || 0) : 0;
  const xrayDown = xrayKnown
    ? nonNegative(xrayStats.bytesReceived || data?.xray_bytes_received || 0)
    : 0;

  return {
    activeConnections: tachyonKnown
      ? {
          detail: "tachyon-tgp-sessions",
          known: true,
          value: nonNegative(data.tgp_sessions),
        }
      : {
          detail: "tachyon-telemetry-unavailable",
          known: false,
          value: null,
        },
    memoryBytes: {
      detail: "process-memory-not-exposed",
      known: false,
      value: null,
    },
    sources: {
      tachyon: tachyonKnown,
      xray: xrayKnown,
    },
    tachyonDown,
    tachyonUp,
    totalDown: tachyonDown + xrayDown,
    totalUp: tachyonUp + xrayUp,
    xrayDown,
    xrayUp,
  };
}

export function hasTrafficSource(totals: TrafficTotals): boolean {
  return totals.sources.tachyon || totals.sources.xray;
}

export function hasTrafficBytes(totals: TrafficTotals): boolean {
  return (
    totals.tachyonDown > 0 ||
    totals.tachyonUp > 0 ||
    totals.totalDown > 0 ||
    totals.totalUp > 0 ||
    totals.xrayDown > 0 ||
    totals.xrayUp > 0
  );
}

export function emptyTrafficSample(): TrafficSample {
  return {
    tachyonDown: 0,
    tachyonUp: 0,
    xrayDown: 0,
    xrayUp: 0,
  };
}

export function emptyXrayTrafficStats(): XrayTrafficStats {
  return {
    bytesReceived: 0,
    bytesSent: 0,
    queriedAt: null,
  };
}

export function trafficRateSample(
  previous: TrafficTotals,
  current: TrafficTotals,
  elapsedMs: number,
): TrafficSample {
  const seconds = Math.max(elapsedMs / 1000, 0.1);
  return {
    tachyonDown: rateDelta(previous.tachyonDown, current.tachyonDown, seconds),
    tachyonUp: rateDelta(previous.tachyonUp, current.tachyonUp, seconds),
    xrayDown: rateDelta(previous.xrayDown, current.xrayDown, seconds),
    xrayUp: rateDelta(previous.xrayUp, current.xrayUp, seconds),
  };
}

export function trafficSeriesFromSamples(
  samples: TrafficSample[],
  labels: TrafficSeriesLabels,
): TrafficSeries[] {
  return [
    {
      className: "tachyon up",
      core: "tachyon",
      direction: "up",
      label: labels.tachyonUp,
      values: samples.map((item) => item.tachyonUp),
    },
    {
      className: "tachyon down",
      core: "tachyon",
      direction: "down",
      label: labels.tachyonDown,
      values: samples.map((item) => item.tachyonDown),
    },
    {
      className: "xray up",
      core: "xray",
      direction: "up",
      label: labels.xrayUp,
      values: samples.map((item) => item.xrayUp),
    },
    {
      className: "xray down",
      core: "xray",
      direction: "down",
      label: labels.xrayDown,
      values: samples.map((item) => item.xrayDown),
    },
  ];
}

function rateDelta(previous: number, current: number, seconds: number): number {
  return Math.max(0, current - previous) / seconds;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
