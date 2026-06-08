/**
 * Telemetry domain module for consuming the Core SSE telemetry stream.
 *
 * Connects to `GET /v1/telemetry/sse` on the Core HTTP bridge and exposes
 * typed event callbacks for the frontend UI.
 */

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

/**
 * TelemetryClient connects to the Core SSE stream and maintains a reactive
 * state snapshot. Call `connect()` to start, `disconnect()` to stop.
 */
export class TelemetryClient {
  private source: EventSource | null = null;
  private state: TelemetryState = {
    connection: "disconnected",
    hello: null,
    latestTelemetry: null,
    recentRoutes: [],
    recentErrors: [],
  };
  private listeners: Set<TelemetryListener> = new Set();
  private baseUrl: string;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl = "http://127.0.0.1:55123") {
    this.baseUrl = baseUrl;
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
    if (this.source) {
      return;
    }
    this.updateState({ connection: "connecting" });

    const source = new EventSource(`${this.baseUrl}/v1/telemetry/sse`);

    source.addEventListener("hello", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as TelemetryEvent;
      this.reconnectAttempt = 0;
      this.updateState({
        connection: "connected",
        hello: data.data as HelloData,
      });
    });

    source.addEventListener("telemetry", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as TelemetryEvent;
      this.updateState({
        latestTelemetry: data.data as TelemetryData,
      });
    });

    source.addEventListener("route_event", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as TelemetryEvent;
      const route = data.data as RouteEventData;
      this.updateState({
        recentRoutes: [route, ...this.state.recentRoutes].slice(0, MAX_RECENT_ROUTES),
      });
    });

    source.addEventListener("error", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as TelemetryEvent;
      const err = data.data as ErrorData;
      this.updateState({
        recentErrors: [err, ...this.state.recentErrors].slice(0, MAX_RECENT_ERRORS),
      });
    });

    source.onerror = () => {
      source.close();
      this.source = null;
      this.updateState({ connection: "disconnected" });
      // Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
      if (!this.closed) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };

    this.source = source;
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
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
}

