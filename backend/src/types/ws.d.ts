/**
 * Minimal local typings for `ws`.
 * Kept intentionally small to satisfy strict TS until @types/ws is installed.
 */
declare module "ws" {
  /** Payload variants emitted by ws "message" events. */
  export type RawData = Buffer | ArrayBuffer | Buffer[];

  /** Narrow websocket surface consumed by server.ts and integration tests. */
  export class WebSocket {
    constructor(url: string);
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    on(event: "open", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: () => void): this;
    off(event: "open", listener: () => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    off(event: "message", listener: (data: RawData) => void): this;
    off(event: "close", listener: () => void): this;
  }

  /** Minimal server surface for accepting socket connections. */
  export class WebSocketServer {
    constructor(options: { port: number });
    on(event: "connection", listener: (socket: WebSocket) => void): this;
    close(callback?: (error?: Error) => void): void;
  }
}
