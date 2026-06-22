const api = typeof browser !== 'undefined' ? browser : chrome;

const KLING_APP_URL = 'https://kling.ai/app/video/new';
const CONTAINER_PREFIX = 'Kling-';
const CONTAINER_COLORS = ['blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'];

// tabId -> { email, password, image, loggedIn }
const pendingLogins = new Map();

// Tabs đang chờ xác nhận tiếp tục login
const pausedLogins = new Set();
let expectedPaused = 0;
let completedLogins = 0;

// ========== Proxy state ==========
let proxyEnabled = false;
let proxyConfig = null;
let currentIp = null;
let proxyIndex = 0;
let proxyTotal = 0;
const WEBSHARE_API_BASE = 'https://proxy.webshare.io/api/v2';
const PROXY_LIST_URL = `${WEBSHARE_API_BASE}/proxy/list/?mode=direct`;

// ========== Toggle sidebar khi click icon extension ==========
if (api.browserAction && api.browserAction.onClicked) {
  api.browserAction.onClicked.addListener(async () => {
    try {
      if (api.sidebarAction && api.sidebarAction.toggle) {
        await api.sidebarAction.toggle();
      }
    } catch (e) {
      console.error('[KlingAutoLogin] Lỗi toggle sidebar:', e);
    }
  });
}

// ========== Proxy: update icon ==========
function updateProxyIcon() {
  try {
    const iconPath = proxyEnabled ? 'icons/icon-on.svg' : 'icons/icon-off.svg';
    browser.browserAction.setIcon({ path: { 16: iconPath, 32: iconPath, 48: iconPath, 96: iconPath } });
    browser.browserAction.setTitle({
      title: proxyEnabled ? 'KlingAI Auto Login — Proxy ON' : 'KlingAI Auto Login (bấm để mở sidebar)'
    });
  } catch (e) {}
}

// ========== Proxy: fetch proxy list ==========
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

// ========== Proxy: pick proxy by index (tuần tự từ trên xuống) ==========
function pickProxyByIndex(list, index) {
  if (!list || !list.results || list.results.length === 0) {
    throw new Error('Danh sách proxy trống. Hãy tạo proxy trong Webshare Dashboard.');
  }
  const candidates = list.results.filter(p => p.valid !== false);
  if (candidates.length === 0) {
    throw new Error('Tất cả proxy đã hết hạn hoặc không hoạt động.');
  }
  const i = index % candidates.length;
  const p = candidates[i];
  proxyConfig = {
    host: p.proxy_address,
    port: p.port,
    username: p.username,
    password: p.password
  };
  proxyTotal = candidates.length;
  proxyIndex = i;
  return proxyConfig;
}

// ========== Proxy: onRequest handler ==========
browser.proxy.onRequest.addListener(
  (requestInfo) => {
    if (!proxyEnabled || !proxyConfig) {
      return { type: 'direct' };
    }
    return {
      type: 'http',
      host: proxyConfig.host,
      port: proxyConfig.port
    };
  },
  { urls: ['<all_urls>'] }
);

// ========== Proxy: auth handler ==========
browser.webRequest.onAuthRequired.addListener(
  (details) => {
    if (!details.isProxy || !proxyEnabled || !proxyConfig) return;
    return {
      authCredentials: {
        username: proxyConfig.username,
        password: proxyConfig.password
      }
    };
  },
  { urls: ['<all_urls>'] },
  ['blocking']
);

// ========== Proxy: check current IP ==========
async function checkCurrentIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    currentIp = data.ip;
    return currentIp;
  } catch (e) {
    return null;
  }
}

// ========== Proxy: enable ==========
async function enableProxy(apiKey) {
  const list = await fetchProxyList(apiKey);
  pickProxyByIndex(list, proxyIndex);
  proxyEnabled = true;
  await browser.storage.local.set({ proxyEnabled: true, proxyConfig, proxyIndex, proxyTotal });
  updateProxyIcon();
  setTimeout(async () => { currentIp = await checkCurrentIp(); }, 1500);
  return { success: true, config: proxyConfig, index: proxyIndex, total: proxyTotal };
}

// ========== Proxy: disable ==========
async function disableProxy() {
  proxyEnabled = false;
  proxyConfig = null;
  await browser.storage.local.set({ proxyEnabled: false, proxyConfig: null });
  updateProxyIcon();
  setTimeout(async () => { currentIp = await checkCurrentIp(); }, 1500);
  return { success: true };
}

// ========== Proxy: refresh ==========
async function refreshProxy(apiKey) {
  if (!proxyEnabled) return enableProxy(apiKey);
  const list = await fetchProxyList(apiKey);
  proxyIndex++;
  pickProxyByIndex(list, proxyIndex);
  await browser.storage.local.set({ proxyConfig, proxyIndex });
  setTimeout(async () => { currentIp = await checkCurrentIp(); }, 1500);
  return { success: true, config: proxyConfig, index: proxyIndex, total: proxyTotal };
}

// ========== Message handler ==========
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- KlingAI login messages ---
  if (message.type === 'AUTO_LOGIN') {
    handleSingleLogin(message.account, message.image)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'BULK_LOGIN') {
    handleBulkLogin(message.tasks)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'CONTENT_READY') {
    const tabId = sender.tab?.id;
    if (tabId && pendingLogins.has(tabId)) {
      const credentials = pendingLogins.get(tabId);
      if (!credentials.loggedIn) {
        sendResponse({
          type: 'LOGIN_NOW',
          credentials: {
            email: credentials.email,
            password: credentials.password,
            image: credentials.image
          }
        });
        return false;
      }
      if (credentials.image) {
        sendResponse({ type: 'UPLOAD_IMAGE', image: credentials.image });
        return false;
      }
    }
    sendResponse({ type: 'IDLE' });
    return false;
  }

  if (message.type === 'LOGIN_SUCCESS') {
    const tabId = sender.tab?.id;
    if (tabId && pendingLogins.has(tabId)) {
      const cred = pendingLogins.get(tabId);
      cred.loggedIn = true;
      pendingLogins.set(tabId, cred);
      completedLogins++;
      pausedLogins.delete(tabId);
      setTimeout(() => {
        api.tabs.get(tabId).then(tab => {
          if (tab && !tab.url.includes('/app/video/new')) {
            api.tabs.update(tabId, { url: KLING_APP_URL });
          }
        }).catch(() => {});
      }, 2000);
    }
    return false;
  }

  if (message.type === 'UPLOAD_DONE') {
    const tabId = sender.tab?.id;
    if (tabId) pendingLogins.delete(tabId);
    return false;
  }

  if (message.type === 'LOGIN_RESULT') {
    console.log('[KlingAutoLogin]', message);
    return false;
  }

  if (message.type === 'LOGIN_PAUSED') {
    const tabId = sender.tab?.id;
    if (tabId) pausedLogins.add(tabId);
    return false;
  }

  if (message.type === 'SET_EXPECTED_PAUSED') {
    expectedPaused = message.count || 0;
    completedLogins = 0;
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'CONTINUE_LOGIN') {
    handleContinueLogin()
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_PAUSED_COUNT') {
    sendResponse({ count: pausedLogins.size, expected: expectedPaused, completed: completedLogins });
    return false;
  }

  if (message.type === 'DOWNLOAD_VIDEO') {
    handleDownloadVideo()
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'TIMER_SLEEP') {
    setTimeout(() => sendResponse({}), message.ms);
    return true;
  }

  // --- Proxy messages ---
  if (message.action === 'getState') {
    sendResponse({ proxyEnabled, currentIp, hasConfig: !!proxyConfig, proxyIndex, proxyTotal });
    return false;
  }

  if (message.action === 'enable') {
    enableProxy(message.apiKey)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.action === 'disable') {
    disableProxy()
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.action === 'refresh') {
    refreshProxy(message.apiKey)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.action === 'checkIp') {
    checkCurrentIp()
      .then(ip => sendResponse({ ip }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

});

// ========== Container management ==========
async function getOrCreateContainer(account) {
  const name = `${CONTAINER_PREFIX}${account.email.split('@')[0]}`;
  if (!api.contextualIdentities) throw new Error('Trình duyệt không hỗ trợ Container Tabs');

  const existing = await api.contextualIdentities.query({ name });
  if (existing && existing.length > 0) return existing[0];

  const colorIdx = Math.abs(hashCode(account.id || account.email)) % CONTAINER_COLORS.length;
  return await api.contextualIdentities.create({
    name,
    color: CONTAINER_COLORS[colorIdx],
    icon: 'fingerprint'
  });
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// ========== Login handlers ==========
async function handleSingleLogin(account, image) {
  try {
    const container = await getOrCreateContainer(account);
    const credentials = {
      email: account.email,
      password: account.password,
      image: image || null,
      loggedIn: false
    };

    const existingTabs = await api.tabs.query({ cookieStoreId: container.cookieStoreId });
    let targetTab = existingTabs.find(t =>
      t.url && (t.url.includes('kling.ai') || t.url.includes('klingai.com'))
    );

    if (targetTab) {
      pendingLogins.set(targetTab.id, credentials);
      await api.tabs.update(targetTab.id, { active: true, url: KLING_APP_URL });
      if (targetTab.windowId) {
        await api.windows.update(targetTab.windowId, { focused: true });
      }
    } else {
      const newTab = await api.tabs.create({
        url: KLING_APP_URL,
        active: true,
        cookieStoreId: container.cookieStoreId
      });
      pendingLogins.set(newTab.id, credentials);
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleBulkLogin(tasks) {
  if (!api.contextualIdentities) {
    return { success: false, error: 'Không hỗ trợ Container Tabs' };
  }

  const containers = await Promise.all(tasks.map(t => getOrCreateContainer(t.account)));

  const results = await Promise.allSettled(tasks.map(async ({ account, image }, i) => {
    const container = containers[i];
    const credentials = {
      email: account.email,
      password: account.password,
      image: image || null,
      loggedIn: false
    };

    const tabOptions = {
      url: KLING_APP_URL,
      active: i === 0,
      cookieStoreId: container.cookieStoreId
    };

    const newTab = await api.tabs.create(tabOptions);
    pendingLogins.set(newTab.id, credentials);
    return true;
  }));

  let opened = results.filter(r => r.status === 'fulfilled' && r.value).length;
  return { success: true, opened };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ========== Download video handler ==========
async function handleDownloadVideo() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) throw new Error('Không tìm thấy tab');

  if (!tab.url || (!tab.url.includes('kling.ai') && !tab.url.includes('klingai.com'))) {
    throw new Error('Không phải trang KlingAI');
  }

  const response = await api.tabs.sendMessage(tab.id, { type: 'DOWNLOAD_VIDEO' });
  if (!response?.success) {
    throw new Error(response?.error || 'Lỗi không xác định');
  }

  return { success: true, count: response.count || 1 };
}

// ========== Continue login handler ==========
async function handleContinueLogin() {
  const tabIds = [...pausedLogins];
  if (tabIds.length === 0) throw new Error('Không có tài khoản nào đang chờ');

  let continued = 0;
  for (const tabId of tabIds) {
    try {
      await api.tabs.sendMessage(tabId, { type: 'CONTINUE_LOGIN' });
      pausedLogins.delete(tabId);
      continued++;
    } catch (e) {
      pausedLogins.delete(tabId);
    }
  }
  expectedPaused = 0;
  return { success: true, count: continued };
}

// ========== Cleanup ==========
api.tabs.onRemoved.addListener(tabId => {
  pendingLogins.delete(tabId);
  pausedLogins.delete(tabId);
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && pendingLogins.has(tabId)) {
    if (!changeInfo.url.includes('kling.ai') && !changeInfo.url.includes('klingai.com')) {
      pendingLogins.delete(tabId);
    }
  }
});

// ========== Startup ==========
(async function startup() {
  try {
    const stored = await browser.storage.local.get(['proxyEnabled', 'proxyConfig', 'proxyIndex', 'proxyTotal']);
    proxyEnabled = stored.proxyEnabled || false;
    proxyConfig = stored.proxyConfig || null;
    proxyIndex = stored.proxyIndex || 0;
    proxyTotal = stored.proxyTotal || 0;
    updateProxyIcon();
    if (proxyEnabled && proxyConfig) {
      setTimeout(async () => { currentIp = await checkCurrentIp(); }, 2000);
    }
  } catch (e) {}
})();
