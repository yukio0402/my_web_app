import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");
const port = 9876;
const baseUrl = `http://localhost:${port}`;
const code = "smoke-test-code";
const basicUser = "smoke-user";
const basicPassword = "smoke-password";
const basicAuth = `Basic ${Buffer.from(`${basicUser}:${basicPassword}`).toString("base64")}`;

test("requires Basic auth", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      TRANSFER_CODE: code,
      FILE_DROP_USER: basicUser,
      FILE_DROP_PASSWORD: basicPassword
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForListening();
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") || "", /Basic/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("uploads, downloads, and deletes a chunked CSV behind Basic auth", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      TRANSFER_CODE: code,
      FILE_DROP_USER: basicUser,
      FILE_DROP_PASSWORD: basicPassword
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHealth();

    const bytes = Buffer.from("alpha,beta\n1,2\n3,4\n", "utf8");
    const chunkSize = 10;
    const totalChunks = Math.ceil(bytes.length / chunkSize);

    const init = await api("/api/uploads/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "smoke.csv",
        size: bytes.length,
        totalChunks,
        chunkSize
      })
    });

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(bytes.length, start + chunkSize);
      await api(`/api/uploads/${init.uploadId}/chunks/${index}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes.subarray(start, end)
      });
    }

    const completed = await api(`/api/uploads/${init.uploadId}/complete`, { method: "POST" });
    assert.equal(completed.ok, true);
    assert.match(completed.file.name, /smoke\.csv$/);

    const listing = await api("/api/files");
    assert.equal(listing.files.some((file) => file.name === completed.file.name), true);

    const download = await fetch(`${baseUrl}/api/files/${encodeURIComponent(completed.file.name)}/download?code=${encodeURIComponent(code)}`, {
      headers: { authorization: basicAuth }
    });
    assert.equal(download.ok, true);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

    await api(`/api/files/${encodeURIComponent(completed.file.name)}`, { method: "DELETE" });
    await assert.rejects(fsp.access(path.join(rootDir, "uploads", completed.file.name)));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: basicAuth,
      "x-transfer-code": code,
      ...options.headers
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(body.error || text || `HTTP ${response.status}`);
  }
  return body;
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { authorization: basicAuth }
      });
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Server did not start");
}

async function waitForListening() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      await fetch(`${baseUrl}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Server did not start");
}
