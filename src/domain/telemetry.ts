/**
 * Telemetry domain module for consuming the Core SSE telemetry stream.
 *
 * Polls a Tauri IPC command which owns the Core SSE connection. The renderer
 * never receives permission to connect to arbitrary loopback ports.
 */

import { invokeDesktop, isTauriRuntime } from "./tauri";

// ---------------------------------------------------------------------------
// Event types (match Core observability package)
// ---------------------------------------------------------------------------

export type TelemetryEventType =
  | "hello"
  | "telemetry"
  | "route_event"
  | "tgp_session"
  | "error";

export interface HelloData {
  version: string;
  platform: string;
  config_path?: string;
}

export interface TelemetryData {
  packets_read: number;
  bytes_read?: number;
  bytes_tgp?: number;
  bytes_direct?: number;
  bytes_drop?: number;
  tgp_bytes_sent?: number;
  tgp_bytes_received?: number;
  xray_bytes_sent?: number;
  xray_bytes_received?: number;
  unsupported: number;
  lookup_errors: number;
  decided_tgp: number;
  decided_direct: number;
  decided_drop: number;
  handler_errors: number;
  tgp_sessions: number;
  goroutines: number;
}

export interface RouteEventData {
  process_name: string;
  pid?: number;
  src: string;
  dst: string;
  proto: string;
  decision: string;
  rule_matched: string;
}

export interface TGPSessionEvent {
  state: string;
  remote: string;
  session?: string;
}

export interface ErrorData {
  message: string;
  source?: string;
}

export interface TelemetryEvent {
  type: TelemetryEventType;
  seq: number;
  ts: string;
  data: HelloData | TelemetryData | RouteEventData | TGPSessionEvent | ErrorData;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface TelemetryState {
  connection: ConnectionState;
  hello: HelloData | null;
  latestTelemetry: TelemetryData | null;
  recentRoutes: RouteEventData[];
  recentErrors: ErrorData[];
}

const MAX_RECENT_ROUTES = 50;
const MAX_RECENT_ERRORS = 20;

// ---------------------------------------------------------------------------
// Telemetry client
// ---------------------------------------------------------------------------

export type TelemetryListener = (state: TelemetryState) => void;
export interface TelemetryPoll {
  events: TelemetryEvent[];
}
export type TelemetryPoller = () => Promise<TelemetryPoll>;

export type TelemetryLanguage = "zh-CN" | "en";

export function localizeTelemetryError(code: string, language: TelemetryLanguage): string {
  const normalized = code.startsWith("tachyon-telemetry-")
    ? code.split(":", 1)[0]
    : "tachyon-telemetry-unavailable";
  const messages: Record<string, Record<TelemetryLanguage, string>> = {
    "tachyon-telemetry-connect-failed": {
      "zh-CN": "无法连接 Tachyon Core 遥测服务",
      en: "Could not connect to Tachyon Core telemetry",
    },
    "tachyon-telemetry-invalid-content-type": {
      "zh-CN": "Tachyon Core 返回了无效的遥测响应",
      en: "Tachyon Core returned an invalid telemetry response",
    },
    "tachyon-telemetry-invalid-event": {
      "zh-CN": "Tachyon Core 返回了损坏的遥测事件",
      en: "Tachyon Core returned a malformed telemetry event",
    },
    "tachyon-telemetry-unavailable": {
      "zh-CN": "Tachyon Core 遥测当前不可用",
      en: "Tachyon Core telemetry is unavailable",
    },
  };
  return (messages[normalized] ?? messages["tachyon-telemetry-unavailable"])[language];
}

/**
 * TelemetryClient connects to the Core SSE stream and maintains a reactive
 * state snapshot. Call `connect()` to start, `disconnect()` to stop.
 */
export class TelemetryClient {
  private state: TelemetryState = {
    connection: "disconnected",
    hello: null,
    latestTelemetry: null,
    recentRoutes: [],
    recentErrors: [],
  };
  private listeners: Set<TelemetryListener> = new Set();
  private readonly poller: TelemetryPoller;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollGeneration = 0;
  private polling = false;

  constructor(poller: TelemetryPoller = defaultTelemetryPoller) {
    this.poller = poller;
  }

  getState(): TelemetryState {
    return { ...this.state };
  }

  subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    this.closed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.polling) {
      return;
    }
    this.updateState({ connection: "connecting" });
    const generation = ++this.pollGeneration;
    this.polling = true;
    void this.poll(generation);
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pollGeneration++;
    this.polling = false;
    this.reconnectAttempt = 0;
    this.updateState({ connection: "disconnected" });
  }

  private updateState(patch: Partial<TelemetryState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // Listener errors should not break the stream.
      }
    }
  }

  private async poll(generation: number): Promise<void> {
    try {
      const batch = await this.poller();
      if (this.closed || generation !== this.pollGeneration) return;
      this.reconnectAttempt = 0;
      for (const event of batch.events) this.applyEvent(event);
      this.updateState({ connection: "connected" });
      this.schedulePoll(generation, 0);
    } catch (error) {
      if (this.closed || generation !== this.pollGeneration) return;
      const code = normalizeTelemetryError(error);
      const previous = this.state.recentErrors[0];
      this.updateState({
        connection: "disconnected",
        recentErrors:
          previous?.source === "telemetry-ipc" && previous.message === code
            ? this.state.recentErrors
            : [{ message: code, source: "telemetry-ipc" }, ...this.state.recentErrors].slice(
                0,
                MAX_RECENT_ERRORS,
              ),
      });
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
      this.reconnectAttempt++;
      this.schedulePoll(generation, delay);
    } finally {
      if (generation === this.pollGeneration) this.polling = false;
    }
  }

  private schedulePoll(generation: number, delay: number): void {
    if (this.closed || generation !== this.pollGeneration) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || generation !== this.pollGeneration || this.polling) return;
      this.polling = true;
      void this.poll(generation);
    }, delay);
  }

  private applyEvent(event: TelemetryEvent): void {
    if (event.type === "hello") {
      this.updateState({ hello: event.data as HelloData });
    } else if (event.type === "telemetry") {
      this.updateState({ latestTelemetry: event.data as TelemetryData });
    } else if (event.type === "route_event") {
      this.updateState({
        recentRoutes: [event.data as RouteEventData, ...this.state.recentRoutes].slice(
          0,
          MAX_RECENT_ROUTES,
        ),
      });
    } else if (event.type === "error") {
      this.updateState({
        recentErrors: [event.data as ErrorData, ...this.state.recentErrors].slice(
          0,
          MAX_RECENT_ERRORS,
        ),
      });
    }
  }
}

async function defaultTelemetryPoller(): Promise<TelemetryPoll> {
  if (!isTauriRuntime()) throw new Error("tachyon-telemetry-unavailable");
  return invokeDesktop<TelemetryPoll>("tachyon_telemetry_events");
}

function normalizeTelemetryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/tachyon-telemetry-[a-z-]+/)?.[0];
  return code ?? "tachyon-telemetry-unavailable";
}

