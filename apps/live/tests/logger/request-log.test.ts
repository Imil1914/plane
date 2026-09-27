// PPM RC review (application logs): the live request log must never carry a query string (one-time tokens) or
// request headers (cookies, authorization) — only method, path, status and time.
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { Writable } from "node:stream";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createLoggerMiddleware } from "@plane/logger";

let server: ReturnType<express.Express["listen"]> | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function requestThroughLogger(path: string, headers: Record<string, string>): Promise<string> {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const app = express();
  app.use(createLoggerMiddleware(sink));
  app.get("/live/health", (_req, res) => {
    res.json({ status: "OK" });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server?.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return lines.join("");
}

describe("live request log", () => {
  it("logs method, path, status and time — without the query string or headers", async () => {
    const logged = await requestThroughLogger("/live/health?token=planted-live-token&documentId=planted-doc", {
      Cookie: "session-id=planted-session-cookie",
      Authorization: "Bearer planted-bearer",
      Referer: "https://ppm.example.test/accounts/reset-password?token=planted-referer-token",
    });

    expect(logged).toMatch(/GET \/live\/health 200 \d+ms/);
    for (const planted of [
      "planted-live-token",
      "planted-doc",
      "planted-session-cookie",
      "planted-bearer",
      "planted-referer-token",
      "?",
    ]) {
      expect(logged).not.toContain(planted);
    }
  });

  it("does not evaluate request data as a template", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = express();
    app.use(createLoggerMiddleware(sink));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server?.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    // Raw request line: fetch would percent-encode the braces.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("GET /live/{{7*191}} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      });
      socket.on("data", () => undefined);
      socket.on("end", () => resolve());
      socket.on("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const logged = lines.join("");

    expect(logged).toContain("GET /live/{{7*191}} 404");
    expect(logged).not.toContain("1337");
  });
});
