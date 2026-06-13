/* ============================================================
 * 片段分享 · Snippet Share
 * 基于 GitHub 仓库 + jsdelivr CDN，国内可访问
 * ============================================================ */

(() => {
  'use strict';

  // ---------- 配置 ----------
  const CONFIG_KEY = 'snippet_share_config';

  const defaultConfig = {
    repo: '',         // GitHub 仓库，例如 "user/snippets"
    branch: 'main',   // 分支
    token: '',        // GitHub PAT（仅用于保存新片段）
    cdn: 'https://cdn.jsdelivr.net/gh' // CDN 域名
  };

  let config = { ...defaultConfig };

  // ---------- 状态 ----------
  let snippets = [];
  let currentSnippet = null;
  let sharedData = null; // URL hash 中内嵌的分享数据

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);

  // ---------- 工具 ----------
  const LANG_EXT = {
    javascript: 'js', typescript: 'ts', python: 'py', java: 'java',
    go: 'go', rust: 'rs', cpp: 'cpp', c: 'c', csharp: 'cs',
    php: 'php', ruby: 'rb', html: 'html', css: 'css', scss: 'scss',
    json: 'json', xml: 'xml', yaml: 'yml', sql: 'sql',
    bash: 'sh', shell: 'sh', powershell: 'ps1',
    markdown: 'md', dockerfile: 'dockerfile', plaintext: 'txt'
  };

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function getFileExt(lang) {
    return LANG_EXT[lang] || 'txt';
  }

  function genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // base64 编码（支持中文）
  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function base64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(b64)));
  }

  // ---------- 配置持久化 ----------
  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      config = { ...defaultConfig, ...saved };
    } catch (e) {
      console.error('Failed to load config', e);
    }
  }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  // ---------- 提示 ----------
  function showToast(msg, type = 'info', duration = 2500) {
    const toast = $('toast');
    toast.textContent = msg;
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, duration);
  }

  // ---------- Modal ----------
  function showModal(id) {
    $(id).hidden = false;
  }
  function hideModal(id) {
    $(id).hidden = true;
  }

  // ---------- 列表加载（用 GitHub API，绕过 jsdelivr 缓存） ----------
  async function fetchSnippets(silent = false) {
    if (!config.repo) {
      $('snippetList').innerHTML =
        '<div class="empty">请先在 ⚙ 设置中配置 GitHub 仓库<br><small>或使用"生成分享链接"无需配置</small></div>';
      snippets = [];
      return;
    }
    if (!silent) {
      $('snippetList').innerHTML = '<div class="empty">加载中...</div>';
    }
    try {
      // GitHub API 始终是最新数据，不会被 CDN 缓存影响
      const data = await getFile('index.json');
      if (!data || !data.content) {
        snippets = [];
      } else {
        const parsed = JSON.parse(base64ToUtf8(data.content));
        snippets = Array.isArray(parsed) ? parsed : (parsed.snippets || []);
      }
      renderSnippetList();
    } catch (err) {
      $('snippetList').innerHTML =
        `<div class="empty error">加载失败：${escapeHtml(err.message)}<br><small>提示：检查网络或 GitHub Token 权限</small></div>`;
    }
  }

  // ---------- 列表渲染 ----------
  function renderSnippetList(filter = '') {
    const list = $('snippetList');
    const q = filter.trim().toLowerCase();
    const filtered = snippets.filter((s) => {
      if (!q) return true;
      return (s.title || '').toLowerCase().includes(q) ||
        (s.desc || '').toLowerCase().includes(q) ||
        (s.lang || '').toLowerCase().includes(q);
    });

    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty">暂无片段</div>';
      return;
    }

    list.innerHTML = filtered.map((s) => `
      <div class="snippet-item ${currentSnippet?.id === s.id ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
        <div class="snippet-title">${escapeHtml(s.title || '未命名')}</div>
        <div class="snippet-meta">
          <span class="lang">${escapeHtml(s.lang || 'text')}</span>
          <span>${escapeHtml(formatDate(s.date))}</span>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.snippet-item').forEach((el) => {
      el.addEventListener('click', () => loadSnippet(el.dataset.id));
    });
  }

  // ---------- 加载片段详情 ----------
  async function loadSnippet(id) {
    const snippet = snippets.find((s) => s.id === id);
    if (!snippet) return;
    $('content').innerHTML = '<div class="empty">加载中...</div>';
    try {
      const ext = getFileExt(snippet.lang);
      const filePath = `snippets/${encodeURIComponent(id)}.${ext}`;
      const code = await loadFileContent(filePath);
      currentSnippet = { ...snippet, code, _isShared: false };
      renderSnippetDetail();
      renderSnippetList($('searchInput').value);
    } catch (err) {
      $('content').innerHTML =
        `<div class="empty error">加载片段失败：${escapeHtml(err.message)}</div>`;
    }
  }

  // 加载文件：jsdelivr 优先，失败回退到 GitHub API
  async function loadFileContent(filePath) {
    // 1. 尝试 jsdelivr CDN
    try {
      const cdnUrl = `${config.cdn}/${config.repo}@${config.branch}/${filePath}?_ts=${Date.now()}`;
      const res = await fetch(cdnUrl, { cache: 'no-store' });
      if (res.ok) return await res.text();
    } catch (e) { /* 继续尝试 GitHub API */ }

    // 2. 回退到 GitHub API（始终最新）
    const data = await getFile(filePath);
    if (!data) throw new Error('文件不存在');
    return base64ToUtf8(data.content);
  }

  // ---------- 渲染详情 ----------
  function renderSnippetDetail() {
    const s = currentSnippet;
    const lang = s.lang || 'plaintext';
    $('content').innerHTML = `
      <div class="detail-header">
        <div>
          <h2>${escapeHtml(s.title || '未命名')}</h2>
          <div class="detail-meta">
            <span class="lang-tag">${escapeHtml(lang)}</span>
            <span>${escapeHtml(formatDate(s.date))}</span>
            ${s._isShared ? '<span class="lang-tag" style="background:#fff3cd;color:#856404">URL 分享</span>' : ''}
          </div>
          ${s.desc ? `<p class="detail-desc">${escapeHtml(s.desc)}</p>` : ''}
        </div>
        <div class="detail-actions">
          <button class="btn" id="copyBtn">📋 复制</button>
          <button class="btn" id="rawBtn">↗ 原始</button>
          <button class="btn" id="shareBtn">🔗 分享</button>
        </div>
      </div>
      <pre class="language-${escapeHtml(lang)}"><code class="language-${escapeHtml(lang)}">${escapeHtml(s.code)}</code></pre>
    `;

    $('copyBtn').addEventListener('click', () => copyText(s.code, '已复制到剪贴板'));
    $('rawBtn').addEventListener('click', () => {
      if (s._isShared) {
        const blob = new Blob([s.code], { type: 'text/plain' });
        const u = URL.createObjectURL(blob);
        window.open(u, '_blank');
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      } else {
        const ext = getFileExt(s.lang);
        window.open(`${config.cdn}/${config.repo}@${config.branch}/snippets/${encodeURIComponent(s.id)}.${ext}`, '_blank');
      }
    });
    $('shareBtn').addEventListener('click', () => generateShareLink(s));

    if (window.Prism) {
      try { Prism.highlightAllUnder($('content')); } catch (e) { /* ignore */ }
    }
  }

  // ---------- 复制 ----------
  async function copyText(text, msg) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast(msg || '已复制', 'success');
    } catch (e) {
      showToast('复制失败：' + e.message, 'error');
    }
  }

  // ---------- 生成分享链接（URL hash 模式） ----------
  function generateShareLink(snippet) {
    if (!snippet) return;
    const payload = {
      t: snippet.title || '',
      l: snippet.lang || 'plaintext',
      d: snippet.desc || '',
      c: snippet.code || '',
      v: 1
    };
    let encoded;
    try {
      encoded = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
    } catch (e) {
      encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(payload)))));
    }
    const url = `${location.origin}${location.pathname}#s=${encoded}`;
    copyText(url, '分享链接已复制！直接发送即可，国内 100% 可访问');
  }

  // ---------- 解析 URL hash ----------
  function parseHash() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return null;

    // #s=... 分享模式
    if (hash.startsWith('s=')) {
      const data = hash.slice(2);
      try {
        const json = LZString.decompressFromEncodedURIComponent(data);
        if (json) return JSON.parse(json);
      } catch (e) {
        // 回退到 base64
        try {
          return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(data)))));
        } catch (e2) {
          console.error('Failed to parse shared data', e2);
        }
      }
    }

    // #id=... 仓库内片段
    if (hash.startsWith('id=')) {
      return { _type: 'repo', id: hash.slice(3) };
    }

    return null;
  }

  function handleHash() {
    const data = parseHash();
    if (!data) return false;

    if (data._type === 'repo') {
      fetchSnippets().then(() => loadSnippet(data.id));
      return true;
    }

    // 分享模式
    sharedData = {
      id: 'shared-' + Date.now(),
      title: data.t || '分享的片段',
      lang: data.l || 'plaintext',
      desc: data.d || '',
      code: data.c || '',
      date: new Date().toISOString(),
      _isShared: true
    };
    currentSnippet = sharedData;
    renderSnippetDetail();
    return true;
  }

  // ---------- 保存到 GitHub ----------
  async function saveSnippet() {
    const title = $('snippetTitle').value.trim();
    const lang = $('snippetLang').value;
    const desc = $('snippetDesc').value.trim();
    const code = $('snippetCode').value;
    const errorEl = $('newError');
    errorEl.textContent = '';

    if (!title) { errorEl.textContent = '请输入标题'; return; }
    if (!code) { errorEl.textContent = '请输入代码'; return; }
    if (!config.repo) { errorEl.textContent = '请先在设置中配置 GitHub 仓库'; return; }
    if (!config.token) { errorEl.textContent = '请先在设置中配置 Personal Access Token'; return; }

    const saveBtn = $('saveSnippet');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';

    const id = genId();
    const ext = getFileExt(lang);
    const filePath = `snippets/${id}.${ext}`;
    const date = new Date().toISOString();

    try {
      // 1. 读取最新 index.json（GitHub API，绕过 CDN 缓存）
      let indexData = [];
      let indexSha = null;
      try {
        const existing = await getFile('index.json');
        if (existing && existing.content) {
          indexSha = existing.sha;
          const parsed = JSON.parse(base64ToUtf8(existing.content));
          indexData = Array.isArray(parsed) ? parsed : (parsed.snippets || []);
        }
      } catch (e) {
        // index.json 不存在，初始化空数组
      }

      const newEntry = { id, title, lang, desc, date };
      indexData.unshift(newEntry);

      // 2. 上传代码文件
      await githubPut(filePath, code, `Add snippet: ${title}`);

      // 3. 更新 index.json（带 sha 避免覆盖并发更新）
      await githubPutWithSha('index.json', JSON.stringify({ snippets: indexData }, null, 2),
        'Update snippets index', indexSha);

      // 4. 立即更新本地状态（用户立刻看到新片段，无需等待）
      snippets = indexData;
      currentSnippet = { ...newEntry, code, _isShared: false };
      renderSnippetList($('searchInput').value);
      renderSnippetDetail();
      hideModal('newModal');
      clearNewForm();
      showToast('保存成功！', 'success');
    } catch (err) {
      errorEl.textContent = '保存失败：' + err.message;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存到 GitHub';
    }
  }

  // githubPut 的变体：调用方已知 sha（避免二次查询）
  async function githubPutWithSha(path, content, message, sha) {
    const url = `https://api.github.com/repos/${config.repo}/contents/${path}`;
    const body = {
      message,
      content: utf8ToBase64(content),
      branch: config.branch
    };
    if (sha) body.sha = sha;

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${config.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function clearNewForm() {
    $('snippetTitle').value = '';
    $('snippetDesc').value = '';
    $('snippetCode').value = '';
  }

  // ---------- GitHub API ----------
  async function githubPut(path, content, message) {
    const url = `https://api.github.com/repos/${config.repo}/contents/${path}`;
    let sha = null;
    try {
      const existing = await getFile(path);
      if (existing) sha = existing.sha;
    } catch (e) { /* file may not exist */ }

    const body = {
      message,
      content: utf8ToBase64(content),
      branch: config.branch
    };
    if (sha) body.sha = sha;

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${config.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function getFile(path) {
    const url = `https://api.github.com/repos/${config.repo}/contents/${path}?ref=${encodeURIComponent(config.branch)}`;
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (config.token) headers['Authorization'] = `token ${config.token}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------- 设置 ----------
  function openSettings() {
    $('cfgRepo').value = config.repo;
    $('cfgBranch').value = config.branch;
    $('cfgToken').value = config.token;
    $('cfgCdn').value = config.cdn;
    $('settingsError').textContent = '';
    showModal('settingsModal');
  }

  function saveSettings() {
    const errEl = $('settingsError');
    const repo = $('cfgRepo').value.trim();
    const branch = $('cfgBranch').value.trim() || 'main';
    const token = $('cfgToken').value.trim();
    const cdn = $('cfgCdn').value.trim() || defaultConfig.cdn;

    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      errEl.textContent = '仓库格式不正确，应为 "用户名/仓库名"';
      return;
    }

    config.repo = repo;
    config.branch = branch;
    config.token = token;
    config.cdn = cdn;
    saveConfig();
    hideModal('settingsModal');
    showToast('设置已保存', 'success');
    fetchSnippets();
  }

  // ---------- 新建 ----------
  function openNewModal() {
    if (!config.repo) {
      showToast('请先在设置中配置 GitHub 仓库', 'error');
      openSettings();
      return;
    }
    if (!config.token) {
      showToast('未配置 PAT。可改用"生成分享链接"', 'error', 3500);
    }
    clearNewForm();
    $('newError').textContent = '';
    showModal('newModal');
    setTimeout(() => $('snippetTitle').focus(), 100);
  }

  function handleShareLink() {
    const title = $('snippetTitle').value.trim();
    const lang = $('snippetLang').value;
    const desc = $('snippetDesc').value.trim();
    const code = $('snippetCode').value;
    const errorEl = $('newError');

    if (!title) { errorEl.textContent = '请输入标题'; return; }
    if (!code) { errorEl.textContent = '请输入代码'; return; }
    errorEl.textContent = '';

    generateShareLink({ title, lang, desc, code });
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $('newBtn').addEventListener('click', openNewModal);
    $('settingsBtn').addEventListener('click', openSettings);
    $('saveSettings').addEventListener('click', saveSettings);
    $('saveSnippet').addEventListener('click', saveSnippet);
    $('shareLinkBtn').addEventListener('click', handleShareLink);
    $('searchInput').addEventListener('input', (e) => renderSnippetList(e.target.value));

    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => hideModal(el.dataset.close));
    });

    // 点击背景关闭弹窗
    document.querySelectorAll('.modal').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) hideModal(modal.id);
      });
    });

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal:not([hidden])').forEach((m) => hideModal(m.id));
      }
    });

    // Prism autoloader 路径
    if (window.Prism && Prism.plugins && Prism.plugins.autoloader) {
      Prism.plugins.autoloader.languages_path = 'https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/';
    }
  }

  // ---------- 启动 ----------
  function init() {
    loadConfig();
    bindEvents();
    if (!handleHash()) {
      fetchSnippets();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
