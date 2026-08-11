import { randomBytes } from "node:crypto";
import net from "node:net";
import { readFrame } from "./identity-proxy.ts";

/**
 * A minimal read-only app-server client, for asking a server which threads it
 * holds. The transport is WebSocket over the unix socket with a real RFC 6455
 * upgrade — codex rejects raw byte relays — and `params` is required on every
 * request, even when empty. Client frames are masked per RFC 6455 §5.1; the
 * frame reader is shared with the identity proxy, which speaks the other
 * direction.
 *
 * An exclusive server holds exactly one thread, which is what makes this
 * probe an identity read: the thread on a session's own socket IS the
 * session.
 */

export interface LoadedThread {
  id: string;
  cwd: string | null;
  name: string | null;
}

const PROBE_TIMEOUT_MS = 10_000;

/** Client frames carry a random mask (RFC 6455 §5.1). */
export function encodeClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  }
  return Buffer.concat([header, mask, masked]);
}

interface RpcClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): void;
}

async function connectRpc(socketPath: string): Promise<RpcClient> {
  const socket = net.connect(socketPath);
  socket.setTimeout(0);
  let buffer = Buffer.alloc(0);
  let handshakeDone = false;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let closed = false;

  const failAll = (error: Error): void => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    socket.destroy();
  };

  const handshake = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const text = buffer.toString("latin1");
        const end = text.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!text.startsWith("HTTP/1.1 101")) {
          reject(new Error(`app-server refused the websocket upgrade: ${text.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(Buffer.byteLength(text.slice(0, end + 4), "latin1"));
        handshakeDone = true;
        resolve();
      }
      for (;;) {
        const frame = readFrame(buffer);
        if (frame === null) break;
        buffer = buffer.subarray(frame.totalLength);
        if (frame.opcode === 0x8) {
          failAll(new Error("app-server closed the connection"));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, 0x80]), randomBytes(4)]));
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = message["id"];
        if (typeof id !== "number") continue;
        const entry = pending.get(id);
        if (entry === undefined) continue;
        pending.delete(id);
        if ("error" in message) {
          entry.reject(new Error(JSON.stringify(message["error"])));
        } else {
          entry.resolve(message["result"]);
        }
      }
    });
    socket.once("error", (error) => {
      reject(error);
      failAll(error);
    });
    socket.once("close", () => failAll(new Error("app-server connection closed")));
  });
  await handshake;

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(encodeClientTextFrame(JSON.stringify({ method, id, params })));
      });
    },
    notify(method, params) {
      socket.write(encodeClientTextFrame(JSON.stringify({ method, params })));
    },
    close() {
      closed = true;
      socket.destroy();
    },
  };
}

/**
 * The threads a server currently holds, with what `thread/read` knows about
 * each — the only pre-turn view of a codex thread that exists anywhere. A
 * thread that vanishes between listing and reading is reported with null
 * facts rather than dropped: its id is still the identity a caller wants.
 */
export async function readLoadedThreads(socketPath: string): Promise<LoadedThread[]> {
  const client = await connectRpc(socketPath);
  const timeout = setTimeout(() => client.close(), PROBE_TIMEOUT_MS);
  try {
    await client.request("initialize", {
      clientInfo: { name: "codex-swap", title: "codex-swap probe", version: "0" },
    });
    client.notify("initialized", {});
    const listed = (await client.request("thread/loaded/list", {})) as
      | { data?: unknown }
      | undefined;
    const ids = Array.isArray(listed?.data)
      ? listed.data.filter((id): id is string => typeof id === "string")
      : [];
    const threads: LoadedThread[] = [];
    for (const id of ids) {
      let cwd: string | null = null;
      let name: string | null = null;
      try {
        const read = (await client.request("thread/read", { threadId: id })) as {
          thread?: { cwd?: unknown; name?: unknown };
        };
        if (typeof read?.thread?.cwd === "string" && read.thread.cwd !== "") {
          cwd = read.thread.cwd;
        }
        if (typeof read?.thread?.name === "string" && read.thread.name.trim() !== "") {
          name = read.thread.name.trim();
        }
      } catch {
        /* listed but unreadable — report the id alone */
      }
      threads.push({ id, cwd, name });
    }
    return threads;
  } finally {
    clearTimeout(timeout);
    client.close();
  }
}
