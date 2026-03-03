/**
 * Minimal local typings for `ws`.
 * Kept intentionally small to satisfy strict TS until @types/ws is installed.
 */
declare module "ws" {
  /** Payload variants emitted by ws "message" events. */
  export type RawData = Buffer | ArrayBuffer | Buffer[];

  /** Narrow websocket surface consumed by server.ts. */
  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: () => void): this;
  }

  /** Minimal server surface for accepting socket connections. */
  export class WebSocketServer {
    constructor(options: { port: number });
    on(event: "connection", listener: (socket: WebSocket) => void): this;
    close(callback?: (error?: Error) => void): void;
  }
}
