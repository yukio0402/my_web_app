import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(__dirname, "uploads");
const incomingDir = path.join(uploadDir, ".incoming");

const port = Number(process.env.PORT || 8787);
const transferCode = process.env.TRANSFER_CODE || crypto.randomBytes(4).toString("hex");
const appAuthUser = process.env.FILE_DROP_USER || "";
const appAuthPassword = process.env.FILE_DROP_PASSWORD || "";
const appAuthEnabled = Boolean(appAuthUser && appAuthPassword);
const allowedExtensions = new Set([".csv", ".tsv", ".xlsx", ".xls", ".xlsm", ".xlsb", ".ods"]);
const allowedTextExtensions = new Set([".csv", ".tsv", ".txt"]);
const maxChunkBytes = Number(process.env.MAX_CHUNK_MB || 32) * 1024 * 1024;
const maxFileBytes = Number(process.env.MAX_FILE_GB || 20) * 1024 * 1024 * 1024;
const maxTextBytes = Number(process.env.MAX_TEXT_MB || 256) * 1024 * 1024;

await fsp.mkdir(incomingDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    if (!error.status || error.status >= 500) {
      console.error(error);
    }
    sendJson(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Company File Drop listening on http://localhost:${port}`);
  console.log(`App auth: ${appAuthEnabled ? "enabled" : "disabled"}`);
  console.log(`Transfer code: ${transferCode}`);
  console.log(`Uploads directory: ${uploadDir}`);
});

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAppAuthorized(req)) {
    sendJson(res, 401, { error: "Invalid username or password" });
    return;
  }

  if (!isTransferAuthorized(req, url)) {
    sendJson(res, 401, { error: "Invalid transfer code" });
    return;
  }

  if (url.pathname === "/api/files" && req.method === "GET") {
    sendJson(res, 200, { files: await listFiles() });
    return;
  }

  if (url.pathname === "/api/uploads/init" && req.method === "POST") {
    const body = await readJson(req);
    const meta = await initUpload(body);
    sendJson(res, 200, meta);
    return;
  }

  if (url.pathname === "/api/text" && req.method === "POST") {
    const result = await savePastedText(req, url);
    sendJson(res, 200, result);
    return;
  }

  const chunkMatch = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]+)\/chunks\/(\d+)$/);
  if (chunkMatch && req.method === "PUT") {
    await receiveChunk(req, chunkMatch[1], Number(chunkMatch[2]));
    sendJson(res, 200, { ok: true });
    return;
  }

  const completeMatch = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const result = await completeUpload(completeMatch[1]);
    sendJson(res, 200, result);
    return;
  }

  const downloadMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download$/);
  if (downloadMatch && req.method === "GET") {
    await downloadFile(res, decodeURIComponent(downloadMatch[1]));
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    await deleteFile(decodeURIComponent(deleteMatch[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
    return;
  }

  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requestPath));

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "content-length": stat.size,
      "content-type": contentType(filePath),
      "cache-control": "no-store"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

function isTransferAuthorized(req, url) {
  const queryCode = url.searchParams.get("code");
  if (queryCode) {
    return constantTimeEquals(queryCode, transferCode);
  }

  const transferHeader = req.headers["x-transfer-code"];
  if (typeof transferHeader === "string") {
    return constantTimeEquals(transferHeader, transferCode);
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  return constantTimeEquals(header.slice(7), transferCode);
}

function isAppAuthorized(req) {
  if (!appAuthEnabled) return true;

  const headerUser = req.headers["x-file-drop-user"];
  const headerPassword = req.headers["x-file-drop-password"];
  if (typeof headerUser === "string" && typeof headerPassword === "string") {
    return constantTimeEquals(headerUser, appAuthUser) && constantTimeEquals(headerPassword, appAuthPassword);
  }

  return hasValidBasicAuth(req);
}

function hasValidBasicAuth(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return constantTimeEquals(user, appAuthUser) && constantTimeEquals(password, appAuthPassword);
  } catch {
    return false;
  }
}

function constantTimeEquals(value, expectedValue) {
  const supplied = Buffer.from(value);
  const expected = Buffer.from(expectedValue);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function initUpload(body) {
  const name = String(body.name || "");
  const size = Number(body.size);
  const totalChunks = Number(body.totalChunks);
  const chunkSize = Number(body.chunkSize);
  const extension = path.extname(name).toLowerCase();

  if (!name || !Number.isFinite(size) || !Number.isFinite(totalChunks) || !Number.isFinite(chunkSize)) {
    throw httpError(400, "Invalid upload metadata");
  }

  if (!allowedExtensions.has(extension)) {
    throw httpError(400, "Only spreadsheet files are accepted");
  }

  if (size <= 0 || size > maxFileBytes) {
    throw httpError(400, `File size must be between 1 byte and ${formatBytes(maxFileBytes)}`);
  }

  if (chunkSize <= 0 || chunkSize > maxChunkBytes) {
    throw httpError(400, `Chunk size must be at most ${formatBytes(maxChunkBytes)}`);
  }

  if (totalChunks < 1 || totalChunks > Math.ceil(size / chunkSize) + 1) {
    throw httpError(400, "Invalid chunk count");
  }

  const uploadId = crypto.randomUUID();
  const safeName = sanitizeFileName(name);
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const finalName = await availableFileName(`${now}-${safeName}`);
  const sessionDir = path.join(incomingDir, uploadId);

  await fsp.mkdir(sessionDir, { recursive: true });
  const meta = {
    uploadId,
    originalName: name,
    finalName,
    size,
    totalChunks,
    chunkSize,
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(path.join(sessionDir, "meta.json"), meta);
  return meta;
}

async function receiveChunk(req, uploadId, index) {
  const sessionDir = safeSessionDir(uploadId);
  const meta = await readUploadMeta(sessionDir);
  const contentLengthHeader = req.headers["content-length"];
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;

  if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) {
    throw httpError(400, "Invalid chunk index");
  }

  if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maxChunkBytes)) {
    throw httpError(400, "Invalid chunk length");
  }

  const chunkPath = path.join(sessionDir, `${index}.part`);
  const tempPath = `${chunkPath}.tmp`;

  const writtenBytes = await streamToFile(req, tempPath, maxChunkBytes);
  const expectedStart = index * meta.chunkSize;
  const expectedEnd = Math.min(meta.size, expectedStart + meta.chunkSize);
  const expectedBytes = expectedEnd - expectedStart;

  if (writtenBytes <= 0 || writtenBytes !== expectedBytes) {
    await fsp.rm(tempPath, { force: true });
    throw httpError(400, "Chunk size did not match metadata");
  }
  await fsp.rename(tempPath, chunkPath);
}

async function completeUpload(uploadId) {
  const sessionDir = safeSessionDir(uploadId);
  const meta = await readUploadMeta(sessionDir);

  for (let index = 0; index < meta.totalChunks; index += 1) {
    try {
      await fsp.access(path.join(sessionDir, `${index}.part`));
    } catch {
      throw httpError(409, `Missing chunk ${index + 1} of ${meta.totalChunks}`);
    }
  }

  const finalPath = path.join(uploadDir, meta.finalName);
  const tempFinalPath = `${finalPath}.tmp`;

  await fsp.rm(tempFinalPath, { force: true });
  const output = fs.createWriteStream(tempFinalPath, { flags: "wx" });

  try {
    for (let index = 0; index < meta.totalChunks; index += 1) {
      await appendFileToStream(path.join(sessionDir, `${index}.part`), output);
    }
    await closeWritable(output);
    const stat = await fsp.stat(tempFinalPath);
    if (stat.size !== meta.size) {
      await fsp.rm(tempFinalPath, { force: true });
      throw httpError(400, "Assembled file size did not match metadata");
    }
    await fsp.rename(tempFinalPath, finalPath);
    await fsp.rm(sessionDir, { recursive: true, force: true });
  } catch (error) {
    output.destroy();
    await fsp.rm(tempFinalPath, { force: true });
    throw error;
  }

  return {
    ok: true,
    file: {
      name: meta.finalName,
      originalName: meta.originalName,
      size: meta.size,
      savedAt: new Date().toISOString()
    }
  };
}

async function savePastedText(req, url) {
  const requestedName = url.searchParams.get("name") || "pasted.tsv";
  const safeName = sanitizeFileName(requestedName);
  const extension = path.extname(safeName).toLowerCase();

  if (!allowedTextExtensions.has(extension)) {
    throw httpError(400, "Pasted text must be saved as .csv, .tsv, or .txt");
  }

  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const finalName = await availableFileName(`${now}-${safeName}`);
  const finalPath = path.join(uploadDir, finalName);
  const tempPath = `${finalPath}.tmp`;

  const writtenBytes = await streamToFile(req, tempPath, maxTextBytes);
  if (writtenBytes <= 0) {
    await fsp.rm(tempPath, { force: true });
    throw httpError(400, "Pasted text was empty");
  }

  await fsp.rename(tempPath, finalPath);

  return {
    ok: true,
    file: {
      name: finalName,
      originalName: safeName,
      size: writtenBytes,
      savedAt: new Date().toISOString()
    }
  };
}

async function listFiles() {
  const entries = await fsp.readdir(uploadDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isFile()) continue;
    const filePath = path.join(uploadDir, entry.name);
    const stat = await fsp.stat(filePath);
    files.push({
      name: entry.name,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    });
  }

  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return files;
}

async function downloadFile(res, name) {
  const filePath = safeUploadFilePath(name);
  const stat = await fsp.stat(filePath);
  res.writeHead(200, {
    "content-length": stat.size,
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "cache-control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function deleteFile(name) {
  await fsp.rm(safeUploadFilePath(name), { force: true });
}

function safeUploadFilePath(name) {
  const safeName = path.basename(name);
  const filePath = path.normalize(path.join(uploadDir, safeName));
  if (!filePath.startsWith(uploadDir) || safeName !== name) {
    throw httpError(400, "Invalid file name");
  }
  return filePath;
}

function safeSessionDir(uploadId) {
  if (!/^[a-f0-9-]{36}$/.test(uploadId)) {
    throw httpError(400, "Invalid upload id");
  }
  return path.join(incomingDir, uploadId);
}

async function readUploadMeta(sessionDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(sessionDir, "meta.json"), "utf8"));
  } catch {
    throw httpError(404, "Upload session not found");
  }
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw httpError(413, "JSON body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

async function streamToFile(input, filePath, limitBytes) {
  await fsp.rm(filePath, { force: true });
  const output = fs.createWriteStream(filePath, { flags: "wx" });
  let total = 0;

  try {
    for await (const chunk of input) {
      total += chunk.length;
      if (total > limitBytes) throw httpError(413, "Chunk too large");
      if (!output.write(chunk)) {
        await once(output, "drain");
      }
    }
    await closeWritable(output);
    return total;
  } catch (error) {
    output.destroy();
    await fsp.rm(filePath, { force: true });
    throw error;
  }
}

async function appendFileToStream(filePath, output) {
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) {
    if (!output.write(chunk)) {
      await once(output, "drain");
    }
  }
}

function closeWritable(stream) {
  return new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.once("error", reject);
  });
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
}

async function availableFileName(name) {
  const parsed = path.parse(name);
  let candidate = name;
  let counter = 1;

  while (true) {
    try {
      await fsp.access(path.join(uploadDir, candidate));
      candidate = `${parsed.name}-${counter}${parsed.ext}`;
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

function sanitizeFileName(name) {
  const base = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
  return base || "upload.bin";
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(tempPath, filePath);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

process.on("uncaughtException", (error) => {
  console.error(error);
});
