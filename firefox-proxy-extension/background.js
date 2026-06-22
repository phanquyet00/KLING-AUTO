// ============================================================
//  IP Changer - Webshare Proxy  |  Background Script
// ============================================================

// ---------- State ----------
let proxyEnabled = false;
let proxyConfig = null;       // { host, port, username, password }
let currentIp = null;
const WEBSHARE_API_BASE = "https://proxy.webshare.io/api/v2";
const PROXY_LIST_URL = `${WEBSHARE_API_BASE}/proxy/list/?mode=direct`;

// ---------- Helpers ----------

/** Update toolbar + sidebar icons to reflect ON/OFF state */
function updateIcon() {
  try {
    const iconPath = proxyEnabled ? "icons/icon-on.svg" : "icons/icon-off.svg";
    const sizes = { 16: iconPath, 32: iconPath, 48: iconPath, 96: iconPath };

    // Toolbar button
    browser.browserAction.setIcon({ path: sizes });
    browser.browserAction.setTitle({
      title: proxyEnabled ? "IP Changer: ON — Bấm để mở/đóng sidebar" : "IP Changer: OFF — Bấm để mở/đóng sidebar"
    });

    // Sidebar header icon
    browser.sidebarAction.setIcon({ path: iconPath });
    browser.sidebarAction.setTitle({
      title: proxyEnabled ? "IP Changer — Proxy đang BẬT" : "IP Changer — Proxy đang TẮT"
    });
  } catch (e) {
    console.error("[IP Changer] updateIcon error:", e);
  }
}

/**
 * Fetch proxy list from Webshare API.
 * Returns the parsed JSON or throws on failure.
 */
async function fetchProxyList(apiKey) {
  const res = await fetch(PROXY_LIST_URL, {
    headers: { Authorization: `Token ${apiKey}` }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

/** Pick a random VALID proxy from the list and store it as the active config. */
function pickRandomProxy(list) {
  if (!list || !list.results || list.results.length === 0) {
    throw new Error("Danh sách proxy trống. Hãy tạo proxy trong Webshare Dashboard.");
  }
  // Only pick from valid proxies
  const validProxies = list.results.filter(p => p.valid !== false);
  if (validProxies.length === 0) {
    throw new Error("Tất cả proxy đã hết hạn hoặc không hoạt động. Hãy tạo proxy mới trong Webshare Dashboard.");
  }
  const p = validProxies[Math.floor(Math.random() * validProxies.length)];
  proxyConfig = {
    host: p.proxy_address,
    port: p.port,
    username: p.username,
    password: p.password
  };
  return proxyConfig;
}

// ---------- Proxy Request Handler ----------
// Firefox calls this for every network request. We decide
// whether to route through the Webshare proxy or go direct.
// NOTE: username/password are NOT passed here — Firefox handles
// proxy auth via the webRequest.onAuthRequired listener below.

browser.proxy.onRequest.addListener(
  (requestInfo) => {
    try {
      if (!proxyEnabled || !proxyConfig) {
        return { type: "direct" };
      }
      return {
        type: "http",
        host: proxyConfig.host,
        port: proxyConfig.port
      };
    } catch (e) {
      console.error("[IP Changer] proxy.onRequest error:", e);
      return { type: "direct" };
    }
  },
  { urls: ["<all_urls>"] }
);

// ---------- Auth Fallback ----------
// If Firefox still prompts for proxy credentials,
// answer automatically with the stored config.

browser.webRequest.onAuthRequired.addListener(
  (details) => {
    try {
      if (!details.isProxy || !proxyEnabled || !proxyConfig) {
        return; // Let Firefox handle normally
      }
      console.log("[IP Changer] Providing proxy auth for:", details.url);
      return {
        authCredentials: {
          username: proxyConfig.username,
          password: proxyConfig.password
        }
      };
    } catch (e) {
      console.error("[IP Changer] onAuthRequired error:", e);
    }
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

// ---------- Check current IP ----------
async function checkCurrentIp() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    currentIp = data.ip;
    return currentIp;
  } catch (e) {
    console.error("Failed to check IP:", e);
    return null;
  }
}

// ---------- Actions ----------

/** Enable proxy: fetch list → pick one → activate */
async function enableProxy(apiKey) {
  const list = await fetchProxyList(apiKey);
  pickRandomProxy(list);
  proxyEnabled = true;
  await browser.storage.local.set({ proxyEnabled: true, proxyConfig });
  updateIcon();
  // Give the proxy a moment to take effect, then check IP
  setTimeout(async () => {
    currentIp = await checkCurrentIp();
  }, 1500);
  return { success: true, config: proxyConfig };
}

/** Disable proxy → direct connection restored */
async function disableProxy() {
  proxyEnabled = false;
  proxyConfig = null;
  await browser.storage.local.set({ proxyEnabled: false, proxyConfig: null });
  updateIcon();
  setTimeout(async () => {
    currentIp = await checkCurrentIp();
  }, 1500);
  return { success: true };
}

/** Refresh: pick a different proxy from the list without toggling off */
async function refreshProxy(apiKey) {
  if (!proxyEnabled) {
    return enableProxy(apiKey);
  }
  const list = await fetchProxyList(apiKey);
  pickRandomProxy(list);
  await browser.storage.local.set({ proxyConfig });
  setTimeout(async () => {
    currentIp = await checkCurrentIp();
  }, 1500);
  return { success: true, config: proxyConfig };
}

// ---------- Toolbar button → toggle sidebar ----------

browser.browserAction.onClicked.addListener(() => {
  try {
    browser.sidebarAction.toggle();
  } catch (e) {
    console.error("[IP Changer] sidebar toggle error:", e);
  }
});

// ---------- Message handler (from sidebar.js) ----------
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case "getState":
          sendResponse({
            proxyEnabled,
            currentIp,
            hasConfig: !!proxyConfig
          });
          break;

        case "enable":
          sendResponse(await enableProxy(message.apiKey));
          break;

        case "disable":
          sendResponse(await disableProxy());
          break;

        case "refresh":
          sendResponse(await refreshProxy(message.apiKey));
          break;

        case "checkIp":
          sendResponse({ ip: await checkCurrentIp() });
          break;

        default:
          sendResponse({ error: "Unknown action" });
      }
    } catch (err) {
      console.error("[IP Changer] action error:", message.action, err);
      sendResponse({ error: err.message });
    }
  })();
  return true; // keep channel open for async sendResponse
});

// ---------- Startup ----------
(async function startup() {
  try {
    const stored = await browser.storage.local.get([
      "proxyEnabled",
      "proxyConfig",
      "apiKey"
    ]);
    proxyEnabled = stored.proxyEnabled || false;
    proxyConfig = stored.proxyConfig || null;
    updateIcon();
    console.log("[IP Changer] Started. Proxy:", proxyEnabled ? "ON" : "OFF");
    if (proxyEnabled) {
      currentIp = await checkCurrentIp();
    }
  } catch (e) {
    console.error("[IP Changer] Startup error:", e);
  }
})();
