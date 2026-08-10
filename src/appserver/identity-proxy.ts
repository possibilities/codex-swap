import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";

/**
 * The identity proxy that fronts a pinned app-server (handoff §39.4).
 *
 * A Codex TUI attached with `--remote` asks the server who it is before it
 * will show a session. A server running behind the rotation proxy answers
 * `authMethod: null` and `account: null` — its model provider is a custom one
 * with `requires_openai_auth = false`, so it has no ChatGPT identity of its
 * own to report — and the TUI drops the operator into the sign-in screen.
 * That is codex-side behaviour, reproducible with no ndy in the picture at
 * all: any app-server on a custom provider does it.
 *
 * codex-swap is the one component that knows the real answer, so it answers.
 * `app-server run` owns the public socket, proxies bytes to the wrapper's own
 * socket, and rewrites exactly three replies — `account/read`,
 * `getAuthStatus`, `account/rateLimits/read` — from the account catalog and
 * the usage store. Everything else passes through untouched, so a
 * programmatic client that never asks those questions cannot tell the proxy
 * is there.
 *
 * Two framing details matter. Client frames are masked and server frames are
 * not, per RFC 6455, so a rewritten reply is re-framed unmasked. And the
 * upgrade request's `Sec-WebSocket-Extensions` header is stripped before it
 * reaches the server: negotiating permessage-deflate would leave the payloads
 * compressed and unreadable, and no extension is worth losing the rewrite.
 */
export interface AppServerIdentity {
  email: string | null;
  planType: string | null;
  /** Codex-shaped rate limits, or null to pass the server's own reply through. */
  rateLimits: () => unknown | null;
}

const REWRITTEN_METHODS = new Set([
  "account/read",
  "getAuthStatus",
  "account/rateLimits/read",
]);

export interface IdentityProxy {
  close: () => Promise<void>;
}

/**
 * Removes a socket file left behind by a process that did not unlink it —
 * a crash, a SIGKILL, a supervisor restarting faster than the old child
 * exits. A bare unlink would be wrong: it would silently displace a server
 * that is genuinely still serving. So connect first and only clear the path
 * when nothing answers.
 */
export async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const serving = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    const settle = (answer: boolean): void => {
      probe.destroy();
      resolve(answer);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
    probe.setTimeout(2_000, () => settle(true));
  });
  if (serving) {
    throw new SocketInUseError(socketPath);
  }
  try {
    unlinkSync(socketPath);
  } catch {
    /* raced with another cleaner; the bind below reports the real problem */
  }
}

/** Raised when a socket path is held by a process that is still answering. */
export class SocketInUseError extends Error {
  constructor(socketPath: string) {
    super(`${socketPath} is already serving; refusing to displace it`);
  }
}

export async function startIdentityProxy(options: {
  publicSocketPath: string;
  upstreamSocketPath: string;
  identity: AppServerIdentity;
  onError?: (message: string) => void;
}): Promise<IdentityProxy> {
  const onError = options.onError ?? (() => {});
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(options.upstreamSocketPath);
    sockets.add(upstream);

    const session = new ProxySession(options.identity);
    let clientClosed = false;

    const teardown = (): void => {
      if (clientClosed) return;
      clientClosed = true;
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };

    client.on("data", (chunk) => {
      try {
        upstream.write(session.fromClient(chunk));
      } catch (error) {
        onError(`identity proxy: client->server failed: ${String(error)}`);
        teardown();
      }
    });
    upstream.on("data", (chunk) => {
      try {
        client.write(session.fromServer(chunk));
      } catch (error) {
        onError(`identity proxy: server->client failed: ${String(error)}`);
        teardown();
      }
    });

    client.on("error", teardown);
    upstream.on("error", (error) => {
      onError(`identity proxy: upstream socket error: ${error.message}`);
      teardown();
    });
    client.on("close", teardown);
    upstream.on("close", teardown);
  });

  await clearStaleSocket(options.publicSocketPath);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.publicSocketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.on("error", (error) => onError(`identity proxy: ${error.message}`));

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => {
          try {
            unlinkSync(options.publicSocketPath);
          } catch {
            /* already gone */
          }
          resolve();
        });
      }),
  };
}

/**
 * One client<->server conversation. Tracks which in-flight request ids named
 * a method worth rewriting, then swaps those replies on the way back.
 */
export class ProxySession {
  private readonly identity: AppServerIdentity;
  private clientHandshakeDone = false;
  private serverHandshakeDone = false;
  private clientBuffer = Buffer.alloc(0);
  private serverBuffer = Buffer.alloc(0);
  private readonly pending = new Map<string, string>();

  constructor(identity: AppServerIdentity) {
    this.identity = identity;
  }

  /** Client -> server. Bytes pass through; the upgrade loses its extensions. */
  fromClient(chunk: Buffer): Buffer {
    if (!this.clientHandshakeDone) {
      this.clientBuffer = Buffer.concat([this.clientBuffer, chunk]);
      const text = this.clientBuffer.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return Buffer.alloc(0);
      const head = stripExtensionsHeader(text.slice(0, end + 4));
      const rest = this.clientBuffer.subarray(Buffer.byteLength(text.slice(0, end + 4), "latin1"));
      this.clientHandshakeDone = true;
      this.clientBuffer = Buffer.alloc(0);
      return Buffer.concat([Buffer.from(head, "latin1"), this.observeClientFrames(rest)]);
    }
    return this.observeClientFrames(chunk);
  }

  /** Server -> client. Rewrites the identity replies, forwards the rest. */
  fromServer(chunk: Buffer): Buffer {
    if (!this.serverHandshakeDone) {
      this.serverBuffer = Buffer.concat([this.serverBuffer, chunk]);
      const text = this.serverBuffer.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return Buffer.alloc(0);
      const headBytes = Buffer.byteLength(text.slice(0, end + 4), "latin1");
      const head = this.serverBuffer.subarray(0, headBytes);
      const rest = this.serverBuffer.subarray(headBytes);
      this.serverHandshakeDone = true;
      this.serverBuffer = Buffer.alloc(0);
      return Buffer.concat([head, this.rewriteServerFrames(rest)]);
    }
    return this.rewriteServerFrames(chunk);
  }

  private observeClientFrames(chunk: Buffer): Buffer {
    this.clientBuffer = Buffer.concat([this.clientBuffer, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const frame = readFrame(this.clientBuffer);
      if (frame === null) break;
      out.push(this.clientBuffer.subarray(0, frame.totalLength));
      this.clientBuffer = this.clientBuffer.subarray(frame.totalLength);
      if (frame.opcode !== 0x1 || !frame.fin) continue;
      const message = parseJson(frame.payload);
      const id = message === null ? null : jsonRpcIdKey(message["id"]);
      const method = message?.["method"];
      if (id !== null && typeof method === "string" && REWRITTEN_METHODS.has(method)) {
        if (this.pending.size > 256) this.pending.clear();
        this.pending.set(id, method);
      }
    }
    return out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out);
  }

  private rewriteServerFrames(chunk: Buffer): Buffer {
    this.serverBuffer = Buffer.concat([this.serverBuffer, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const frame = readFrame(this.serverBuffer);
      if (frame === null) break;
      const raw = this.serverBuffer.subarray(0, frame.totalLength);
      this.serverBuffer = this.serverBuffer.subarray(frame.totalLength);
      if (frame.opcode !== 0x1 || !frame.fin) {
        out.push(raw);
        continue;
      }
      const message = parseJson(frame.payload);
      const id = message === null ? null : jsonRpcIdKey(message["id"]);
      if (id === null || !this.pending.has(id)) {
        out.push(raw);
        continue;
      }
      const method = this.pending.get(id) as string;
      this.pending.delete(id);
      const result = this.synthesize(method);
      if (result === null) {
        out.push(raw);
        continue;
      }
      const replacement = {
        ...(typeof message?.["jsonrpc"] === "string"
          ? { jsonrpc: message["jsonrpc"] }
          : {}),
        id: message?.["id"],
        result,
      };
      out.push(encodeServerTextFrame(JSON.stringify(replacement)));
    }
    return out.length === 1 ? (out[0] as Buffer) : Buffer.concat(out);
  }

  /** The reply codex-swap can answer truthfully, or null to pass through. */
  synthesize(method: string): unknown | null {
    if (method === "getAuthStatus") {
      return { authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true };
    }
    if (method === "account/read") {
      return {
        account: {
          type: "chatgpt",
          email: this.identity.email,
          planType: this.identity.planType,
        },
        requiresOpenaiAuth: true,
      };
    }
    if (method === "account/rateLimits/read") {
      return this.identity.rateLimits();
    }
    return null;
  }
}

/** Removes the extensions header so no compression is negotiated. */
export function stripExtensionsHeader(head: string): string {
  return head
    .split("\r\n")
    .filter((line) => !/^sec-websocket-extensions\s*:/i.test(line))
    .join("\r\n");
}

interface ParsedFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  totalLength: number;
}

/** Decodes one whole frame, unmasking if needed, or null when incomplete. */
export function readFrame(buffer: Buffer): ParsedFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer[0] as number;
  const second = buffer[1] as number;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(big);
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  const total = offset + maskLength + length;
  if (buffer.length < total) return null;
  let payload = buffer.subarray(offset + maskLength, total);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    const unmasked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) {
      unmasked[i] = (payload[i] as number) ^ (mask[i % 4] as number);
    }
    payload = unmasked;
  }
  return { opcode, fin, payload, totalLength: total };
}

/** Server frames are never masked (RFC 6455 §5.1). */
export function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseJson(payload: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload.toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function jsonRpcIdKey(id: unknown): string | null {
  if (typeof id === "number") return `n:${id}`;
  if (typeof id === "string") return `s:${id}`;
  return null;
}
