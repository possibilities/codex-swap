import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  encodeServerTextFrame,
  readFrame,
} from "../../src/appserver/identity-proxy.ts";
import { encodeClientTextFrame, readLoadedThreads } from "../../src/appserver/probe.ts";
import { autoServerSocketPath } from "../../src/appserver/dedicated.ts";
import { parseServerRequest } from "../../src/cli/commands/run.ts";

test("parseServerRequest maps the flag grammar onto the four request kinds", () => {
  assert.deepEqual(parseServerRequest({ noServer: false }), {
    request: { kind: "default" },
  });
  assert.deepEqual(parseServerRequest({ noServer: true }), {
    request: { kind: "off" },
  });
  assert.deepEqual(parseServerRequest({ server: "auto", noServer: false }), {
    request: { kind: "auto" },
  });
  assert.deepEqual(parseServerRequest({ server: "unix:///tmp/r.sock", noServer: false }), {
    request: { kind: "explicit", url: "unix:///tmp/r.sock" },
  });
  // Contradictions and malformed URLs refuse rather than guess.
  assert.ok("error" in parseServerRequest({ server: "auto", noServer: true }));
  assert.ok("error" in parseServerRequest({ server: "/tmp/r.sock", noServer: false }));
  assert.ok("error" in parseServerRequest({ server: "unix://relative.sock", noServer: false }));
});

test("auto socket paths stay inside the unix socket length budget", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cs-dedicated-"));
  const socket = autoServerSocketPath({ CODEX_SWAP_HOME: root } as NodeJS.ProcessEnv);
  assert.ok(socket.startsWith(root));
  assert.ok(Buffer.byteLength(socket) <= 100, `${socket} is over the sockaddr_un budget`);
});

test("client frames are masked and the proxy-side reader recovers them", () => {
  const frame = encodeClientTextFrame(JSON.stringify({ method: "initialize", id: 1 }));
  assert.equal((frame[1] as number) & 0x80, 0x80);
  const parsed = readFrame(frame);
  assert.ok(parsed);
  assert.equal(parsed.opcode, 0x1);
  assert.deepEqual(JSON.parse(parsed.payload.toString("utf8")), {
    method: "initialize",
    id: 1,
  });
});

/** A fake app-server: real RFC 6455 upgrade, canned thread answers. */
function startFakeAppServer(socketPath: string, threads: Map<string, { cwd: string; name: string | null }>): net.Server {
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    client.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const text = buffer.toString("latin1");
        const end = text.indexOf("\r\n\r\n");
        if (end < 0) return;
        const keyLine = text
          .split("\r\n")
          .find((line) => /^sec-websocket-key\s*:/i.test(line));
        const key = keyLine?.split(":")[1]?.trim() ?? "";
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        client.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        buffer = buffer.subarray(Buffer.byteLength(text.slice(0, end + 4), "latin1"));
        upgraded = true;
      }
      for (;;) {
        const frame = readFrame(buffer);
        if (frame === null) break;
        buffer = buffer.subarray(frame.totalLength);
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString("utf8")) as {
          method: string;
          id?: number;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) continue;
        let result: unknown = {};
        if (message.method === "thread/loaded/list") {
          result = { data: [...threads.keys()] };
        } else if (message.method === "thread/read") {
          const thread = threads.get(message.params?.["threadId"] as string);
          if (thread === undefined) {
            client.write(
              encodeServerTextFrame(
                JSON.stringify({ id: message.id, error: { code: -32600, message: "gone" } }),
              ),
            );
            continue;
          }
          result = { thread };
        }
        client.write(encodeServerTextFrame(JSON.stringify({ id: message.id, result })));
      }
    });
  });
  server.listen(socketPath);
  return server;
}

test("readLoadedThreads speaks the upgrade and reads each thread", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cs-probe-"));
  const socketPath = path.join(root, "srv.sock");
  const threads = new Map([
    ["019f-aaaa", { cwd: "/work/alpha", name: "alpha run" }],
    ["019f-bbbb", { cwd: "", name: null }],
  ]);
  const server = startFakeAppServer(socketPath, threads);
  try {
    const loaded = await readLoadedThreads(socketPath);
    assert.deepEqual(loaded, [
      { id: "019f-aaaa", cwd: "/work/alpha", name: "alpha run" },
      // Empty cwd and absent name report as null, never as "".
      { id: "019f-bbbb", cwd: null, name: null },
    ]);
  } finally {
    server.close();
  }
});
