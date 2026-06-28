import { beforeEach, describe, it, expect } from "vitest";
import type {
  HelloData,
  TelemetryData,
  RouteEventData,
  TelemetryEvent,
  TelemetryState,
} from "../telemetry";
import { TelemetryClient } from "../telemetry";

class MockEventSource {
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {}

  addEventListener(): void {
    // Tests in this file assert connection state transitions only.
  }

  close(): void {
    // no-op
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: MockEventSource,
  });
});

describe("TelemetryClient", () => {
  it("starts in disconnected state", () => {
    const client = new TelemetryClient();
    const state = client.getState();
    expect(state.connection).toBe("disconnected");
    expect(state.hello).toBeNull();
    expect(state.latestTelemetry).toBeNull();
    expect(state.recentRoutes).toEqual([]);
    expect(state.recentErrors).toEqual([]);
  });

  it("notifies listeners on state change", () => {
    const client = new TelemetryClient();
    const states: TelemetryState[] = [];
    const unsub = client.subscribe((state) => states.push({ ...state }));

    // connect() will set to "connecting" (EventSource not available in test env,
    // so it will immediately error, but the state transition still fires).
    client.connect();

    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0].connection).toBe("connecting");

    unsub();
  });

  it("unsubscribe stops notifications", () => {
    const client = new TelemetryClient();
    let count = 0;
    const unsub = client.subscribe(() => count++);
    unsub();
    client.connect();
    expect(count).toBe(0);
  });

  it("disconnect resets connection state", () => {
    const client = new TelemetryClient();
    client.disconnect();
    expect(client.getState().connection).toBe("disconnected");
  });
});

describe("TelemetryEvent types", () => {
  it("hello event has correct shape", () => {
    const data: HelloData = {
      version: "0.1.0",
      platform: "windows/amd64",
    };
    expect(data.version).toBe("0.1.0");
    expect(data.platform).toBe("windows/amd64");
  });

  it("telemetry data has all counters", () => {
    const data: TelemetryData = {
      packets_read: 1000,
      bytes_read: 65536,
      bytes_tgp: 49152,
      bytes_direct: 12288,
      bytes_drop: 4096,
      tgp_bytes_sent: 32768,
      tgp_bytes_received: 16384,
      xray_bytes_sent: 8192,
      xray_bytes_received: 4096,
      unsupported: 5,
      lookup_errors: 10,
      decided_tgp: 600,
      decided_direct: 300,
      decided_drop: 85,
      handler_errors: 2,
      tgp_sessions: 1,
      goroutines: 42,
    };
    expect(data.packets_read).toBe(1000);
    expect(data.bytes_tgp).toBe(49152);
    expect(data.tgp_bytes_sent).toBe(32768);
    expect(data.xray_bytes_received).toBe(4096);
    expect(data.tgp_sessions).toBe(1);
    expect(data.goroutines).toBe(42);
  });

  it("route event has correct shape", () => {
    const data: RouteEventData = {
      process_name: "cs2.exe",
      pid: 9832,
      src: "198.18.0.2:57392",
      dst: "162.254.195.4:27015",
      proto: "udp",
      decision: "tgp",
      rule_matched: "process:cs2.exe",
    };
    expect(data.process_name).toBe("cs2.exe");
    expect(data.decision).toBe("tgp");
  });
});
