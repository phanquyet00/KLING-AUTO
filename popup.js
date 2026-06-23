const api = typeof browser !== 'undefined' ? browser : chrome;

const STORAGE_ACCOUNTS = 'kling_accounts';
const STORAGE_CONFIG = 'kling_config';

let accounts = [];
let imagesCache = [];
let config = { autoUpload: false, overflowMode: 'loop' };
let selectedIds = new Set();
let previewUrls = [];

const $ = id => document.getElementById(id);

// ========== Storage ==========
async function loadAll() {
  const r = await api.storage.local.get([STORAGE_ACCOUNTS, STORAGE_CONFIG]);
  accounts = r[STORAGE_ACCOUNTS] || [];
  config = Object.assign({
    autoUpload: false,
    overflowMode: 'loop',
    autoPrompt: false,
    prompts: [],
    autoMode: false,
    mode3: false,
    loginOffset: 0,
    autoProxy: false
  }, r[STORAGE_CONFIG] || {});
  await reloadImagesCache();
}


function updateBatchIndicator() {
  const totalBatches = Math.max(1, Math.ceil(accounts.length / 8));
  const currentBatch = Math.min(Math.max(1, Math.floor((config.loginOffset || 0) / 8) + 1), totalBatches);
  const el = $('batchIndicator');
  if (accounts.length < 8) {
    el.textContent = '—';
  } else {
    el.textContent = `Lô ${currentBatch}/${totalBatches}`;
  }
}

function goToBatch(batch) {
  const totalBatches = Math.max(1, Math.ceil(accounts.length / 8));
  if (batch < 1 || batch > totalBatches || accounts.length < 8) return;
  config.loginOffset = (batch - 1) * 8;
  saveConfig();
  updateBatchIndicator();
}

function prevBatch() {
  const currentBatch = Math.floor((config.loginOffset || 0) / 8) + 1;
  goToBatch(currentBatch - 1);
}

function nextBatch() {
  const currentBatch = Math.floor((config.loginOffset || 0) / 8) + 1;
  goToBatch(currentBatch + 1);
}

async function saveAccounts() {
  await api.storage.local.set({ [STORAGE_ACCOUNTS]: accounts });
  updateBatchIndicator();
}

async function saveConfig() {
  await api.storage.local.set({ [STORAGE_CONFIG]: config });
  updateBatchIndicator();
}

async function reloadImagesCache() {
  imagesCache = await dbGetAllImages();
  imagesCache.sort((a, b) => a.addedAt - b.addedAt);
  return imagesCache;
}

// ========== Utils ==========
function showStatus(message, type = 'info', duration = 3000) {
  const status = $('status');
  status.textContent = message;
  status.className = `status show ${type}`;
  if (duration > 0) setTimeout(() => { status.className = 'status'; }, duration);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ========== Image management ==========
function getImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Không đọc được ảnh'));
    };
    img.src = url;
  });
}

async function processImageFile(file) {
  console.log('[Image] Đọc file:', file.name, file.type, formatBytes(file.size));
  const buffer = await file.arrayBuffer();
  const dims = await getImageDimensions(file).catch(() => ({ width: 0, height: 0 }));
  return {
    id: makeId(),
    name: file.name,
    type: file.type,
    size: file.size,
    width: dims.width,
    height: dims.height,
    blob: new Blob([buffer], { type: file.type }),
    addedAt: Date.now()
  };
}

async function addImages(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (files.length === 0) {
    showStatus('Không có file ảnh hợp lệ', 'error');
    return;
  }
  showStatus(`Đang xử lý ${files.length} ảnh...`, 'info', 0);
  
  let added = 0;
  const errors = [];
  for (const file of files) {
    try {
      const record = await processImageFile(file);
      await dbAddImage(record);
      added++;
    } catch (e) {
      console.error('[addImages] Lỗi:', file.name, e);
      errors.push(file.name);
    }
  }
  
  await reloadImagesCache();
  renderImages();
  
  let msg = `Đã thêm ${added} ảnh`;
  if (errors.length > 0) msg += `, ${errors.length} lỗi`;
  showStatus(msg, added > 0 ? 'success' : 'error');
}

async function removeImage(id) {
  await dbDeleteImage(id);
  await reloadImagesCache();
  renderImages();
}

async function clearImages() {
  if (imagesCache.length === 0) return;
  await dbClearImages();
  await reloadImagesCache();
  renderImages();
  showStatus('Đã xóa hết ảnh', 'success');
}

function revokePreviewUrls() {
  for (const url of previewUrls) {
    try { URL.revokeObjectURL(url); } catch (e) {}
  }
  previewUrls = [];
}

function renderImages() {
  revokePreviewUrls();
  const totalSize = imagesCache.reduce((s, img) => s + img.size, 0);
  $('imageCount').textContent = `${imagesCache.length}`;
  $('storageSize').textContent = formatBytes(totalSize);

  const grid = $('imageGrid');
  const zone = $('uploadZone');

  // Giữ lại uploadZone (luôn là cell đầu tiên), xóa hết các children còn lại
  while (grid.children.length > 1) {
    grid.removeChild(grid.lastChild);
  }

  // Upload zone luôn hiển thị với text "+"
  zone.querySelector('span').textContent = '+';

  if (imagesCache.length === 0) return;

  imagesCache.forEach((img, i) => {
    const url = URL.createObjectURL(img.blob);
    previewUrls.push(url);
    const cell = document.createElement('div');
    cell.className = 'image-cell';
    cell.innerHTML = `
      <img src="${url}" alt="${escapeHtml(img.name)}" title="${escapeHtml(img.name)} (${formatBytes(img.size)})">
      <span class="image-index">#${i + 1}</span>
      <button class="image-remove" data-id="${img.id}" title="Xóa">×</button>
    `;
    grid.appendChild(cell);
  });
}

async function getImageRecordForPosition(position) {
  if (imagesCache.length === 0) return null;
  return imagesCache[position % imagesCache.length];
}

// ========== Account management ==========
function renderAccounts() {

  // Sắp xếp: mới nhất lên đầu
  const sorted = [...accounts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const list = $('accountList');
  if (sorted.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>Chưa có tài khoản nào</p><small>Nhập email|password ở ô trên và bấm Thêm</small></div>`;
    updateBatchIndicator();
    return;
  }

  list.innerHTML = sorted.map(acc => {
    const realIndex = accounts.indexOf(acc);
    const label = escapeHtml(acc.label || acc.email.split('@')[0]);
    const email = escapeHtml(acc.email);
    const checked = selectedIds.has(acc.id) ? 'checked' : '';
    return `
      <div class="account-item">
        <input type="checkbox" class="account-checkbox" data-id="${acc.id}" ${checked}>
        <div class="account-info">
          <div class="account-label">${label}</div>
          <div class="account-email">${email}</div>
        </div>
        <div class="account-actions">
          <button class="action-btn login" data-action="login" data-index="${realIndex}">🚀 Login</button>
          <button class="action-btn image-login" data-action="image-login" data-index="${realIndex}" title="Login với ảnh tùy chọn">🖼️</button>
          <button class="action-btn delete" data-action="delete" data-index="${realIndex}">🗑</button>
        </div>
      </div>
    `;
  }).join('');

  updateBatchIndicator();
}

// ========== Bulk parser ==========
function parseLine(line) {
  const cleaned = line.trim();
  if (!cleaned) return null;
  for (const sep of ['|', '\t', ',', ':']) {
    if (cleaned.includes(sep)) {
      const idx = cleaned.indexOf(sep);
      const email = cleaned.substring(0, idx).trim();
      const password = cleaned.substring(idx + 1).trim();
      if (email && password && email.includes('@')) return { email, password };
    }
  }
  const m = cleaned.match(/^(\S+)\s+(\S+)$/);
  if (m && m[1].includes('@')) return { email: m[1], password: m[2] };
  return null;
}

function parseBulkInput(text) {
  const valid = [], invalid = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (p) valid.push(p); else invalid.push(line.trim());
  }
  return { valid, invalid };
}

// ========== Account actions ==========
async function bulkAddAccounts(text) {
  const { valid, invalid } = parseBulkInput(text);
  if (valid.length === 0) throw new Error('Không phân tích được tài khoản nào');
  let added = 0, skipped = 0;
  const newAccounts = [];
  for (const { email, password } of valid) {
    if (accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) { skipped++; continue; }
    newAccounts.push({ id: makeId(), label: '', email, password, createdAt: Date.now() });
    added++;
  }
  accounts.unshift(...newAccounts);
  await saveAccounts();
  renderAccounts();
  let msg = `Đã thêm ${added} tài khoản`;
  if (skipped > 0) msg += `, bỏ qua ${skipped} trùng`;
  if (invalid.length > 0) msg += `, ${invalid.length} dòng lỗi`;
  return msg;
}

async function deleteAccount(index) {
  const acc = accounts[index];
  selectedIds.delete(acc.id);
  accounts.splice(index, 1);
  await saveAccounts();
  renderAccounts();
  showStatus('Đã xóa', 'success');
}

async function loginAccount(index) {
  const acc = accounts[index];
  showStatus(`Đang mở tab ${acc.email}...`, 'info', 0);

  let imagePayload = null;
  if (config.autoUpload) {
    const imgRecord = await getImageRecordForPosition(0);
    if (imgRecord) {
      const dataUrl = await blobToDataUrl(imgRecord.blob);
      imagePayload = { dataUrl, name: imgRecord.name };
    }
  }

  try {
    const response = await api.runtime.sendMessage({
      type: 'AUTO_LOGIN',
      account: { id: acc.id, email: acc.email, password: acc.password },
      image: imagePayload
    });
    if (response?.success) {
      showStatus('Đã mở tab', 'success');
    } else {
      showStatus(response?.error || 'Có lỗi', 'error');
    }
  } catch (e) {
    showStatus('Lỗi: ' + e.message, 'error');
  }
}


async function loginFirst8() {
  const btn = $('login8Btn');
  if (btn.disabled) return;
  btn.disabled = true;
  setTimeout(() => { const b = $('login8Btn'); if (b) b.disabled = false; }, 1000);
  if (accounts.length === 0) {
    showStatus('Không có tài khoản nào', 'error');
    return;
  }
  if (config.autoUpload && imagesCache.length === 0) {
    showStatus('Không có ảnh nào để upload', 'error');
    return;
  }

  const sorted = [...accounts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const batchSize = config.autoUpload ? Math.min(8, accounts.length, imagesCache.length) : Math.min(8, accounts.length);

  const startIdx = Math.min(config.loginOffset || 0, Math.max(0, sorted.length - batchSize));
  const batch = sorted.slice(startIdx, startIdx + batchSize);
  const actualSize = batch.length;

  showStatus(`Đang login ${actualSize} tài khoản...`, 'info', 0);

  const tasks = [];
  for (let i = 0; i < actualSize; i++) {
    const acc = batch[i];
    let imagePayload = null;
    if (config.autoUpload) {
      const imgRecord = imagesCache[i];
      if (imgRecord) {
        const dataUrl = await blobToDataUrl(imgRecord.blob);
        imagePayload = { dataUrl, name: imgRecord.name };
      }
    }
    tasks.push({
      account: { id: acc.id, email: acc.email, password: acc.password },
      image: imagePayload
    });
  }

  try {
    const response = await api.runtime.sendMessage({ type: 'BULK_LOGIN', tasks });
    if (response?.success) {
      showStatus(`Đã mở ${response.opened} tab`, 'success');
      // Đặt tổng số tab cần chờ trước khi chuyển xanh
      api.runtime.sendMessage({ type: 'SET_EXPECTED_PAUSED', count: response.opened });
      updateContinueBtn();
    } else {
      showStatus(response?.error || 'Có lỗi', 'error');
    }
  } catch (e) {
    showStatus('Lỗi: ' + e.message, 'error');
  }
}

async function clearFirst8() {
  const btn = $('clear8Btn');
  if (btn.disabled) return;
  btn.disabled = true;
  setTimeout(() => { const b = $('clear8Btn'); if (b) b.disabled = false; }, 1000);
  if (accounts.length === 0) {
    showStatus('Không có tài khoản nào', 'error');
    return;
  }

  const deleteCount = Math.min(8, accounts.length, imagesCache.length);

  // Xóa ảnh đầu
  for (const img of imagesCache.slice(0, deleteCount)) {
    await dbDeleteImage(img.id);
  }

  // Xóa tài khoản mới nhất
  const sorted = [...accounts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const idsToRemove = new Set(sorted.slice(0, deleteCount).map(a => a.id));
  accounts = accounts.filter(a => !idsToRemove.has(a.id));
  selectedIds.clear();

  await saveAccounts();
  await reloadImagesCache();
  renderAccounts();
  renderImages();
  showStatus(`Đã xóa ${deleteCount} tài khoản + ${deleteCount} ảnh đầu`, 'success');
}

async function copyAccount(index) {
  const acc = accounts[index];
  try {
    await navigator.clipboard.writeText(`${acc.email}\n${acc.password}`);
    showStatus('Đã copy', 'success');
  } catch (e) {
    showStatus('Không copy được', 'error');
  }
}

// ========== Image Picker ==========
function showImagePicker(accountIndex) {
  if (imagesCache.length === 0) {
    showStatus('Chưa có ảnh nào. Tải ảnh lên ở mục bên dưới!', 'error');
    return;
  }

  const acc = accounts[accountIndex];

  // Tạo modal
  const modal = document.createElement('div');
  modal.className = 'image-picker-modal';
  modal.innerHTML = `
    <div class="image-picker-overlay"></div>
    <div class="image-picker-content">
      <div class="image-picker-header">
        <h3>Chọn ảnh cho ${escapeHtml(acc.email)}</h3>
        <button class="image-picker-close">×</button>
      </div>
      <div class="image-picker-grid">
        ${imagesCache.map((img, i) => {
          const url = URL.createObjectURL(img.blob);
          previewUrls.push(url);
          return `
            <div class="image-picker-item" data-index="${i}">
              <img src="${url}" alt="${escapeHtml(img.name)}">
              <div class="image-picker-info">
                <span class="image-picker-number">#${i + 1}</span>
                <span class="image-picker-name">${escapeHtml(img.name)}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Event handlers
  const close = () => {
    modal.remove();
  };

  modal.querySelector('.image-picker-close').addEventListener('click', close);
  modal.querySelector('.image-picker-overlay').addEventListener('click', close);

  modal.querySelector('.image-picker-grid').addEventListener('click', async (e) => {
    const item = e.target.closest('.image-picker-item');
    if (!item) return;

    const imageIndex = parseInt(item.dataset.index);
    close();

    // Login với ảnh đã chọn
    await loginAccountWithImage(accountIndex, imageIndex);
  });
}

async function loginAccountWithImage(accountIndex, imageIndex) {
  const acc = accounts[accountIndex];
  const imgRecord = imagesCache[imageIndex];

  if (!imgRecord) {
    showStatus('Không tìm thấy ảnh', 'error');
    return;
  }

  showStatus(`Đang mở tab ${acc.email} với ảnh #${imageIndex + 1}...`, 'info', 0);

  const dataUrl = await blobToDataUrl(imgRecord.blob);
  const imagePayload = { dataUrl, name: imgRecord.name };

  try {
    const response = await api.runtime.sendMessage({
      type: 'AUTO_LOGIN',
      account: { id: acc.id, email: acc.email, password: acc.password },
      image: imagePayload
    });
    if (response?.success) {
      showStatus(`Đã mở tab với ảnh #${imageIndex + 1}`, 'success');
    } else {
      showStatus(response?.error || 'Có lỗi', 'error');
    }
  } catch (e) {
    showStatus('Lỗi: ' + e.message, 'error');
  }
}


async function clearAllAccounts() {
  if (accounts.length === 0) return;
  accounts = [];
  selectedIds.clear();
  await saveAccounts();
  renderAccounts();
  showStatus('Đã xóa tất cả', 'success');
}

// ========== Init ==========
document.addEventListener('DOMContentLoaded', async () => {
  // Detect sidebar mode
  const params = new URLSearchParams(window.location.search);
  if (params.get('sidebar') === '1') {
    document.body.classList.add('sidebar-mode');
  }
  
  try {
    await loadAll();
  } catch (e) {
    console.error('[Init] loadAll error:', e);
    showStatus('Lỗi tải dữ liệu: ' + e.message, 'error', 0);
  }

  // Luôn cập nhật trạng thái nút tiếp tục
  let autoContinueTriggered = false;
  async function updateContinueBtn() {
    const btn = $('continueBtn');
    try {
      const state = await api.runtime.sendMessage({ type: 'GET_PAUSED_COUNT' });
      if (state?.completed > 0 && state.completed >= (state.expected || 1)) {
        btn.classList.add('ready');
        btn.disabled = false;
        btn.textContent = `✅ Đã login (${state.completed})`;
      } else if (state?.count > 0 && state.count >= (state.expected || 1)) {
        btn.classList.add('ready');
        btn.disabled = false;
        btn.textContent = `▶ Tiếp tục (${state.count})`;
        // Tự động continue nếu tick checkbox Đổi IP
        if (config.autoProxy && !autoContinueTriggered) {
          autoContinueTriggered = true;
          setTimeout(() => btn.click(), 500);
        }
      } else if (state?.count > 0) {
        btn.classList.remove('ready');
        btn.disabled = true;
        btn.textContent = `⏳ Đang điền (${state.count}/${state.expected})...`;
      } else {
        btn.classList.remove('ready');
        btn.disabled = true;
        btn.textContent = '⏸ Đang chờ...';
      }
    } catch (e) {
      btn.classList.remove('ready');
      btn.disabled = true;
      btn.textContent = '⏸ Đang chờ...';
    }
  }
  updateContinueBtn();
  setInterval(updateContinueBtn, 3000); // tự động cập nhật mỗi 3s
  renderAccounts();
  renderImages();
  $('autoUploadEnabled').checked = config.autoUpload;
  $('autoModeEnabled').checked = config.autoMode || false;
  $('mode3Enabled').checked = config.mode3 || false;
  $('autoPromptEnabled').checked = config.autoPrompt || false;
  $('proxyEnabled').checked = config.autoProxy || false;
  $('promptsInput').value = (config.prompts || []).join('\n');

  
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const target = $(`tab-${btn.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });
  
  // Quick add at top of list
  $('quickAddBtn').addEventListener('click', async () => {
    const text = $('quickAddInput').value;
    if (!text.trim()) { showStatus('Hãy nhập thông tin tài khoản', 'error'); return; }
    try {
      const msg = await bulkAddAccounts(text);
      $('quickAddInput').value = '';
      showStatus(msg, 'success', 5000);
    } catch (err) { showStatus(err.message, 'error'); }
  });

  $('quickAddInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      $('quickAddBtn').click();
    }
  });
  $('login8Btn').addEventListener('click', () => { autoContinueTriggered = false; loginFirst8(); });
  $('continueBtn').addEventListener('click', async () => {
    const btn = $('continueBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '▶ Đang xử lý...';
    try {
      // 1. Đổi proxy trước khi login (nếu tick checkbox)
      var autoProxy = config.autoProxy;
      if (autoProxy) {
        var apiKey = $('proxyApiKeyInput') ? ($('proxyApiKeyInput').value.trim() || '') : '';
        if (!apiKey) {
          var storedKey = await api.storage.local.get(['proxy_api_key']);
          apiKey = storedKey.proxy_api_key || 'g6pz3t4v2xkl9en660kd05c1nw9nhyxz7oxw4uai';
        }
        try {
          var proxyResp = await api.runtime.sendMessage({ action: 'refresh', apiKey: apiKey });
          if (proxyResp?.index !== undefined) {
            showStatus('🔀 Proxy #' + (proxyResp.index + 1), 'info', 2000);
            var idxText = $('proxyIndexText');
            if (idxText) idxText.textContent = '#' + (proxyResp.index + 1);
            var totalText = $('proxyTotalText');
            if (totalText) totalText.textContent = proxyResp.total;
            var idxRow = $('proxyIndexRow');
            if (idxRow) idxRow.style.display = 'block';
          }
          // Đợi proxy có hiệu lực
          await new Promise(r => setTimeout(r, 4000));
        } catch (e) {
          // Proxy lỗi vẫn tiếp tục login
        }
      }

      // 2. Submit login
      const r = await api.runtime.sendMessage({ type: 'CONTINUE_LOGIN' });
      if (r?.success) {
        showStatus('✅ Đã login ' + r.count + ' tài khoản', 'success');
        // 3. Tắt proxy sau 3s (nếu có đổi)
        if (autoProxy) {
        setTimeout(() => {
          api.runtime.sendMessage({ action: 'disable' }).catch(() => {});
          showStatus('🌐 Đã tắt proxy', 'info', 2000);
          var display = $('proxyIpDisplay');
          if (display) display.textContent = '--';
          var idxRow2 = $('proxyIndexRow');
          if (idxRow2) idxRow2.style.display = 'none';
          var refBtn = $('proxyRefreshBtn');
          if (refBtn) refBtn.style.display = 'none';
        }, 3000);
      }
      } else {
        showStatus(r?.error || 'Lỗi', 'error');
      }
    } catch (e) {
      showStatus('Lỗi: ' + e.message, 'error');
    }
    setTimeout(updateContinueBtn, 1000);
  });
  $('batchPrev').addEventListener('click', prevBatch);
  $('batchNext').addEventListener('click', nextBatch);
  $('batchIndicator').addEventListener('click', () => {
    if (accounts.length < 8) return;
    const total = Math.ceil(accounts.length / 8);
    const current = Math.floor((config.loginOffset || 0) / 8) + 1;
    const input = prompt(`Chọn lô (1-${total}):`, current);
    if (input === null) return;
    const batch = parseInt(input, 10);
    if (isNaN(batch) || batch < 1 || batch > total) {
      showStatus(`Lô không hợp lệ (1-${total})`, 'error');
      return;
    }
    goToBatch(batch);
  });
  $('downloadVideoBtn').addEventListener('click', async () => {
    try {
      const response = await api.runtime.sendMessage({ type: 'DOWNLOAD_VIDEO' });
      if (response?.success) {
        showStatus('✅ Đã tải ' + (response.count || 1) + ' video', 'success');
        $('downloadVideoBtn').classList.add('btn-success');
        setTimeout(() => $('downloadVideoBtn')?.classList.remove('btn-success'), 1000);
      } else {
        showStatus(response?.error || 'Không tải được', 'error');
      }
    } catch (e) {
      showStatus('Lỗi: ' + e.message, 'error');
    }
  });
  $('clear8Btn').addEventListener('click', clearFirst8);
  
  $('accountList').addEventListener('click', e => {
    if (e.target.classList.contains('account-checkbox')) {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateBatchIndicator();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.index);
    if (btn.dataset.action === 'login') loginAccount(idx);
    else if (btn.dataset.action === 'image-login') showImagePicker(idx);
    else if (btn.dataset.action === 'delete') deleteAccount(idx);
    else if (btn.dataset.action === 'copy') copyAccount(idx);
  });
  
  $('clearAllBtn').addEventListener('click', clearAllAccounts);
  
  // Image tab
  $('autoUploadEnabled').addEventListener('change', async e => {
    config.autoUpload = e.target.checked;
    await saveConfig();
    showStatus(config.autoUpload ? 'Đã bật auto upload' : 'Đã tắt auto upload', 'info');
  });
  
  
  const uploadZone = $('uploadZone');
  uploadZone.addEventListener('click', () => $('imageFile').click());
  $('imageFile').addEventListener('change', e => {
    if (e.target.files.length > 0) addImages(e.target.files);
    e.target.value = '';
  });
  
  uploadZone.addEventListener('dragover', e => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) addImages(e.dataTransfer.files);
  });
  
  $('imageGrid').addEventListener('click', e => {
    if (e.target.classList.contains('image-remove')) {
      removeImage(e.target.dataset.id);
    }
  });
  
  $('clearImagesBtn').addEventListener('click', clearImages);

  // Mode tab
  $('autoModeEnabled').addEventListener('change', async e => {
    config.autoMode = e.target.checked;
    await saveConfig();
    showStatus(config.autoMode ? 'Đã bật chế độ 2.1' : 'Đã tắt chế độ 2.1', 'info');
  });
  $('mode3Enabled').addEventListener('change', async e => {
    config.mode3 = e.target.checked;
    await saveConfig();
    showStatus(config.mode3 ? 'Đã bật chế độ 3.0' : 'Đã tắt chế độ 3.0', 'info');
  });

  // Prompts tab
  $('savePromptsBtn').addEventListener('click', async () => {
    const lines = $('promptsInput').value.split('\n').map(l => l.trim()).filter(l => l);
    config.prompts = lines;
    await saveConfig();
    showStatus(`✅ Đã lưu ${lines.length} prompt`, 'success');
  });
  
  $('autoPromptEnabled').addEventListener('change', async e => {
    config.autoPrompt = e.target.checked;
    await saveConfig();
    showStatus(config.autoPrompt ? 'Đã bật auto generate' : 'Đã tắt auto generate', 'info');
  });

  $('proxyEnabled').addEventListener('change', async e => {
    config.autoProxy = e.target.checked;
    await saveConfig();
    showStatus(config.autoProxy ? '🌐 Đã bật đổi IP khi login' : '🌐 Đã tắt đổi IP', 'info');
  });

  
  // Realtime sync giữa popup và sidebar (cùng mở thì share state qua storage)
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_ACCOUNTS]) {
      accounts = changes[STORAGE_ACCOUNTS].newValue || [];
      renderAccounts();
    }
    if (changes[STORAGE_CONFIG]) {
      config = Object.assign({ autoUpload: false, overflowMode: 'loop' }, changes[STORAGE_CONFIG].newValue || {});
      $('autoUploadEnabled').checked = config.autoUpload;
      $('proxyEnabled').checked = config.autoProxy || false;
      updateBatchIndicator();
    }
  });

  // ========== Proxy tab ==========
  initProxyTab();
});

window.addEventListener('beforeunload', revokePreviewUrls);

// ========== Proxy logic ==========
function initProxyTab() {
  const proxyIpDisplay = $('proxyIpDisplay');
  const proxyCopyIpBtn = $('proxyCopyIpBtn');
  const proxyRefreshBtn = $('proxyRefreshBtn');
  const proxyError = $('proxyError');
  const proxyToast = $('proxyToast');
  const proxyApiKeyInput = $('proxyApiKeyInput');
  const proxyShowKeyBtn = $('proxyShowKeyBtn');
  const proxySaveKeyBtn = $('proxySaveKeyBtn');
  const proxySettingsGroup = $('proxySettingsGroup');
  const proxyIndexRow = $('proxyIndexRow');
  const proxyIndexText = $('proxyIndexText');
  const proxyTotalText = $('proxyTotalText');

  let proxyIsLoading = false;

  function send(msg) {
    return api.runtime.sendMessage(msg);
  }

  function showProxyError(text) {
    proxyError.textContent = text;
    proxyError.style.display = 'block';
  }

  function hideProxyError() {
    proxyError.style.display = 'none';
  }

  function showProxyToast(text, type) {
    proxyToast.textContent = text;
    proxyToast.className = 'proxy-toast ' + type;
    proxyToast.style.display = 'block';
    clearTimeout(proxyToast._timeout);
    proxyToast._timeout = setTimeout(function () { proxyToast.style.display = 'none'; }, 3500);
  }

  function updateProxyUI(state) {
    if (state.currentIp) proxyIpDisplay.textContent = state.currentIp;
    if (state.proxyTotal > 0) {
      proxyIndexText.textContent = '#' + (state.proxyIndex + 1);
      proxyTotalText.textContent = state.proxyTotal;
      proxyIndexRow.style.display = 'block';
    }
  }

  const DEFAULT_API_KEY = 'g6pz3t4v2xkl9en660kd05c1nw9nhyxz7oxw4uai';

  // Hàm lấy API key (input → storage → default)
  async function getApiKey() {
    var key = proxyApiKeyInput.value.trim();
    if (key) return key;
    var r = await api.storage.local.get(['proxy_api_key']);
    if (r.proxy_api_key) { proxyApiKeyInput.value = r.proxy_api_key; return r.proxy_api_key; }
    proxyApiKeyInput.value = DEFAULT_API_KEY;
    return DEFAULT_API_KEY;
  }

  // Hàm lưu API key
  async function saveApiKey(key) {
    await api.storage.local.set({ proxy_api_key: key });
  }

  // Init
  (async function () {
    try {
      await getApiKey();
      var state = await send({ action: 'getState' });
      updateProxyUI(state);
    } catch (e) {}
  })();

  // Refresh
  proxyRefreshBtn.addEventListener('click', async function () {
    if (proxyIsLoading) return;
    hideProxyError();
    proxyIsLoading = true;
    proxyRefreshBtn.disabled = true;
    proxyRefreshBtn.textContent = '⏳ Đang đổi IP...';

    var apiKey = await getApiKey();
    try {
      var resp = await send({ action: 'refresh', apiKey: apiKey });
      if (resp.error) throw new Error(resp.error);
      if (resp.index !== undefined && resp.total) {
        proxyIndexText.textContent = '#' + (resp.index + 1);
        proxyTotalText.textContent = resp.total;
      }
      showProxyToast('Đã chọn proxy #' + (resp.index + 1) + ' 🔄', 'success');
      proxyIpDisplay.textContent = 'Đang kiểm tra...';
      setTimeout(async function () {
        var ipResp = await send({ action: 'checkIp' }).catch(() => {});
        if (ipResp && ipResp.ip) proxyIpDisplay.textContent = ipResp.ip;
      }, 2000);
      // Tự động tắt proxy sau 4s
      setTimeout(() => { send({ action: 'disable' }).catch(() => {}); }, 4000);
    } catch (err) {
      showProxyError(err.message);
    } finally {
      proxyIsLoading = false;
      proxyRefreshBtn.disabled = false;
      proxyRefreshBtn.textContent = '🔄 Đổi IP khác';
    }
  });

  // Copy IP
  proxyCopyIpBtn.addEventListener('click', async function () {
    var ip = proxyIpDisplay.textContent;
    if (!ip || ip === '--' || ip === 'Đang kiểm tra...') return;
    try {
      await navigator.clipboard.writeText(ip);
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = ip;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    proxyCopyIpBtn.textContent = '✅';
    setTimeout(function () { proxyCopyIpBtn.textContent = '📋'; }, 1500);
  });

  // API Key auto-save khi gõ (lưu vào cả 2 nơi)
  proxyApiKeyInput.addEventListener('input', async function () {
    var key = proxyApiKeyInput.value.trim();
    if (key && key.length > 10) {
      await saveApiKey(key);
    }
  });

  // API Key save button
  proxySaveKeyBtn.addEventListener('click', async function () {
    var key = proxyApiKeyInput.value.trim();
    if (!key) {
      showProxyError('Vui lòng nhập API Key.');
      return;
    }
    await saveApiKey(key);
    showProxyToast('Đã lưu ✅', 'success');
    proxySettingsGroup.open = false;
  });

  // Show/hide key
  proxyShowKeyBtn.addEventListener('click', function () {
    proxyApiKeyInput.type = proxyApiKeyInput.type === 'password' ? 'text' : 'password';
    proxyShowKeyBtn.textContent = proxyApiKeyInput.type === 'password' ? '👁' : '🙈';
  });
}
