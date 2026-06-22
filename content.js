(function() {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  
  // ========== Utils ==========
  // Timer không bị throttled: relay qua background script
  function sleep(ms) {
    return new Promise(r => {
      api.runtime.sendMessage({ type: 'TIMER_SLEEP', ms }, response => {
        r();
      });
    });
  }
  
  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }
  
  function cleanText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  
  function isClickable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A') return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    if (el.onclick) return true;
    try {
      if (window.getComputedStyle(el).cursor === 'pointer') return true;
    } catch (e) {}
    return false;
  }
  
  function findClickableByText(text, options = {}) {
    const target = text.toLowerCase().trim();
    const exact = options.exact !== false;
    const root = options.root || document;
    
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const matches = [];
    let node;
    while (node = walker.nextNode()) {
      const t = node.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t) continue;
      if (exact ? (t === target) : t.includes(target)) {
        const parent = node.parentElement;
        if (parent && isVisible(parent)) matches.push(parent);
      }
    }
    
    for (const el of matches) {
      let cur = el;
      for (let i = 0; i < 6 && cur; i++) {
        if (isClickable(cur) && isVisible(cur)) return cur;
        cur = cur.parentElement;
      }
      return el;
    }
    return null;
  }
  
  function waitFor(checkFn, timeout = 0, interval = 200) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = async () => {
        try {
          const r = checkFn();
          if (r) return resolve(r);
        } catch (e) {}
        if (timeout > 0 && Date.now() - start > timeout) return reject(new Error('Timeout'));
        await sleep(interval);
        tick();
      };
      tick();
    });
  }
  
  function getNativeInputValueSetter(el) {
    const tag = el.tagName;
    if (tag === 'INPUT') return Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (tag === 'TEXTAREA') return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    return Object.getOwnPropertyDescriptor(el, 'value')?.set;
  }
  
  async function typeNaturally(element, text) {
    element.focus();
    element.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sleep(50);

    const setter = getNativeInputValueSetter(element);
    if (element.value) {
      setter?.call(element, '');
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      await sleep(30);
    }

    // Gõ thẳng 1 lần, không gõ từng chữ (tự động không cần giả lập người dùng)
    setter?.call(element, text);
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: text
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(80);
  }
  
  function realClick(element) {
    const opts = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent('mousedown', opts));
    element.dispatchEvent(new MouseEvent('mouseup', opts));
    element.dispatchEvent(new MouseEvent('click', opts));
  }
  
  function isAlreadyLoggedIn() {
    const signInBtn = document.querySelector('.user-profile-link');
    if (signInBtn && cleanText(signInBtn).includes('sign in')) return false;
    for (const sel of ['[class*="avatar" i]', '[class*="user-menu" i]', 'img[alt*="avatar" i]']) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return true;
      } catch (e) {}
    }
    return false;
  }
  
  // ========== Đóng popup ==========
  async function closeAnyPopup() {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
    }));
    await sleep(500);
    
    const closeSelectors = [
      '.el-dialog__close',
      '.el-drawer__close-btn',
      '.el-message-box__close',
      '[aria-label="Close"]'
    ];
    
    for (const sel of closeSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el && isVisible(el)) {
            console.log('[KlingAutoLogin] Đóng popup:', sel);
            realClick(el);
            await sleep(300);
          }
        }
      } catch (e) {}
    }
    
    const voiceText = findClickableByText('select voice', { exact: false });
    if (voiceText) {
      const container = voiceText.closest('.el-dialog, .el-drawer, [class*="dialog" i], [class*="modal" i]');
      if (container) {
        const closeBtn = container.querySelector('[class*="close" i]');
        if (closeBtn && isVisible(closeBtn)) {
          console.log('[KlingAutoLogin] Đóng popup Select Voice');
          realClick(closeBtn);
          await sleep(400);
        }
      }
    }
    
    await sleep(400);
  }
  
  // ========== Login ==========
  async function performLogin(credentials) {
    console.log('[KlingAutoLogin] Bắt đầu login:', credentials.email);
    showToast(`🔄 Đang đăng nhập ${credentials.email}...`, 'info');
    
    try {
      await sleep(800);

      if (isAlreadyLoggedIn()) {
        showToast('ℹ️ Đã login sẵn', 'info');
        api.runtime.sendMessage({ type: 'LOGIN_SUCCESS' });
        await runFullFlow(credentials.image);
        api.runtime.sendMessage({ type: 'UPLOAD_DONE' });
        return;
      }

      console.log('[KlingAutoLogin] Bước 1: Sign In');
      const signInBtn = await waitFor(() => {
        const direct = document.querySelector('.user-profile-link');
        if (direct && isVisible(direct) && cleanText(direct).includes('sign in')) return direct;
        return findClickableByText('sign in', { exact: true });
      }, 0);
      realClick(signInBtn);
      await sleep(800);

      console.log('[KlingAutoLogin] Bước 2: Email method');
      const emailMethodBtn = await waitFor(() => {
        return findClickableByText('sign in with email', { exact: true }) ||
               findClickableByText('sign in with email', { exact: false });
      }, 0);
      realClick(emailMethodBtn);
      await sleep(800);

      const emailInput = await waitFor(() => {
        for (const inp of document.querySelectorAll('input')) {
          if (!isVisible(inp)) continue;
          const placeholder = (inp.placeholder || '').toLowerCase();
          const type = (inp.type || '').toLowerCase();
          if (type === 'email' || placeholder.includes('email')) return inp;
        }
        return null;
      }, 0);
      await typeNaturally(emailInput, credentials.email);

      const passwordInput = await waitFor(() => {
        for (const inp of document.querySelectorAll('input[type="password"]')) {
          if (isVisible(inp)) return inp;
        }
        return null;
      }, 0);
      await typeNaturally(passwordInput, credentials.password);
      await sleep(300);

      const submitBtn = await waitFor(() => {
        const form = passwordInput.closest('form');
        const container = form || passwordInput.closest('div[class*="login" i]') ||
                         passwordInput.closest('div[class*="form" i]') ||
                         passwordInput.parentElement?.parentElement?.parentElement;
        if (container) {
          const btn = findClickableByText('sign in', { exact: true, root: container });
          if (btn && btn !== passwordInput) return btn;
        }
        const btn = findClickableByText('sign in', { exact: true });
        if (btn) return btn;
        return (container || document).querySelector('button[type="submit"]');
      }, 0);

      // Dừng lại chờ người dùng bấm "Tiếp tục" trước khi submit
      showToast(`⏸️ ${credentials.email}: chờ xác nhận...`, 'info');
      api.runtime.sendMessage({ type: 'LOGIN_PAUSED' });
      await new Promise(resolve => { window.__continueLogin = resolve; });
      showToast(`▶️ ${credentials.email}: tiếp tục...`, 'info');

      realClick(submitBtn);
      
      showToast('⏳ Đang xử lý...', 'info');
      await waitForLoginSuccess();
      
      showToast(`✅ Login thành công`, 'success');
      api.runtime.sendMessage({ type: 'LOGIN_SUCCESS' });
      await sleep(3000);
      
      if (!window.location.pathname.includes('/app/video/new')) {
        window.location.href = 'https://kling.ai/app/video/new';
      } else {
        await runFullFlow(credentials.image);
        api.runtime.sendMessage({ type: 'UPLOAD_DONE' });
      }
      
    } catch (e) {
      console.error('[KlingAutoLogin] Lỗi:', e);
      showToast(`❌ ${e.message}`, 'error');
      api.runtime.sendMessage({ type: 'LOGIN_RESULT', success: false, error: e.message });
    }
  }
  
  async function waitForLoginSuccess(timeout = 600000) {
    const start = Date.now();
    while (true) {
      if (timeout > 0 && Date.now() - start > timeout) {
        throw new Error('Timeout chờ login');
      }

      const stillHasForm = document.querySelector('input[type="password"]');
      if (!stillHasForm) {
        await sleep(1000);
        if (!document.querySelector('input[type="password"]')) return true;
      }

      const captcha = document.querySelector(
        'iframe[src*="captcha" i], iframe[title*="captcha" i], [class*="geetest" i], [class*="captcha" i]'
      );
      if (captcha && isVisible(captcha)) {
        showToast('🤖 Có CAPTCHA, vui lòng giải tay', 'info');
        await sleep(2000);
        continue;
      }

      const errorEls = document.querySelectorAll('[role="alert"], [class*="error" i]:not(input):not(form)');
      for (const errEl of errorEls) {
        if (!isVisible(errEl)) continue;
        const text = errEl.textContent.trim();
        if (text.length > 0 && text.length < 200 &&
            text.match(/incorrect|invalid|wrong|sai|không đúng|fail/i)) {
          throw new Error('Login fail: ' + text);
        }
      }
      await sleep(500);
    }
  }
  
  // ========== Full flow: Login → Trigger upload → Model/Quality → Wait image → Generate ==========
  async function runFullFlow(image) {
    await sleep(1000);
    await closeAnyPopup();
    await sleep(400);

    // Đọc config để biết autoMode
    const cfg = await getConfig();

    if (!image) {
      console.log('[KlingAutoLogin] Không có ảnh, bỏ qua upload');
    }

    // BƯỚC 1: Inject file, chờ upload xong, rồi đóng popup
    if (image && image.dataUrl) {
      console.log('[KlingAutoLogin] === BƯỚC 1: UPLOAD ẢNH ===');
      try {
        const injected = await triggerImageUpload(image);
        if (injected) {
          console.log('[KlingAutoLogin] Đã inject file, chờ upload xong...');
          const uploadOk = await waitForImageReady(120000);
          if (!uploadOk) {
            showToast('⚠️ Upload chưa xong, vẫn thử tiếp', 'info');
          }
        }
      } catch (e) {
        console.error('[KlingAutoLogin] Lỗi upload:', e);
      }
      await closeAnyPopup();
      await sleep(500);
    }

    // BƯỚC 2: Chọn model + quality (theo chế độ)
    const modeVer = cfg.mode3 ? '3.0' : (cfg.autoMode ? '2.1' : null);
    if (modeVer) {
      console.log(`[KlingAutoLogin] === BƯỚC 2: CHỌN VIDEO ${modeVer} ===`);
      showToast(`🎯 Đang chuyển sang Video ${modeVer}...`, 'info');
      let modelOk = await selectVideoModel(modeVer);

      if (!modelOk) {
        console.log(`[KlingAutoLogin] Chọn ${modeVer} fail, đóng popup và thử lại...`);
        await closeAnyPopup();
        await sleep(800);
        modelOk = await selectVideoModel(modeVer);
      }

      if (!modelOk) {
        showToast(`❌ Không chọn được Video ${modeVer}, dừng`, 'error');
        return;
      }

      await sleep(800);
      await closeAnyPopup();
      await sleep(400);

      console.log('[KlingAutoLogin] Chọn quality 1080p...');
      await selectQuality('1080p');
      await sleep(800);

      // Các setting riêng cho 3.0
      if (cfg.mode3) {
        console.log('[KlingAutoLogin] Cấu hình setting 3.0...');
        await setupMode3();
      }
    } else {
      console.log('[KlingAutoLogin] Chế độ tự động OFF, bỏ qua chọn model/quality');
    }

    // BƯỚC 3: Auto generate
    console.log('[KlingAutoLogin] === BƯỚC 3: AUTO GENERATE ===');
    await autoGenerateFlow();
  }

  // ========== Image upload ==========
  async function dataUrlToFile(dataUrl, filename) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], filename, { type: blob.type });
  }

  // Chỉ inject file vào input, KHÔNG chờ upload xong
  async function triggerImageUpload(image) {
    if (!image || !image.dataUrl) return false;
    console.log('[KlingAutoLogin] Inject file:', image.name);
    showToast(`📤 Đang upload ảnh ${image.name}...`, 'info');

    try {
      let fileInput = findFileInput();

      if (!fileInput) {
        const addFrameBtn = await waitFor(() => {
          let btn = findClickableByText('add start and end frames', { exact: false });
          if (btn) return btn;
          return findClickableByText('add start', { exact: false });
        }, 10000);

        realClick(addFrameBtn);
        await sleep(1500);

        fileInput = findFileInput() || await waitFor(() => findFileInput(), 5000);
      }

      if (!fileInput) throw new Error('Không tìm thấy ô upload ảnh');

      const file = await dataUrlToFile(image.dataUrl, image.name);
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;

      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      console.log('[KlingAutoLogin] Đã inject file, size:', file.size);
      return true;

    } catch (e) {
      console.error('[KlingAutoLogin] Lỗi inject file:', e);
      showToast(`❌ Upload lỗi: ${e.message}`, 'error');
      return false;
    }
  }

  function findFileInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    for (const inp of inputs) {
      const accept = (inp.accept || '').toLowerCase();
      if (accept.includes('image') || accept === '' || accept === '*') return inp;
    }
    return inputs[0] || null;
  }
  
  // ========== Đợi ảnh upload xong (signal: img có path /ai_portal/) ==========
  async function waitForImageReady(timeout = 120000) {
    console.log('[KlingAutoLogin] Đợi ảnh hiển thị xong...');
    showToast('⏳ Đang chờ upload xong...', 'info');

    const startTime = performance.now();

    function countBigVisibleImages() {
      return Array.from(document.querySelectorAll('img')).filter(i => {
        if (!i.complete || i.naturalWidth === 0) return false;
        const r = i.getBoundingClientRect();
        return r.width > 100 && r.height > 100;
      }).length;
    }

    // Đếm ảnh kimg có URL dài (>200 ký tự) tại thời điểm baseline
    function countUploadedKimgImages() {
      return Array.from(document.querySelectorAll('img[src*="kimg"]')).filter(img => {
        if (!img.complete || img.naturalWidth === 0) return false;
        const r = img.getBoundingClientRect();
        if (r.width < 100) return false;
        return (img.src || '').length > 200;
      }).length;
    }

    const baselineBigImages = countBigVisibleImages();
    const baselineKimgLong = countUploadedKimgImages();
    console.log(`[KlingAutoLogin] Baseline: big=${baselineBigImages}, kimg_long=${baselineKimgLong}`);

    while (performance.now() - startTime < timeout) {
      // Chỉ báo upload xong nếu số ảnh kimg URL dài TĂNG lên so với baseline
      const curKimgLong = countUploadedKimgImages();
      if (curKimgLong > baselineKimgLong) {
        await sleep(2000); // đợi thêm 2s cho ảnh xử lý xong trên server
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`[KlingAutoLogin] ✅ Upload xong sau ${elapsed}s (kimg: ${baselineKimgLong}→${curKimgLong})`);
        showToast(`✅ Ảnh sẵn sàng (${elapsed}s)`, 'success');
        return true;
      }

      // Backup: tổng ảnh visible tăng ≥ 2
      const curBig = countBigVisibleImages();
      if (curBig >= baselineBigImages + 2) {
        await sleep(2000);
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`[KlingAutoLogin] ✅ Upload xong sau ${elapsed}s (big: ${baselineBigImages}→${curBig})`);
        showToast(`✅ Ảnh sẵn sàng (${elapsed}s)`, 'success');
        return true;
      }

      await sleep(500);
    }

    console.log('[KlingAutoLogin] ⚠️ Timeout chờ upload');
    showToast('⚠️ Timeout, vẫn tiếp tục', 'info');
    return false;
  }
  
  // ========== Select Video Model ==========
  async function selectVideoModel(version = '2.1') {
    console.log(`[KlingAutoLogin] === Bắt đầu chọn Video ${version} ===`);
    
    try {
      // Chờ đúng trang
      let retries = 0;
      while (!window.location.pathname.includes('/app/video/new') && retries < 20) {
        await sleep(500);
        retries++;
      }
      await sleep(800);

      const modelHeader = document.querySelector('.ai-web-select-model-version');
      if (!modelHeader) {
        console.log('[KlingAutoLogin] [FAIL] Không thấy header');
        return false;
      }
      
      function getCurrentName() {
        const el = modelHeader.querySelector('.name-new, .model-name');
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      }
      
      const currentName = getCurrentName();
      console.log('[KlingAutoLogin] Model hiện tại:', currentName);
      
      const targetText = `VIDEO ${version}`;
      if (currentName.toLowerCase() === targetText.toLowerCase()) {
        console.log(`[KlingAutoLogin] [OK] Đã ở ${targetText}`);
        return true;
      }
      
      const input = modelHeader.querySelector('input[role="combobox"]');
      if (!input) return false;
      
      // Mở dropdown bằng keyboard — hoạt động cả khi tab ẩn (không cần hasFocus)
      input.focus();
      await sleep(300);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(600);
      
      // Dùng CSS check thay vì getBoundingClientRect (rect = 0 khi tab ẩn)
      function listAllLIs() {
        const arr = [];
        for (const li of document.querySelectorAll('li.el-select-dropdown__item')) {
          const style = window.getComputedStyle(li);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          arr.push(li);
        }
        return arr;
      }
      
      function findTargetLI(ver) {
        const targetExact = `video ${ver}`.toLowerCase();
        for (const li of listAllLIs()) {
          const span = li.querySelector('.model-name');
          if (!span) continue;
          const text = (span.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (text === targetExact) return li;
        }
        return null;
      }
      
      let allLIs = listAllLIs();
      console.log(`[KlingAutoLogin] LI count: ${allLIs.length}`);
      if (allLIs.length === 0) return false;
      
      // Thử tìm target trước khi click More
      let targetLI = findTargetLI(version);
      
      if (!targetLI) {
        // Click đúng selector: 'li.more-option .more' (đã verify qua debug)
        console.log('[KlingAutoLogin] Click More để expand...');
        const moreDiv = document.querySelector('li.more-option .more');
        if (!moreDiv) {
          console.log('[KlingAutoLogin] Không thấy li.more-option .more');
          return false;
        }
        
        moreDiv.click();
        await sleep(800);

        const newLIs = listAllLIs();
        console.log(`[KlingAutoLogin] LI sau More: ${newLIs.length}`);

        // Nếu chưa expand, thử click lần 2
        if (newLIs.length <= allLIs.length) {
          console.log('[KlingAutoLogin] More chưa expand, thử lại...');
          await sleep(500);
          moreDiv.click();
          await sleep(800);
        }
        
        targetLI = findTargetLI(version);
      }
      
      if (!targetLI) {
        const allTexts = listAllLIs().map(li => {
          const span = li.querySelector('.model-name');
          return span ? span.textContent.trim() : '?';
        });
        console.log('[KlingAutoLogin] Available models:', allTexts);
        showToast(`❌ Không thấy ${targetText}`, 'error');
        document.body.click();
        await sleep(500);
        return false;
      }
      
      // Click LI target
      console.log(`[KlingAutoLogin] Click ${targetText}`);
      targetLI.click();
      await sleep(700);

      const finalName = getCurrentName();
      if (finalName.toLowerCase() === targetText.toLowerCase()) {
        console.log(`[KlingAutoLogin] ✅ Đã chọn ${targetText}`);
        showToast(`✅ Đã chọn Video ${version}`, 'success');
        return true;
      }

      // Thử click span bên trong nếu click LI chưa work
      const span = targetLI.querySelector('.model-name');
      if (span) {
        span.click();
        await sleep(700);
        if (getCurrentName().toLowerCase() === targetText.toLowerCase()) {
          console.log(`[KlingAutoLogin] ✅ Đã chọn ${targetText} (span click)`);
          showToast(`✅ Đã chọn Video ${version}`, 'success');
          return true;
        }
      }
      
      console.log(`[KlingAutoLogin] [FAIL] Model hiện tại: ${getCurrentName()}`);
      return false;
      
    } catch (e) {
      console.error('[KlingAutoLogin] Lỗi:', e);
      return false;
    }
  }
  
  // ========== Auto Generate ==========
  async function getConfig() {
    try {
      const r = await api.storage.local.get('kling_config');
      return Object.assign({ autoPrompt: false, prompts: [], autoMode: false, mode3: false }, r.kling_config || {});
    } catch (e) {
      return { autoPrompt: false, prompts: [], autoMode: false, mode3: false };
    }
  }
  
  function getCurrentCredits() {
    const valueEl = document.querySelector('.point-box .value');
    if (!valueEl) return null;
    const num = parseInt((valueEl.textContent || '').replace(/[^\d]/g, ''), 10);
    return isNaN(num) ? null : num;
  }
  
  function findPromptInput() {
    const tiptaps = document.querySelectorAll('.tiptap.ProseMirror, [contenteditable="true"]');
    let biggest = null;
    let maxArea = 0;
    for (const t of tiptaps) {
      if (!isVisible(t)) continue;
      const rect = t.getBoundingClientRect();
      if (rect.width < 200) continue;
      const area = rect.width * rect.height;
      if (area > maxArea) {
        maxArea = area;
        biggest = t;
      }
    }
    return biggest;
  }
  
  function findProseMirrorView(promptEl) {
    if (promptEl.pmViewDesc) {
      let desc = promptEl.pmViewDesc;
      while (desc) {
        if (desc.editorView || desc.view) return desc.editorView || desc.view;
        desc = desc.parent;
      }
    }
    if (promptEl.editor && promptEl.editor.view) return promptEl.editor.view;
    for (const key of Object.keys(promptEl)) {
      const val = promptEl[key];
      if (val && typeof val === 'object') {
        if (val.dispatch && val.state) return val;
        if (val.view && val.view.dispatch && val.view.state) return val.view;
      }
    }
    return null;
  }
  
  // Fill prompt với 3 chiến lược (Cách B paste đã verify hoạt động)
  async function fillPromptText(element, text) {
    console.log('[KlingAutoLogin] Bắt đầu fill prompt:', text.substring(0, 50));
    
    element.focus();
    element.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sleep(300);
    
    function getText() {
      return (element.textContent || '').trim();
    }
    
    function isFilled() {
      const cur = getText();
      const checkLen = Math.min(20, text.length);
      return cur.includes(text.substring(0, checkLen));
    }
    
    // Cách A: ProseMirror View API
    console.log('[KlingAutoLogin] Thử cách A: ProseMirror View API');
    try {
      const view = findProseMirrorView(element);
      if (view && view.state && view.dispatch) {
        const docSize = view.state.doc.content.size;
        if (docSize > 2) {
          view.dispatch(view.state.tr.delete(0, docSize - 2));
          await sleep(200);
        }
        const tr = view.state.tr.insertText(text);
        view.dispatch(tr);
        await sleep(500);
        
        if (isFilled()) {
          console.log('[KlingAutoLogin] ✅ Cách A thành công, length:', getText().length);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        console.log('[KlingAutoLogin] Cách A: dispatch ok nhưng text không khớp');
      } else {
        console.log('[KlingAutoLogin] Cách A: không tìm thấy view');
      }
    } catch (e) {
      console.log('[KlingAutoLogin] Cách A lỗi:', e.message);
    }
    
    // Cách B: Clipboard paste event (đã verify hoạt động qua log thực tế)
    console.log('[KlingAutoLogin] Thử cách B: Clipboard paste');
    try {
      element.focus();
      await sleep(150);
      
      try { document.execCommand('selectAll', false); } catch (e) {}
      await sleep(100);
      try { document.execCommand('delete', false); } catch (e) {}
      await sleep(150);
      
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      
      element.dispatchEvent(pasteEvent);
      await sleep(700);
      
      if (isFilled()) {
        console.log('[KlingAutoLogin] ✅ Cách B thành công, length:', getText().length);
        return true;
      }
      console.log('[KlingAutoLogin] Cách B: paste ok nhưng text không khớp');
    } catch (e) {
      console.log('[KlingAutoLogin] Cách B lỗi:', e.message);
    }
    
    // Cách C: execCommand insertText (fallback)
    console.log('[KlingAutoLogin] Thử cách C: execCommand insertText');
    try {
      element.focus();
      await sleep(150);
      
      try {
        document.execCommand('selectAll', false);
        await sleep(80);
        document.execCommand('delete', false);
        await sleep(100);
      } catch (e) {}
      
      document.execCommand('insertText', false, text);
      await sleep(500);
      
      if (isFilled()) {
        console.log('[KlingAutoLogin] ✅ Cách C thành công, length:', getText().length);
        return true;
      }
    } catch (e) {
      console.log('[KlingAutoLogin] Cách C lỗi:', e.message);
    }
    
    console.log('[KlingAutoLogin] ❌ Cả 3 cách đều fail. Final text:', getText().substring(0, 60));
    return false;
  }
  
  async function selectQuality(quality) {
    console.log(`[KlingAutoLogin] Chọn ${quality}...`);
    
    const trigger = await waitFor(() => {
      const t = document.querySelector('.setting-collect-box .setting-select');
      return t && isVisible(t) ? t : null;
    }, 8000);
    
    if ((trigger.textContent || '').toLowerCase().includes(quality.toLowerCase())) {
      console.log(`[KlingAutoLogin] Đã ở ${quality}`);
      return;
    }
    
    realClick(trigger);
    await sleep(500);

    const option = await waitFor(() => {
      for (const inn of document.querySelectorAll('.inner')) {
        if (!isVisible(inn)) continue;
        if (cleanText(inn) === quality.toLowerCase()) return inn;
      }
      return null;
    }, 5000);

    let target = option;
    for (let i = 0; i < 6; i++) {
      if (isClickable(target)) break;
      if (target.parentElement) target = target.parentElement;
      else break;
    }

    realClick(target);
    await sleep(500);
  }

  // ========== Cấu hình setting riêng cho chế độ 3.0 ==========
  async function setupMode3() {
    console.log('[KlingAutoLogin] === SETTING 3.0 ===');

    try {
      // 1. Bật Native Audio (nếu có checkbox)
      const nativeSwitch = document.querySelector('.setting-switch');
      if (nativeSwitch) {
        const isChecked = nativeSwitch.querySelector('[href*="checkbox-checked"], [xlink\\:href*="checkbox-checked"]');
        if (!isChecked) {
          console.log('[KlingAutoLogin] Bật Native Audio...');
          realClick(nativeSwitch);
          await sleep(500);
        } else {
          console.log('[KlingAutoLogin] Native Audio đã bật');
        }
      }

      // 2. Click Custom Multi-Shot (không phải Multi-Shot toggle)
      const allBtns = document.querySelectorAll('.feature-btn');
      let customBtn = null;
      for (const btn of allBtns) {
        if ((btn.textContent || '').includes('Custom Multi-Shot')) {
          customBtn = btn;
          break;
        }
      }
      if (customBtn) {
        console.log('[KlingAutoLogin] Click Custom Multi-Shot...');
        customBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await sleep(300);
        customBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await sleep(1000);
      } else {
        console.log('[KlingAutoLogin] ❌ Không tìm thấy Custom Multi-Shot');
      }

      // 3. Set Length slider về 8s
      const qualityTrigger = document.querySelector('.setting-collect-box .setting-select');
      if (qualityTrigger) {
        console.log('[KlingAutoLogin] Mở quality popup để chỉnh slider...');
        realClick(qualityTrigger);
        await sleep(1200);

        // Click trực tiếp vào runway tại vị trí 8s dùng elementFromPoint
        const sliderRunway = document.querySelector('.el-slider__runway');
        if (sliderRunway) {
          const min = 3, max = 15, target = 8;
          const rect = sliderRunway.getBoundingClientRect();
          const percent = (target - min) / (max - min);
          const clickX = rect.left + rect.width * percent;
          const clickY = rect.top + rect.height / 2;

          // elementFromPoint trả về element thực sự dưới con trỏ
          const targetEl = document.elementFromPoint(clickX, clickY);
          if (targetEl) {
            console.log('[KlingAutoLogin] Click vào ' + targetEl.tagName + '.' + (targetEl.className || ''));
            targetEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: clickX, clientY: clickY }));
            await sleep(50);
            targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: clickX, clientY: clickY }));
            await sleep(500);
          }

          const btnWrapper = document.querySelector('.el-slider__button-wrapper');
          if (btnWrapper) {
            const now = btnWrapper.getAttribute('aria-valuenow');
            console.log('[KlingAutoLogin] Slider sau khi click: ' + now + 's');
          }
        }

        // Đóng popup quality
        document.body.click();
        await sleep(300);
      }

      console.log('[KlingAutoLogin] ✅ Đã cấu hình setting 3.0');
    } catch (e) {
      console.error('[KlingAutoLogin] Lỗi setting 3.0:', e);
    }
  }

let generateClicked = false;
let generateClickTime = 0;

async function clickGenerate() {
  const now = Date.now();
  const timeSinceLastClick = now - generateClickTime;

  console.log('[KlingAutoLogin] === DEBUG clickGenerate() ===');
  console.log('[KlingAutoLogin] generateClicked:', generateClicked);
  console.log('[KlingAutoLogin] Time since last click:', timeSinceLastClick, 'ms');

  // Tránh click Generate nhiều lần
  if (generateClicked) {
    console.log('[KlingAutoLogin] ❌ Generate đã được click, BỎ QUA');
    return;
  }

  // Tránh click quá nhanh (< 10 giây)
  if (timeSinceLastClick < 10000 && generateClickTime > 0) {
    console.log('[KlingAutoLogin] ❌ Click quá nhanh, BỎ QUA');
    return;
  }

  console.log('[KlingAutoLogin] Tìm nút Generate...');

  const btn = await waitFor(() => {
    const directBtn = document.querySelector('.button-pay');

    if (directBtn && isVisible(directBtn)) {
      const text = (directBtn.textContent || '').toLowerCase();

      if (text.includes('generate')) return directBtn;
    }

    return findClickableByText('generate', { exact: false });

  }, 8000);

  console.log('[KlingAutoLogin] Tìm thấy nút:', btn);
  console.log('[KlingAutoLogin] Nút text:', btn.textContent);
  console.log('[KlingAutoLogin] Nút disabled:', btn.disabled);

  // Kiểm tra nút đã disabled chưa
  if (btn.disabled) {
    console.log('[KlingAutoLogin] ❌ Nút đã disabled, BỎ QUA');
    return;
  }

  console.log('[KlingAutoLogin] ✅ Click Generate');

  // Đánh dấu đã click
  generateClicked = true;
  generateClickTime = now;

  // Đợi một chút trước khi click (giả lập user đọc)
  await sleep(500 + Math.random() * 500);

  // Click tự nhiên hơn: mousedown → mouseup → click
  const opts = { bubbles: true, cancelable: true, view: window };
  btn.dispatchEvent(new MouseEvent('mouseenter', opts));
  await sleep(50);
  btn.dispatchEvent(new MouseEvent('mouseover', opts));
  await sleep(50);
  btn.dispatchEvent(new MouseEvent('mousedown', opts));
  await sleep(80 + Math.random() * 40);
  btn.dispatchEvent(new MouseEvent('mouseup', opts));
  await sleep(20);
  btn.dispatchEvent(new MouseEvent('click', opts));

  console.log('[KlingAutoLogin] Đã click với delay tự nhiên');

  // Disable nút sau khi click
  if (btn && btn.disabled !== undefined) {
    btn.disabled = true;
    console.log('[KlingAutoLogin] Đã disable nút Generate');
  }

  await sleep(3000);
  console.log('[KlingAutoLogin] === END clickGenerate() ===');
}
  
  async function waitForCreditsDecrease(prevCredits, timeout = 480000) {
    console.log(`[KlingAutoLogin] Chờ credits giảm từ ${prevCredits}...`);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const current = getCurrentCredits();
      if (current !== null && current < prevCredits) {
        console.log(`[KlingAutoLogin] Credits: ${prevCredits} → ${current}`);
        return current;
      }
      await sleep(3000);
    }
    return getCurrentCredits();
  }
  
  // ========== Auto generate flow: Video 1 (1080p + prompt1) → Chuyển sang prompt2 (720p, không Generate) ==========
  async function autoGenerateFlow() {
    console.log('[KlingAutoLogin] ========================================');
    console.log('[KlingAutoLogin] === BẮT ĐẦU AUTO GENERATE FLOW ===');
    console.log('[KlingAutoLogin] ========================================');

    // Reset flag khi bắt đầu flow mới
    generateClicked = false;
    generateClickTime = 0;
    console.log('[KlingAutoLogin] Reset flags: generateClicked =', generateClicked);

    console.log('[KlingAutoLogin] Đang load config...');
    let cfg;
    try {
      cfg = await getConfig();
      console.log('[KlingAutoLogin] Config loaded:', cfg);
    } catch (e) {
      console.error('[KlingAutoLogin] ❌ Lỗi load config:', e);
      showToast('❌ Lỗi load config', 'error');
      return;
    }

    if (!cfg.autoPrompt) {
      console.log('[KlingAutoLogin] Auto generate OFF, bỏ qua');
      return;
    }

    if (!cfg.prompts || cfg.prompts.length === 0) {
      console.log('[KlingAutoLogin] ❌ Chưa có prompt');
      showToast('⚠️ Chưa có prompt, vào tab 📝 Prompt để thêm', 'error');
      return;
    }

    console.log('[KlingAutoLogin] Số prompt:', cfg.prompts.length);

    // Chọn 2 prompt KHÁC NHAU (nếu có ≥ 2 prompt trong config)
    const allPrompts = [...cfg.prompts];
    const prompt1 = allPrompts[Math.floor(Math.random() * allPrompts.length)];
    let prompt2 = prompt1;

    if (allPrompts.length >= 2) {
      const remaining = allPrompts.filter(p => p !== prompt1);
      prompt2 = remaining[Math.floor(Math.random() * remaining.length)];
    } else {
      console.log('[KlingAutoLogin] ⚠️ Chỉ có 1 prompt, video 2 dùng cùng prompt');
    }

    console.log('[KlingAutoLogin] Prompt 1 (1080p):', prompt1.substring(0, 60));
    console.log('[KlingAutoLogin] Prompt 2 (720p):', prompt2.substring(0, 60));

    try {
      // ===== BƯỚC 1: Video 1 (1080p + prompt1) =====
      console.log('[KlingAutoLogin] ========================================');
      console.log('[KlingAutoLogin] === VIDEO 1 (1080p + prompt1) ===');
      console.log('[KlingAutoLogin] ========================================');
      showToast('🎬 Video 1 (1080p)', 'info');

      // Chọn quality 1080p
      console.log('[KlingAutoLogin] [1/4] Chọn quality 1080p...');
      await selectQuality('1080p');
      await sleep(700);

      // Đóng popup trước khi fill prompt
      await closeAnyPopup();
      await sleep(500);

      // Fill prompt1 (có retry)
      console.log('[KlingAutoLogin] [2/4] Fill prompt1...');
      const promptInput1 = await waitFor(() => findPromptInput(), 30000);
      if (!promptInput1) {
        showToast('❌ Không tìm thấy ô prompt', 'error');
        return;
      }

      showToast('📝 Điền prompt cho Video 1...', 'info');
      const fillOk1 = await fillPromptText(promptInput1, prompt1);
      await sleep(1000);

      if (!fillOk1) {
        showToast('❌ Không điền được prompt, dừng', 'error');
        return;
      }

      // Click Generate
      console.log('[KlingAutoLogin] [3/4] Click Generate...');
      showToast('🚀 Generate Video 1...', 'info');
      const initialCredits = getCurrentCredits();
      console.log(`[KlingAutoLogin] Credits trước Generate: ${initialCredits}`);

      // Scroll nút Generate vào view (giả lập user)
      const generateBtn = document.querySelector('.button-pay');
      if (generateBtn) {
        generateBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(800);
      }

      // Focus vào prompt trước (giả lập user kiểm tra lại)
      if (promptInput1) {
        promptInput1.focus();
        await sleep(300);
        promptInput1.blur();
        await sleep(200);
      }

      await clickGenerate();

      console.log('[KlingAutoLogin] [4/4] Đợi sau click Generate...');
      // Đợi lâu hơn để KlingAI xử lý xong click
      await sleep(5000);

      showToast('✅ Video 1 đã gửi Generate', 'success');
      console.log('[KlingAutoLogin] ✅ Video 1 hoàn thành, chuyển sang Video 2');

      // ===== BƯỚC 2: Chuyển sang Video 2 (720p + prompt2, KHÔNG Generate) =====
      console.log('[KlingAutoLogin] ========================================');
      console.log('[KlingAutoLogin] === VIDEO 2 (720p + prompt2, chuẩn bị) ===');
      console.log('[KlingAutoLogin] ========================================');
      console.log('[KlingAutoLogin] 🚀 BẮT ĐẦU BƯỚC 2 - VIDEO 2');

      // Đóng popup trước khi chuyển sang 720p
      console.log('[KlingAutoLogin] [1/3] Đóng popup...');
      try {
        await closeAnyPopup();
        console.log('[KlingAutoLogin] ✅ Đã đóng popup');
      } catch (e) {
        console.log('[KlingAutoLogin] ⚠️ Lỗi đóng popup:', e.message);
      }
      await sleep(1500);

      showToast('🎬 Chuẩn bị Video 2 (720p)...', 'info');

      // Chọn quality 720p
      console.log('[KlingAutoLogin] [2/3] Chọn quality 720p...');
      try {
        await selectQuality('720p');
        console.log('[KlingAutoLogin] ✅ Đã chọn 720p');
      } catch (e) {
        console.log('[KlingAutoLogin] ❌ Lỗi chọn 720p:', e.message);
        throw e;
      }
      await sleep(2000);

      // Fill prompt2 (có retry)
      console.log('[KlingAutoLogin] [3/3] Fill prompt2...');
      const promptInput2 = await waitFor(() => findPromptInput(), 30000);
      if (!promptInput2) {
        showToast('❌ Không tìm thấy ô prompt', 'error');
        return;
      }

      showToast('📝 Điền prompt cho Video 2...', 'info');
      const fillOk2 = await fillPromptText(promptInput2, prompt2);
      await sleep(1000);

      if (!fillOk2) {
        showToast('❌ Không điền được prompt, dừng', 'error');
        return;
      }

      showToast('✅ Video 2 sẵn sàng (720p + prompt2)', 'success');
      console.log('[KlingAutoLogin] Video 2 đã chuẩn bị, chờ user click Generate');

    } catch (e) {
      console.error('[KlingAutoLogin] ❌ LỖI:', e);
      console.error('[KlingAutoLogin] Stack:', e.stack);
      showToast(`❌ ${e.message}`, 'error');
      return;
    }

    console.log('[KlingAutoLogin] ========================================');
    console.log('[KlingAutoLogin] === KẾT THÚC AUTO GENERATE FLOW ===');
    console.log('[KlingAutoLogin] ========================================');
    showToast('🎉 Hoàn thành! Video 1 đang generate, Video 2 sẵn sàng', 'success');
  }
  
  // ========== Toast ==========
  function showToast(message, type = 'info') {
    const existing = document.getElementById('kling-auto-toast');
    if (existing) existing.remove();
    
    const colors = { success: '#238636', error: '#b62324', info: '#1f6feb' };
    const toast = document.createElement('div');
    toast.id = 'kling-auto-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; top: 20px; right: 20px;
      background: ${colors[type] || colors.info};
      color: white; padding: 12px 18px; border-radius: 6px;
      font-family: -apple-system, sans-serif; font-size: 14px;
      font-weight: 500; z-index: 2147483647;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4); max-width: 360px;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }
  
  // ========== Download handler ==========
  async function handleDownloadClick() {
    console.log('[KlingAutoLogin] === handleDownloadClick() ===');

    const allBtns = [];
    const btns = document.querySelectorAll('button.generic-button');
    for (const b of btns) {
      if (b.innerHTML.toLowerCase().includes('icon-download') && isVisible(b)) {
        allBtns.push(b);
      }
    }

    if (allBtns.length === 0) {
      console.log('[KlingAutoLogin] ❌ Không tìm thấy nút download');
      return { success: false, error: 'Không tìm thấy nút download' };
    }

    console.log('[KlingAutoLogin] Tìm thấy ' + allBtns.length + ' nút download');

    let clicked = 0;
    for (const btn of allBtns) {
      // Scroll nút vào view trước khi click
      try { btn.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch (e) {}
      await sleep(300);

      console.log('[KlingAutoLogin] ✅ Click nút download ' + (clicked + 1));
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      try { btn.click(); } catch (e) {}
      clicked++;

      // Đợi rồi đóng popup/dropdown để không che nút tiếp theo
      await sleep(1500);
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
      }));
      await sleep(800);
    }

    console.log('[KlingAutoLogin] ✅ Đã click ' + clicked + ' nút download');
    return { success: true, count: clicked };
  }

  // ========== Init ==========
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DOWNLOAD_VIDEO') {
      handleDownloadClick().then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (message.type === 'CONTINUE_LOGIN') {
      if (window.__continueLogin) {
        window.__continueLogin();
        window.__continueLogin = null;
      }
      sendResponse({ success: true });
      return false;
    }
  });

  async function init() {
    if (document.readyState === 'loading') {
      await new Promise(r => document.addEventListener('DOMContentLoaded', r));
    }
    
    try {
      const response = await api.runtime.sendMessage({ type: 'CONTENT_READY' });
      
      if (response && response.type === 'LOGIN_NOW' && response.credentials) {
        await performLogin(response.credentials);
      } else if (response && response.type === 'UPLOAD_IMAGE' && response.image) {
        await sleep(3000);
        await runFullFlow(response.image);
        api.runtime.sendMessage({ type: 'UPLOAD_DONE' });
      }
    } catch (e) {
      console.log('[KlingAutoLogin] Idle:', e?.message);
    }
  }
  
  init();
})();