const allowedExtensions = new Set(["csv", "tsv", "xlsx", "xls", "xlsm", "xlsb", "ods"]);
const maxConcurrency = 3;

const authPanel = document.querySelector("#authPanel");
const codeInput = document.querySelector("#codeInput");
const saveCodeButton = document.querySelector("#saveCodeButton");
const authMessage = document.querySelector("#authMessage");
const dropPanel = document.querySelector("#dropPanel");
const fileInput = document.querySelector("#fileInput");
const chooseButton = document.querySelector("#chooseButton");
const chunkSizeSelect = document.querySelector("#chunkSize");
const queueList = document.querySelector("#queueList");
const fileList = document.querySelector("#fileList");
const refreshButton = document.querySelector("#refreshButton");

const queue = new Map();

codeInput.value = localStorage.getItem("transferCode") || "";

saveCodeButton.addEventListener("click", async () => {
  localStorage.setItem("transferCode", codeInput.value.trim());
  await refreshFiles();
});

codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveCodeButton.click();
});

chooseButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

refreshButton.addEventListener("click", refreshFiles);

dropPanel.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropPanel.classList.add("dragging");
});

dropPanel.addEventListener("dragleave", () => {
  dropPanel.classList.remove("dragging");
});

dropPanel.addEventListener("drop", (event) => {
  event.preventDefault();
  dropPanel.classList.remove("dragging");
  addFiles(event.dataTransfer.files);
});

await refreshFiles();

function addFiles(fileListLike) {
  const files = Array.from(fileListLike || []);
  for (const file of files) {
    const extension = file.name.split(".").pop().toLowerCase();
    if (!allowedExtensions.has(extension)) {
      addQueueError(file.name, "対象外の拡張子です");
      continue;
    }
    uploadFile(file);
  }
}

async function uploadFile(file) {
  const id = crypto.randomUUID();
  const item = {
    id,
    file,
    uploadedBytes: 0,
    status: "準備中",
    state: "active",
    error: ""
  };
  queue.set(id, item);
  renderQueue();

  try {
    const chunkSize = Number(chunkSizeSelect.value);
    const totalChunks = Math.ceil(file.size / chunkSize);
    const init = await api("/api/uploads/init", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        totalChunks,
        chunkSize
      }),
      headers: {
        "content-type": "application/json"
      }
    });

    item.status = "送信中";
    renderQueue();

    await uploadChunks(file, init.uploadId, totalChunks, chunkSize, item);

    item.status = "保存処理中";
    renderQueue();

    await api(`/api/uploads/${init.uploadId}/complete`, { method: "POST" });

    item.uploadedBytes = file.size;
    item.status = "完了";
    item.state = "ok";
    renderQueue();
    await refreshFiles();
  } catch (error) {
    item.status = "失敗";
    item.state = "error";
    item.error = error.message || String(error);
    renderQueue();
  }
}

async function uploadChunks(file, uploadId, totalChunks, chunkSize, item) {
  let nextIndex = 0;
  let active = 0;
  let rejected = false;

  return new Promise((resolve, reject) => {
    const pump = () => {
      if (rejected) return;
      if (nextIndex >= totalChunks && active === 0) {
        resolve();
        return;
      }

      while (active < maxConcurrency && nextIndex < totalChunks) {
        const index = nextIndex;
        nextIndex += 1;
        active += 1;

        sendChunkWithRetry(file, uploadId, index, chunkSize)
          .then((bytes) => {
            item.uploadedBytes += bytes;
            item.status = `${Math.min(100, Math.floor((item.uploadedBytes / file.size) * 100))}%`;
            renderQueue();
          })
          .catch((error) => {
            rejected = true;
            reject(error);
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };
    pump();
  });
}

async function sendChunkWithRetry(file, uploadId, index, chunkSize) {
  const start = index * chunkSize;
  const end = Math.min(file.size, start + chunkSize);
  const blob = file.slice(start, end);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await api(`/api/uploads/${uploadId}/chunks/${index}`, {
        method: "PUT",
        body: blob,
        headers: {
          "content-type": "application/octet-stream"
        }
      });
      return blob.size;
    } catch (error) {
      lastError = error;
      await delay(500 * attempt);
    }
  }

  throw lastError;
}

async function refreshFiles() {
  try {
    const code = getTransferCode();
    if (!code) {
      authMessage.textContent = "Mac側のターミナルに表示されている転送コードを入力してください。";
      authPanel.hidden = false;
      return;
    }

    const result = await api("/api/files");
    authPanel.hidden = true;
    renderFiles(result.files || []);
  } catch (error) {
    authPanel.hidden = false;
    authMessage.textContent = error.message || String(error);
  }
}

function renderQueue() {
  if (!queue.size) {
    queueList.className = "list empty";
    queueList.textContent = "待機中";
    return;
  }

  queueList.className = "list";
  queueList.innerHTML = "";

  for (const item of queue.values()) {
    const percent = item.file.size ? Math.min(100, (item.uploadedBytes / item.file.size) * 100) : 0;
    const row = document.createElement("article");
    row.className = "item";
    row.innerHTML = `
      <div>
        <div class="fileName"></div>
        <div class="meta"><span class="status"></span> · ${formatBytes(item.file.size)}</div>
        <div class="progressTrack"><div class="progressBar"></div></div>
      </div>
    `;
    row.querySelector(".fileName").textContent = item.file.name;
    const status = row.querySelector(".status");
    status.textContent = item.error ? `${item.status}: ${item.error}` : item.status;
    status.classList.add(item.state === "error" ? "error" : item.state === "ok" ? "ok" : "warn");
    row.querySelector(".progressBar").style.width = `${percent}%`;
    queueList.append(row);
  }
}

function renderFiles(files) {
  if (!files.length) {
    fileList.className = "list empty";
    fileList.textContent = "まだファイルはありません";
    return;
  }

  fileList.className = "list";
  fileList.innerHTML = "";

  for (const file of files) {
    const row = document.createElement("article");
    row.className = "item";

    const detail = document.createElement("div");
    const name = document.createElement("div");
    name.className = "fileName";
    name.textContent = file.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${formatBytes(file.size)} · ${new Date(file.modifiedAt).toLocaleString()}`;
    detail.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "actions";
    const download = document.createElement("button");
    download.className = "secondary";
    download.type = "button";
    download.textContent = "DL";
    download.title = "ダウンロード";
    download.addEventListener("click", () => {
      window.location.href = `/api/files/${encodeURIComponent(file.name)}/download?code=${encodeURIComponent(getTransferCode())}`;
    });

    const remove = document.createElement("button");
    remove.className = "danger";
    remove.type = "button";
    remove.textContent = "削除";
    remove.addEventListener("click", async () => {
      if (!confirm(`${file.name} を削除しますか?`)) return;
      await api(`/api/files/${encodeURIComponent(file.name)}`, { method: "DELETE" });
      await refreshFiles();
    });

    actions.append(download, remove);
    row.append(detail, actions);
    fileList.append(row);
  }
}

function addQueueError(name, message) {
  const id = crypto.randomUUID();
  queue.set(id, {
    id,
    file: { name, size: 0 },
    uploadedBytes: 0,
    status: "失敗",
    state: "error",
    error: message
  });
  renderQueue();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${getTransferCode()}`);

  const response = await fetch(path, {
    ...options,
    headers
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(typeof body === "object" ? body.error || "Request failed" : body);
  }

  return body;
}

function getTransferCode() {
  return (localStorage.getItem("transferCode") || codeInput.value || "").trim();
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
