// ============================================================
//  IP Changer - Webshare Proxy  |  Sidebar Script
//  Chạy trong sidebar panel bên trái Firefox, luôn hiển thị.
// ============================================================

// ---------- DOM refs ----------
const toggleBtn    = document.getElementById("toggleBtn");
const toggleLabel  = document.getElementById("toggleLabel");
const statusBadge  = document.getElementById("statusBadge");
const ipDisplay    = document.getElementById("ipDisplay");
const copyIpBtn    = document.getElementById("copyIpBtn");
const refreshBtn   = document.getElementById("refreshBtn");
const toastEl      = document.getElementById("toast");
const errorEl      = document.getElementById("error");
const apiKeyInput  = document.getElementById("apiKeyInput");
const saveKeyBtn   = document.getElementById("saveKeyBtn");
const showKeyBtn   = document.getElementById("showKeyBtn");
const settingsGroup = document.getElementById("settingsGroup");

let isLoading = false;

// ---------- Toast / Error ----------

function showToast(text, type = "info") {
  toastEl.textContent = text;
  toastEl.className = `toast ${type}`;
  toastEl.style.display = "block";
  clearTimeout(toastEl._timeout);
  toastEl._timeout = setTimeout(() => { toastEl.style.display = "none"; }, 4000);
}

function showError(text) {
  errorEl.textContent = text;
  errorEl.style.display = "block";
}

function hideError() {
  errorEl.style.display = "none";
}

// ---------- Background communication ----------

function send(msg) {
  return browser.runtime.sendMessage(msg);
}

async function getState() {
  return send({ action: "getState" });
}

// ---------- Update UI ----------

function updateUI(state) {
  toggleBtn.checked = state.proxyEnabled;

  if (state.proxyEnabled) {
    toggleLabel.textContent = "Proxy đang BẬT";
    statusBadge.textContent = "ON";
    statusBadge.className = "badge on";
  } else {
    toggleLabel.textContent = "Proxy đang TẮT";
    statusBadge.textContent = "OFF";
    statusBadge.className = "badge";
  }

  if (state.currentIp) {
    ipDisplay.textContent = state.currentIp;
  } else if (state.proxyEnabled) {
    ipDisplay.textContent = "Đang kiểm tra...";
  } else {
    ipDisplay.textContent = "--";
  }

  refreshBtn.style.display = state.proxyEnabled ? "block" : "none";
}

async function refreshIpDisplay() {
  try {
    const resp = await send({ action: "checkIp" });
    if (resp.ip) ipDisplay.textContent = resp.ip;
  } catch { /* ignore */ }
}

// ---------- Load & init ----------

async function init() {
  try {
    // Load saved API key
    const stored = await browser.storage.local.get(["apiKey"]);
    if (stored.apiKey) {
      apiKeyInput.value = stored.apiKey;
    }

    // Load proxy state
    const state = await getState();
    updateUI(state);
    if (state.proxyEnabled) {
      await refreshIpDisplay();
    }
  } catch (e) {
    console.error("[IP Changer] Sidebar init error:", e);
    showError("Lỗi khởi tạo: " + e.message);
  }
}

// ---------- Toggle ----------

toggleBtn.addEventListener("change", async () => {
  if (isLoading) return;
  hideError();
  const enable = toggleBtn.checked;

  // Optimistic UI
  toggleLabel.textContent = enable ? "Proxy đang BẬT" : "Proxy đang TẮT";
  statusBadge.textContent = enable ? "ON" : "OFF";
  statusBadge.className = enable ? "badge on" : "badge";

  const stored = await browser.storage.local.get(["apiKey"]);
  if (!stored.apiKey && enable) {
    // Revert
    toggleBtn.checked = false;
    toggleLabel.textContent = "Proxy đang TẮT";
    statusBadge.textContent = "OFF";
    statusBadge.className = "badge";
    showError("⚠ Vui lòng nhập API Key Webshare trong phần ⚙ Cài đặt API bên dưới.");
    settingsGroup.open = true;
    return;
  }

  isLoading = true;
  try {
    let resp;
    if (enable) {
      showToast("Đang kết nối proxy...", "info");
      resp = await send({ action: "enable", apiKey: stored.apiKey });
    } else {
      resp = await send({ action: "disable" });
    }

    if (resp.error) throw new Error(resp.error);

    const state = await getState();
    updateUI(state);

    if (enable) {
      showToast("Proxy đã bật! 🟢", "success");
      setTimeout(refreshIpDisplay, 2000);
    } else {
      ipDisplay.textContent = "--";
      showToast("Đã tắt proxy, dùng IP thật.", "info");
    }
  } catch (err) {
    // Revert
    toggleBtn.checked = !enable;
    toggleLabel.textContent = !enable ? "Proxy đang BẬT" : "Proxy đang TẮT";
    statusBadge.textContent = !enable ? "ON" : "OFF";
    statusBadge.className = !enable ? "badge on" : "badge";
    showError(err.message);
  } finally {
    isLoading = false;
  }
});

// ---------- Refresh / Đổi IP ----------

refreshBtn.addEventListener("click", async () => {
  if (isLoading) return;
  hideError();
  isLoading = true;
  refreshBtn.disabled = true;
  refreshBtn.textContent = "⏳ Đang đổi IP...";

  const stored = await browser.storage.local.get(["apiKey"]);
  try {
    const resp = await send({ action: "refresh", apiKey: stored.apiKey });
    if (resp.error) throw new Error(resp.error);

    showToast("Đã chọn proxy mới! 🔄", "success");
    ipDisplay.textContent = "Đang kiểm tra...";
    setTimeout(refreshIpDisplay, 2000);
  } catch (err) {
    showError(err.message);
  } finally {
    isLoading = false;
    refreshBtn.disabled = false;
    refreshBtn.textContent = "🔄 Đổi IP khác";
  }
});

// ---------- Copy IP ----------

copyIpBtn.addEventListener("click", async () => {
  const ip = ipDisplay.textContent;
  if (!ip || ip === "--" || ip === "Đang kiểm tra...") return;
  try {
    await navigator.clipboard.writeText(ip);
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = ip;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  copyIpBtn.textContent = "✅";
  setTimeout(() => { copyIpBtn.textContent = "📋"; }, 1500);
});

// ---------- API Key ----------

saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showError("Vui lòng nhập API Key.");
    return;
  }
  await browser.storage.local.set({ apiKey: key });
  showToast("Đã lưu API Key ✅", "success");
  settingsGroup.open = false;
});

showKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  showKeyBtn.textContent = apiKeyInput.type === "password" ? "👁" : "🙈";
});

// ---------- Start ----------
init();
