import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type {
  HelloData,
  TelemetryData,
  RouteEventData,
  TelemetryEvent,
  TelemetryState,
} from "../telemetry";
import { localizeTelemetryError, TelemetryClient } from "../telemetry";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

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

  it("polls telemetry only through the injected IPC poller", async () => {
    const poller = vi.fn().mockResolvedValue({
      events: [
        { type: "hello", seq: 1, ts: "now", data: { version: "0.1.0", platform: "windows" } },
        { type: "telemetry", seq: 2, ts: "now", data: { packets_read: 7 } },
      ],
    });
    const client = new TelemetryClient(poller);
    const states: TelemetryState[] = [];
    const unsub = client.subscribe((state) => states.push({ ...state }));
    client.connect();
    await vi.waitFor(() => expect(poller).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.getState().connection).toBe("connected"));

    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0].connection).toBe("connecting");
    expect(client.getState().hello?.version).toBe("0.1.0");
    expect(client.getState().latestTelemetry?.packets_read).toBe(7);

    unsub();
    client.disconnect();
  });

  it("unsubscribe stops notifications", () => {
    const client = new TelemetryClient(() => new Promise(() => undefined));
    let count = 0;
    const unsub = client.subscribe(() => count++);
    unsub();
    client.connect();
    expect(count).toBe(0);
    client.disconnect();
  });

  it("disconnect resets connection state", () => {
    const client = new TelemetryClient(() => new Promise(() => undefined));
    client.connect();
    client.disconnect();
    expect(client.getState().connection).toBe("disconnected");
  });

  it("backs off after IPC errors without exposing backend details", async () => {
    const poller = vi.fn().mockRejectedValue(new Error("tachyon-telemetry-connect-failed: sentinel"));
    const client = new TelemetryClient(poller);
    client.connect();
    await vi.waitFor(() => expect(client.getState().connection).toBe("disconnected"));
    expect(client.getState().recentErrors[0]).toEqual({
      message: "tachyon-telemetry-connect-failed",
      source: "telemetry-ipc",
    });
    expect(JSON.stringify(client.getState())).not.toContain("sentinel");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(poller).toHaveBeenCalledTimes(2));
    client.disconnect();
  });

  it("localizes stable IPC error codes", () => {
    expect(localizeTelemetryError("tachyon-telemetry-connect-failed", "zh-CN")).toContain("无法连接");
    expect(localizeTelemetryError("tachyon-telemetry-connect-failed", "en")).toContain("Could not connect");
    expect(localizeTelemetryError("unknown", "zh-CN")).toContain("不可用");
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
