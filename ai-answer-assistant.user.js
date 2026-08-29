// ==UserScript==
// @name         AI 自动答题助手 - Privacy Safe
// @namespace    https://github.com/rehuan/AI-ANSWER-ASSISTANT
// @version      1.5.0
// @description  隐私优先的 AI 自动答题助手：无站点模板，全靠本地 DOM 扫描与可选脱敏 AI 兜底；仅向用户配置的 OpenAI 兼容 API 发送必要题干/选项。
// @author       Privacy-safe reimplementation
// @license      GPL-3.0-or-later
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  /*
   * Privacy design
   * --------------
   * 1. No telemetry / analytics / update beacon / remote code.
   * 2. No cookies, URL, page title, localStorage, sessionStorage, form values or full HTML are sent.
   * 3. Unknown-site AI fallback sends only a sanitized list of candidate question text,
   *    option text and random ephemeral element references.
   * 4. Answer requests send only one question and its options.
   * 5. API keys are session-only by default. "Remember key" is explicit opt-in.
   * 6. Persistent settings and optional remembered API keys use Tampermonkey GM storage.
   * 7. Exactly one function in this script performs network requests: callOpenAICompatible().
   */

  const APP = {
    id: 'aia-privacy-safe',
    name: 'AI 自动答题助手',
    version: '1.5.0',
    rootId: 'aia-privacy-root',
  };

  const STORAGE = {
    settings: 'aia:settings:v1',
    models: 'aia:models:v1',
    activeModelId: 'aia:activeModelId:v1',
    rememberFlags: 'aia:rememberFlags:v1',
  };

  const DEFAULT_SETTINGS = {
    delayMs: 450,
    scroll: true,
    highlight: true,
    aiScan: true,
    autoOpen: false,
    requestTimeoutMs: 120000,
    debug: false,
  };

  const sessionSecrets = new Map();
  let state = {
    questions: [],
    answeredCount: 0,
    isRunning: false,
    isScanning: false,
    logs: [],
    panelOpen: false,
    activeTab: 'home',
    networkEvents: [],
  };

  // No site-specific presets: every site uses the same scanner.

  // ---------- Utilities ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function nowTime() {
    return new Date().toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function cleanText(value, max = 1200) {
    return String(value || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function uid(prefix = 'id') {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  function tryJSON(text) {
    let value = String(text || '').trim();
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) value = fenced[1].trim();
    const objectMatch = value.match(/\{[\s\S]*\}/);
    if (objectMatch) value = objectMatch[0];
    return JSON.parse(value);
  }

  function wildcardMatch(url, pattern) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    try {
      return new RegExp(`^${escaped}$`).test(url);
    } catch {
      return false;
    }
  }

  function safeQuery(root, selector) {
    if (!selector) return null;
    try {
      return (root || document).querySelector(selector);
    } catch {
      return null;
    }
  }

  function safeQueryAll(root, selector) {
    if (!selector) return [];
    try {
      return Array.from((root || document).querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function isSystemOrSensitivePage() {
    const protocol = location.protocol;
    return !['http:', 'https:'].includes(protocol);
  }

  function addLog(level, message) {
    const item = { time: nowTime(), level, message: cleanText(message, 2000) };
    state.logs.push(item);
    if (state.logs.length > 250) state.logs.shift();
    renderHome();
  }

  function debugEnabled() {
    return !!getSettings().debug;
  }

  function debugLog(message) {
    if (!debugEnabled()) return;
    addLog('debug', `[DEBUG] ${cleanText(message, 6000)}`);
  }

  function debugJSON(label, value, max = 5000) {
    if (!debugEnabled()) return;
    let json = '';
    try {
      json = JSON.stringify(value);
    } catch (error) {
      json = `[无法序列化: ${error.message}]`;
    }
    debugLog(`${label}: ${json.slice(0, max)}${json.length > max ? ' …[截断]' : ''}`);
  }

  function describeElement(el) {
    if (!el) return 'null';
    const tag = String(el.tagName || 'unknown').toLowerCase();
    const type = el.getAttribute?.('type') || '';
    const id = el.id ? `#${el.id}` : '';
    const name = el.getAttribute?.('name') ? `[name="${el.getAttribute('name')}"]` : '';
    return `${tag}${type ? `[type="${type}"]` : ''}${id}${name} connected=${!!el.isConnected}`;
  }

  function updateCounters() {
    const totalEls = document.querySelectorAll('[data-aia-count-total]');
    const answeredEls = document.querySelectorAll('[data-aia-count-answered]');
    totalEls.forEach((el) => (el.textContent = String(state.questions.length)));
    answeredEls.forEach((el) => (el.textContent = String(state.answeredCount)));
  }

  function getSettings() {
    const stored = GM_getValue(STORAGE.settings, {}) || {};
    // v1.4 and older used "aiFallback". Migrate it silently to the new
    // force-AI-scan switch so existing users keep their previous choice.
    const aiScan =
      typeof stored.aiScan === 'boolean'
        ? stored.aiScan
        : typeof stored.aiFallback === 'boolean'
        ? stored.aiFallback
        : DEFAULT_SETTINGS.aiScan;
    return { ...DEFAULT_SETTINGS, ...stored, aiScan };
  }

  function setSettings(patch) {
    const next = { ...getSettings(), ...patch };
    GM_setValue(STORAGE.settings, next);
    return next;
  }

  function getModels() {
    const models = GM_getValue(STORAGE.models, []);
    return Array.isArray(models) ? models : [];
  }

  function saveModels(models) {
    GM_setValue(STORAGE.models, models);
  }

  function getActiveModelId() {
    return GM_getValue(STORAGE.activeModelId, '');
  }

  function setActiveModelId(id) {
    GM_setValue(STORAGE.activeModelId, id || '');
  }

  function getRememberFlags() {
    return GM_getValue(STORAGE.rememberFlags, {}) || {};
  }

  function setRememberFlag(modelId, enabled) {
    const flags = getRememberFlags();
    flags[modelId] = !!enabled;
    GM_setValue(STORAGE.rememberFlags, flags);
  }

  function setSecret(modelId, key, remember) {
    sessionSecrets.set(modelId, key || '');
    setRememberFlag(modelId, !!remember);
    if (remember) {
      GM_setValue(`aia:secret:${modelId}`, key || '');
    } else {
      GM_deleteValue(`aia:secret:${modelId}`);
    }
  }

  function getSecret(modelId) {
    if (sessionSecrets.has(modelId)) return sessionSecrets.get(modelId) || '';
    const flags = getRememberFlags();
    if (flags[modelId]) {
      const stored = GM_getValue(`aia:secret:${modelId}`, '') || '';
      if (stored) sessionSecrets.set(modelId, stored);
      return stored;
    }
    return '';
  }

  function deleteSecret(modelId) {
    sessionSecrets.delete(modelId);
    GM_deleteValue(`aia:secret:${modelId}`);
    const flags = getRememberFlags();
    delete flags[modelId];
    GM_setValue(STORAGE.rememberFlags, flags);
  }

  function getActiveModel() {
    const models = getModels();
    const id = getActiveModelId();
    return models.find((m) => m.id === id) || models[0] || null;
  }

  function normalizedEndpoint(baseUrl) {
    let url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!url) throw new Error('API Base URL 为空');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('API Base URL 不是有效 URL');
    }

    const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
      throw new Error('为防止 API Key 明文泄漏，远程 API 必须使用 HTTPS（localhost/127.0.0.1 可使用 HTTP）');
    }

    if (!parsed.pathname.endsWith('/chat/completions')) {
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/chat/completions`
        .replace(/\/{2,}/g, '/');
    }
    return parsed.toString();
  }

  // ---------- The ONLY network function ----------

  async function callOpenAICompatible({ modelConfig, apiKey, system, user, purpose, timeoutMs }) {
    if (!modelConfig) throw new Error('未配置 AI 模型');
    if (!apiKey) throw new Error('当前模型缺少 API Key（刷新或换页面后，会话 Key 需要重新输入）');
    if (typeof GM_xmlhttpRequest !== 'function') {
      throw new Error('Tampermonkey 的 GM_xmlhttpRequest 不可用，请确认脚本权限正常');
    }

    const url = normalizedEndpoint(modelConfig.baseUrl);
    const origin = new URL(url).origin;
    const bodyObject = {
      model: modelConfig.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    const body = JSON.stringify(bodyObject);
    const settings = getSettings();
    const hardTimeout = clamp(Number(timeoutMs || settings.requestTimeoutMs) || 120000, 5000, 240000);

    try {
      state.networkEvents.push({
        time: new Date().toISOString(),
        purpose: purpose || 'AI request',
        destination: origin,
        bytes: new TextEncoder().encode(body).length,
      });
      if (state.networkEvents.length > 100) state.networkEvents.shift();
      renderPrivacy();
    } catch {}

    addLog('info', `API 请求开始：${origin}（超时 ${Math.round(hardTimeout / 1000)} 秒）`);
    debugLog(`API request purpose=${purpose || 'AI request'}, model=${modelConfig.model}, endpoint=${url}, bodyBytes=${new TextEncoder().encode(body).length}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let requestHandle = null;
      let lastReadyState = -1;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        fn(value);
      };

      const fail = (message) => {
        addLog('error', message);
        finish(reject, new Error(message));
      };

      const watchdog = setTimeout(() => {
        try { requestHandle?.abort?.(); } catch {}
        fail(`API 在 ${Math.round(hardTimeout / 1000)} 秒内没有返回完整响应：${origin}`);
      }, hardTimeout + 750);

      try {
        requestHandle = GM_xmlhttpRequest({
          method: 'POST',
          url,
          timeout: hardTimeout,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          data: body,
          anonymous: true,
          onreadystatechange: (response) => {
            if (!debugEnabled()) return;
            const readyState = Number(response?.readyState);
            if (Number.isFinite(readyState) && readyState !== lastReadyState) {
              lastReadyState = readyState;
              debugLog(`XHR readyState=${readyState}, status=${Number(response?.status) || 0}`);
            }
          },
          onload: (response) => {
            if (settled) return;
            const status = Number(response.status) || 0;
            addLog('info', `API 已响应：HTTP ${status || '未知'}`);
            debugLog(`HTTP response status=${status}, bytes=${String(response.responseText || '').length}, finalUrl=${response.finalUrl || url}`);
            if (debugEnabled()) {
              const preview = String(response.responseText || '').slice(0, 3500);
              debugLog(`HTTP 原始响应预览: ${preview}${String(response.responseText || '').length > 3500 ? ' …[截断]' : ''}`);
            }

            if (status < 200 || status >= 300) {
              let detail = '';
              try {
                const err = JSON.parse(response.responseText || '{}');
                detail = err?.error?.message || err?.message || '';
              } catch {
                detail = cleanText(response.responseText || '', 300);
              }
              if (status === 0) return fail('API 返回状态 0：常见原因是 @connect 权限未允许、TLS/证书失败或网络被拦截');
              if (status === 401) return fail('API Key 无效或鉴权失败（HTTP 401）');
              if (status === 403) return fail('API 拒绝访问（HTTP 403）');
              if (status === 404) return fail(`API 路径不存在（HTTP 404）：当前请求 ${url}`);
              if (status === 429) return fail('API 请求过于频繁或额度不足（HTTP 429）');
              return fail(`API 请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`);
            }

            try {
              const data = JSON.parse(response.responseText || '{}');
              const content = data?.choices?.[0]?.message?.content;
              if (typeof content !== 'string') {
                const keys = Object.keys(data || {}).slice(0, 8).join(', ') || '空响应';
                return fail(`API 返回格式不是 OpenAI Chat Completions（顶层字段：${keys}）`);
              }
              debugLog(`Chat Completions content 长度=${content.length}`);
              debugLog(`模型 content 预览: ${content.slice(0, 3000)}${content.length > 3000 ? ' …[截断]' : ''}`);
              addLog('success', 'API 调用成功');
              finish(resolve, content);
            } catch (error) {
              fail(`API 响应 JSON 解析失败：${error.message}`);
            }
          },
          ontimeout: () => fail(`API 请求超时（${Math.round(hardTimeout / 1000)} 秒）`),
          onerror: (response) => {
            const status = Number(response?.status) || 0;
            fail(`API 网络错误${status ? `（HTTP ${status}）` : ''}：请检查域名、证书、代理和 Tampermonkey @connect 权限`);
          },
          onabort: () => {
            if (!settled) fail('API 请求被中止');
          },
        });
      } catch (error) {
        fail(`无法发起 API 请求：${error.message}`);
      }
    });
  }

  // ---------- Local generic scanner ----------

  function cssEsc(value) {
    try {
      return CSS.escape(String(value));
    } catch {
      return String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
    }
  }

  // Local-only locator. Never sent to AI.
  function makeLocalSelector(element) {
    if (!element || !(element instanceof Element)) return '';
    if (element.id) return `#${cssEsc(element.id)}`;

    for (const attr of ['data-question-id', 'topic', 'data-id']) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const escaped = String(value).replace(/"/g, '\\"');
      const candidate = `${element.tagName.toLowerCase()}[${attr}="${escaped}"]`;
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch {}
    }

    const path = [];
    let current = element;
    for (let depth = 0; current && current !== document.body && depth < 7; depth++) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((x) => x.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      path.unshift(part);
      current = parent;
    }
    return path.length ? `body > ${path.join(' > ')}` : '';
  }

  function getLiveElement(element, locator) {
    if (element?.isConnected) return element;
    if (locator) {
      const found = safeQuery(document, locator);
      if (found) return found;
    }
    return null;
  }

  const QUESTION_HINT_SELECTOR = [
    '.question',
    '.question-item',
    '.exam-question',
    '.test-question',
    '.quiz-question',
    '.problem',
    '.problem-item',
    '.exercise',
    '.exercise-item',
    '[data-question-id]',
    '[data-question]',
    '[class*="question"]',
    '[class*="Question"]',
    '[class*="problem"]',
    '[class*="Problem"]',
  ].join(',');

  function isAnswerInput(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (tag !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['radio', 'checkbox'].includes(type)) return true;
    if (!['text', 'number', 'tel', 'url'].includes(type)) return false;
    const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();
    if (/(search|keyword|user|account|login|phone|mobile|email|captcha|verify|password|name|姓名|学号|工号)/i.test(hint)) {
      return false;
    }
    return true;
  }

  function isUsableFillInput(el) {
    if (!isAnswerInput(el)) return false;
    const type = (el.getAttribute?.('type') || '').toLowerCase();
    if (['radio', 'checkbox'].includes(type)) return false;
    if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
    if (!isVisible(el)) return false;

    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width < 2 && rect.height < 2) return false;

    return true;
  }

  function isScannableControl(el) {
    if (!isAnswerInput(el)) return false;
    const type = (el.getAttribute?.('type') || '').toLowerCase();
    if (['radio', 'checkbox'].includes(type)) return true;
    return isUsableFillInput(el);
  }

  function getControlLabel(input) {
    if (!input) return '';
    const aria = input.getAttribute?.('aria-label');
    if (aria) return cleanText(aria, 500);

    if (input.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (label) return cleanText(label.textContent, 500);
      } catch {}
    }

    const closest = input.closest?.('label');
    if (closest) {
      const clone = closest.cloneNode(true);
      safeQueryAll(clone, 'input,textarea,select,button').forEach((x) => x.remove());
      return cleanText(clone.textContent, 500);
    }

    const parent = input.parentElement;
    if (parent) {
      const text = cleanText(parent.textContent, 500);
      if (text) return text;
    }

    const next = input.nextElementSibling;
    if (next) {
      const text = cleanText(next.textContent, 500);
      if (text) return text;
    }
    return '';
  }

  function closestReasonableContainer(element) {
    if (!element) return null;

    const hinted = element.closest?.(QUESTION_HINT_SELECTOR);
    if (hinted && hinted !== document.body && cleanText(hinted.textContent).length <= 5000) return hinted;

    const input = element.matches?.('input,textarea') ? element : safeQuery(element, 'input,textarea');
    const groupName = input?.name || null;
    let current = element.parentElement;
    let best = null;

    for (let depth = 0; current && current !== document.body && depth < 8; depth++, current = current.parentElement) {
      const textLen = cleanText(current.textContent, 10000).length;
      if (textLen > 6000) break;

      const radios = safeQueryAll(current, 'input[type="radio"]');
      const checks = safeQueryAll(current, 'input[type="checkbox"]');
      const texts = safeQueryAll(current, 'input,textarea,[contenteditable="true"]').filter(isUsableFillInput);
      const interactiveCount = radios.length + checks.length + texts.length;

      if (interactiveCount >= 1 && interactiveCount <= 30) {
        best = current;
      }

      if (groupName) {
        const names = new Set([...radios, ...checks].map((x) => x.name).filter(Boolean));
        if (names.size > 1 && !names.has(groupName)) break;
        if (names.size > 1) break;
      }

      if (textLen > 2500 && best) break;
    }

    return best || element.parentElement || element;
  }

  function extractQuestionText(container) {
    if (!container) return '';

    const preferred = [
      '.question-title',
      '.question-text',
      '.question-stem',
      '.stem',
      '.title',
      '.topic',
      '.subject',
      'legend',
      'h1',
      'h2',
      'h3',
      'h4',
      '[class*="title"]',
      '[class*="stem"]',
    ];

    for (const selector of preferred) {
      const candidates = safeQueryAll(container, selector);
      for (const el of candidates) {
        const text = cleanText(el.textContent, 1200);
        if (text.length >= 2 && text.length <= 1200) return text;
      }
    }

    const optionTexts = new Set(
      safeQueryAll(container, 'input[type="radio"],input[type="checkbox"]')
        .map(getControlLabel)
        .filter(Boolean)
    );

    const clone = container.cloneNode(true);
    safeQueryAll(clone, 'script,style,svg,img,video,audio,button,select').forEach((el) => el.remove());
    safeQueryAll(clone, 'input,textarea').forEach((el) => el.remove());
    let text = cleanText(clone.textContent, 1800);

    for (const option of optionTexts) {
      if (option.length >= 2) text = text.replace(option, ' ');
    }

    text = cleanText(text, 1200);
    if (text.length > 2) return text;

    return cleanText(container.textContent, 1200);
  }

  function collectFillInputs(root) {
    return safeQueryAll(root || document, 'textarea,input,[contenteditable="true"]')
      .filter(isUsableFillInput);
  }

  function isQuestionLikeContainer(el) {
    if (!el || el === document.body) return false;
    try {
      if (el.matches?.(QUESTION_HINT_SELECTOR)) return true;
    } catch {}
    return (
      el.hasAttribute?.('topic') ||
      el.hasAttribute?.('data-question-id') ||
      el.hasAttribute?.('data-question') ||
      el.getAttribute?.('role') === 'group'
    );
  }

  function closestFillQuestionContainer(input) {
    let current = input?.parentElement;
    let bestSingle = null;
    let bestMulti = null;

    for (let depth = 0; current && current !== document.body && depth < 10; depth++, current = current.parentElement) {
      const fills = collectFillInputs(current);
      const choiceCount = safeQueryAll(current, 'input[type="radio"],input[type="checkbox"]').length;
      const textLen = cleanText(current.textContent, 7000).length;
      const totalInteractive = fills.length + choiceCount;

      if (fills.includes(input) && fills.length >= 1 && fills.length <= 20 && textLen <= 4500) {
        if (fills.length === 1 && totalInteractive === 1) bestSingle = current;
        if (fills.length >= 2) bestMulti = current;

        if (isQuestionLikeContainer(current)) return current;
      }

      // Once the parent starts containing another question/control group,
      // the previous smaller ancestor is the safer single-question boundary.
      if (totalInteractive > 20 || textLen > 7000) break;
      if (bestSingle && totalInteractive > 1 && fills.length <= 1) break;
    }

    return bestMulti || bestSingle || closestReasonableContainer(input);
  }

  function isEssayLikeQuestion(container, fills) {
    if (!fills?.length) return false;

    const text = cleanText(extractQuestionText(container), 1000);
    if (/(简答题|简答|论述题|论述|请说明|请简述|请阐述|请分析|请描述|说明.*要求|谈谈|为什么|如何理解)/i.test(text)) {
      return true;
    }

    // A visibly large multiline text area is normally a short-answer / essay field.
    return fills.some((el) => {
      if (!(el instanceof HTMLTextAreaElement) && !el.isContentEditable) return false;
      const rect = el.getBoundingClientRect?.();
      const rows = Number(el.getAttribute?.('rows')) || 0;
      return rows >= 3 || (rect && rect.height >= 70);
    });
  }

  function parseNativeQuestion(container, index) {
    const radios = safeQueryAll(container, 'input[type="radio"]').filter(isAnswerInput);
    const checks = safeQueryAll(container, 'input[type="checkbox"]').filter(isAnswerInput);
    const fills = safeQueryAll(container, 'textarea,input,[contenteditable="true"]')
      .filter(isUsableFillInput);

    let type = null;
    if (radios.length >= 2) type = 'single';
    else if (checks.length >= 2) type = 'multiple';
    else if (fills.length >= 1) type = isEssayLikeQuestion(container, fills) ? 'essay' : 'fill';
    else return null;

    const question = {
      id: uid('q'),
      index,
      type,
      text: extractQuestionText(container),
      options: [],
      inputs: [],
      element: container,
      locator: makeLocalSelector(container),
      answered: false,
    };

    if (type === 'single' || type === 'multiple') {
      const controls = type === 'single' ? radios : checks;
      const groupName = controls[0]?.name;
      const group = groupName ? controls.filter((x) => x.name === groupName) : controls;
      question.options = group.slice(0, 26).map((element, i) => ({
        label: String.fromCharCode(65 + i),
        text: getControlLabel(element) || `选项 ${String.fromCharCode(65 + i)}`,
        element,
        locator: makeLocalSelector(element),
      }));
    } else {
      question.inputs = fills.slice(0, 20).map((element) => ({
        element,
        locator: makeLocalSelector(element),
      }));
    }

    if (!question.text) return null;
    return question;
  }

  function nearestCommonAncestor(a, b) {
    if (!a || !b) return a || b || null;
    const ancestors = new Set();
    let cur = a;
    while (cur && cur !== document.body) {
      ancestors.add(cur);
      cur = cur.parentElement;
    }
    cur = b;
    while (cur && cur !== document.body) {
      if (ancestors.has(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function dedupeQuestions(questions) {
    const result = [];
    const byKey = new Map();

    for (const q of questions) {
      if (!q || !q.text) continue;
      const key = `${q.type}:${cleanText(q.text, 220).toLowerCase()}`;
      const existing = byKey.get(key);

      if (existing && q.type === 'fill' && existing.type === 'fill') {
        const seen = new Set(existing.inputs.map((x) => x.element));
        for (const input of q.inputs || []) {
          if (input?.element && !seen.has(input.element)) {
            existing.inputs.push(input);
            seen.add(input.element);
          }
        }
        const common = nearestCommonAncestor(existing.element, q.element);
        if (common && common !== document.body) {
          existing.element = common;
          existing.locator = makeLocalSelector(common);
        }
        continue;
      }

      if (existing) continue;
      byKey.set(key, q);
      result.push(q);
    }

    return result;
  }

  function scanGenericLocally() {
    const allCandidateControls = safeQueryAll(
      document,
      'input[type="radio"],input[type="checkbox"],textarea,input[type="text"],input[type="number"],input:not([type]),[contenteditable="true"]'
    );
    const controls = allCandidateControls.filter(isScannableControl);

    if (debugEnabled()) {
      const hiddenFillCount = allCandidateControls.filter((el) => {
        const type = (el.getAttribute?.('type') || '').toLowerCase();
        return !['radio', 'checkbox'].includes(type) && isAnswerInput(el) && !isUsableFillInput(el);
      }).length;
      debugLog(`DOM 扫描：过滤隐藏/不可见填空控件 ${hiddenFillCount} 个`);
    }

    const containers = [];
    const containerSet = new Set();

    debugLog(`DOM 扫描：候选可答控件 ${controls.length} 个`);

    for (const control of controls) {
      const type = (control.getAttribute?.('type') || '').toLowerCase();
      const isFill = control.tagName === 'TEXTAREA' || control.isContentEditable || !['radio', 'checkbox'].includes(type);
      const container = isFill ? closestFillQuestionContainer(control) : closestReasonableContainer(control);
      if (container && !containerSet.has(container)) {
        containerSet.add(container);
        containers.push(container);
      }
    }

    // Prefer smaller nested containers to prevent one large wrapper swallowing multiple questions.
    const pruned = containers.filter((candidate) => {
      return !containers.some(
        (other) =>
          other !== candidate &&
          candidate.contains(other) &&
          cleanText(other.textContent).length > 5 &&
          safeQueryAll(other, 'input,textarea,[contenteditable="true"]').some(isScannableControl)
      );
    });

    debugLog(`DOM 扫描：候选容器 ${containers.length} 个，裁剪后 ${pruned.length} 个`);
    const questions = dedupeQuestions(pruned.map(parseNativeQuestion).filter(Boolean));

    questions.forEach((q, i) => {
      debugLog(`扫描结果 #${i + 1}: type=${q.type}, options=${q.options?.length || 0}, inputs=${q.inputs?.length || 0}, text=${cleanText(q.text, 120)}`);
      if (q.type === 'fill' || q.type === 'essay') {
        (q.inputs || []).forEach((input, inputIndex) => {
          debugLog(`  填空 ${inputIndex + 1}: ${describeElement(input.element)} locator=${input.locator || '-'}`);
        });
      }
    });
    return questions;
  }

  // ---------- Sanitized AI fallback scanner ----------

  function buildSanitizedInteractiveSketch() {
    const controls = safeQueryAll(
      document,
      'input[type="radio"],input[type="checkbox"],textarea,input[type="text"],input[type="number"],input:not([type]),[contenteditable="true"]'
    ).filter(isScannableControl);

    const blocks = [];
    const blockMap = new Map();
    const refMap = new Map();

    controls.slice(0, 320).forEach((control) => {
      const inputType = (control.getAttribute?.('type') || '').toLowerCase();
      const isTextControl =
        control.tagName === 'TEXTAREA' ||
        control.isContentEditable ||
        !['radio', 'checkbox'].includes(inputType);

      // Text fields use the dedicated question-boundary finder; this is important
      // for one-blank questions that generic grouping can accidentally swallow.
      const container = isTextControl
        ? closestFillQuestionContainer(control)
        : closestReasonableContainer(control);
      if (!container) return;

      let block = blockMap.get(container);
      if (!block) {
        block = {
          blockRef: uid('b'),
          text: extractQuestionText(container),
          controls: [],
          element: container,
        };
        blockMap.set(container, block);
        blocks.push(block);
      }

      const ref = uid('e');
      refMap.set(ref, control);
      const rect = control.getBoundingClientRect?.();
      const kind = control.isContentEditable
        ? 'contenteditable'
        : (control.getAttribute?.('type') || control.tagName || 'text').toLowerCase();

      block.controls.push({
        ref,
        kind,
        label: getControlLabel(control),
        multiline: control.tagName === 'TEXTAREA' || control.isContentEditable,
        largeTextArea:
          (control.tagName === 'TEXTAREA' || control.isContentEditable) &&
          !!rect &&
          rect.height >= 70,
      });
    });

    const payloadBlocks = blocks
      .filter((b) => b.text && b.controls.length)
      .slice(0, 80)
      .map((b) => ({
        blockRef: b.blockRef,
        text: cleanText(b.text, 1000),
        controls: b.controls.slice(0, 32),
      }));

    debugLog(`AI 扫描候选：${payloadBlocks.length} 个题目块，${controls.length} 个可答控件`);
    return { payloadBlocks, refMap, blocks };
  }

  async function scanWithSanitizedAI() {
    const model = getActiveModel();
    if (!model) throw new Error('没有可用 AI 模型，无法进行 AI 扫描');
    const apiKey = getSecret(model.id);
    if (!apiKey) throw new Error('当前模型没有 API Key');

    const { payloadBlocks, refMap, blocks } = buildSanitizedInteractiveSketch();
    if (!payloadBlocks.length) return [];

    const system = `你是网页答题结构识别器。浏览器已经在本地把页面转换成脱敏候选题目块。
你的任务是识别每个 block 的题型和控件对应关系，不要回答题目。

严格只返回 JSON，不要 Markdown：
{
  "questions": [
    {
      "blockRef": "b-...",
      "type": "single|multiple|fill|essay",
      "text": "完整题干",
      "options": [{"label":"A","text":"选项","ref":"e-..."}],
      "inputs": [{"ref":"e-..."}]
    }
  ]
}

题型规则：
- single：单选题，一组选一个；通常对应 radio。
- multiple：多选题，可以选多个；通常对应 checkbox。
- fill：短填空题，一个或多个较短答案；对应 text / number / 短 textarea。
- essay：简答题、论述题、说明题，需要完整句子或段落；通常题干含“简答、说明、阐述、分析、描述”等，或对应明显较大的 textarea/contenteditable。
- 必须尽可能识别输入中的全部真实题目，不要漏掉第 1 题或最后一题。
- 只能引用输入里实际存在的 blockRef/ref，绝不能编造。
- inputs 的数量必须与这个题目实际使用的可见输入控件一致。
- 不需要给答案。`;

    debugJSON('AI 扫描发送的脱敏题目块', { blocks: payloadBlocks }, 10000);

    const user = JSON.stringify({ blocks: payloadBlocks });
    const raw = await callOpenAICompatible({
      modelConfig: model,
      apiKey,
      system,
      user,
      purpose: 'forced-ai-structure-scan',
      timeoutMs: Math.max(Number(getSettings().requestTimeoutMs) || 120000, 120000),
    });

    const parsed = tryJSON(raw);
    debugJSON('AI 扫描结构响应', parsed, 10000);

    const questions = [];

    for (const [index, q] of (parsed.questions || []).entries()) {
      if (!['single', 'multiple', 'fill', 'essay'].includes(q.type)) continue;

      const block = blocks.find((b) => b.blockRef === q.blockRef);
      if (!block) continue;

      const item = {
        id: uid('q'),
        index,
        type: q.type,
        text: cleanText(q.text || block.text, 1400),
        options: [],
        inputs: [],
        element: block.element || null,
        locator: makeLocalSelector(block.element),
        answered: false,
      };

      if (q.type === 'single' || q.type === 'multiple') {
        item.options = (q.options || [])
          .map((opt, i) => {
            const element = refMap.get(opt.ref);
            if (!element) return null;
            return {
              label: cleanText(opt.label || String.fromCharCode(65 + i), 10).toUpperCase(),
              text: cleanText(opt.text || getControlLabel(element), 600),
              element,
              locator: makeLocalSelector(element),
            };
          })
          .filter(Boolean);
      } else {
        item.inputs = (q.inputs || [])
          .map((inp) => {
            const element = refMap.get(inp.ref);
            if (!element) return null;
            return { element, locator: makeLocalSelector(element) };
          })
          .filter(Boolean);
      }

      if (item.text && (item.options.length || item.inputs.length)) {
        questions.push(item);
      }
    }

    const deduped = dedupeQuestions(questions);
    debugLog(`AI 扫描解析完成：模型返回 ${questions.length} 题，去重后 ${deduped.length} 题`);
    deduped.forEach((q, i) => {
      debugLog(
        `AI扫描 #${i + 1}: type=${q.type}, options=${q.options.length}, inputs=${q.inputs.length}, text=${cleanText(q.text, 120)}`
      );
    });
    return deduped;
  }

  async function scanQuestions() {
    if (state.isScanning) return;
    state.isScanning = true;
    renderHome();

    try {
      const settings = getSettings();
      let questions = [];

      if (settings.aiScan) {
        addLog('info', 'AI 扫描已开启：强制使用 AI 识别全部题目结构');
        const model = getActiveModel();
        const key = model ? getSecret(model.id) : '';
        if (!model || !key) {
          throw new Error('AI 扫描已开启，但当前模型或 API Key 不可用');
        }

        questions = await scanWithSanitizedAI();
        if (questions.length) {
          addLog('success', `AI 扫描完成：${questions.length} 题`);
        }
      } else {
        addLog('info', 'AI 扫描已关闭：仅使用本地 DOM 识别');
        questions = scanGenericLocally();
        if (questions.length) {
          addLog('success', `本地 DOM 扫描完成：${questions.length} 题`);
        }
      }

      state.questions = questions.map((q, i) => ({ ...q, index: i, answered: false }));
      state.answeredCount = 0;
      updateCounters();

      if (!state.questions.length) {
        addLog('warning', '未发现可识别的单选、多选、填空或简答题');
      }
    } catch (error) {
      addLog('error', `扫描失败：${error.message}`);
    } finally {
      state.isScanning = false;
      renderHome();
    }
  }

  // ---------- Answer generation ----------

  const ANSWER_SYSTEM = `你是答题助手。请分析用户提供的单道题，并严格返回 JSON，不要 Markdown。
格式：
{
  "type": "single|multiple|fill|essay",
  "answer": "B",
  "explanation": "简短解释"
}
规则：
- single: answer 是一个选项字母字符串，如 "B"
- multiple: answer 是字母数组，如 ["A","C"]
- fill: answer 是字符串数组，如 ["答案1","答案2"]
- essay: answer 是一个完整字符串，例如 "这是简答题的完整回答。"
- essay 应直接回答题目，内容完整但不要无意义扩写
- 只返回 JSON。`;

  async function askAnswer(question) {
    const model = getActiveModel();
    if (!model) throw new Error('请先添加并选择 AI 模型');
    const apiKey = getSecret(model.id);
    if (!apiKey) throw new Error('当前模型没有 API Key，请在“模型”页重新输入');

    // Count live, visible fields at request time. Some pages contain hidden helper inputs
    // or re-render their DOM after scanning.
    const visibleBlankCount =
      question.type === 'fill'
        ? (getLiveFillInputs(question).length || question.inputs.length || 1)
        : undefined;

    const payload = {
      type: question.type,
      question: cleanText(question.text, 1600),
      options:
        question.options?.map((o) => ({
          label: o.label,
          text: cleanText(o.text, 600),
        })) || [],
      blanks: visibleBlankCount,
      responseFields:
        question.type === 'essay'
          ? (getLiveFillInputs(question).length || question.inputs.length || 1)
          : undefined,
    };

    const configuredTimeout = Number(getSettings().requestTimeoutMs) || 120000;
    const isReasoningModel = /reasoner|reasoning|\br1\b/i.test(String(model.model || ''));
    const answerTimeout = isReasoningModel
      ? Math.max(configuredTimeout, 180000)
      : Math.max(configuredTimeout, 120000);

    const makeRequest = async ({ correction = false, previousAnswer = undefined } = {}) => {
      const requestPayload = correction
        ? {
            ...payload,
            correction: `这是一次格式纠正。页面实际只有 ${visibleBlankCount} 个可见填空框。answer 必须严格包含且只包含 ${visibleBlankCount} 个答案；不要补充其他词语，不要把题干中的其他词当成答案。`,
            previousAnswer,
          }
        : payload;

      if (correction) {
        addLog('warning', `正在自动纠正模型输出：本题只有 ${visibleBlankCount} 个可见空`);
      } else {
        addLog('info', `等待模型回答（本题最长 ${Math.round(answerTimeout / 1000)} 秒）…`);
      }

      debugJSON(correction ? '纠正请求 payload' : '答题请求 payload', requestPayload);

      const strictSystem =
        question.type === 'fill'
          ? `${ANSWER_SYSTEM}
【本题额外硬规则】
- 页面实际有 ${visibleBlankCount} 个可见填空框。
- fill 的 answer 数组长度必须严格等于 ${visibleBlankCount}。
- ${visibleBlankCount === 1 ? '因此只能返回一个答案，例如 ["八"]，绝不能返回 ["八","成功"] 这种两个元素。' : `必须恰好返回 ${visibleBlankCount} 个元素。`}`
          : ANSWER_SYSTEM;

      const raw = await callOpenAICompatible({
        modelConfig: model,
        apiKey,
        system: strictSystem,
        user: JSON.stringify(requestPayload),
        purpose: correction ? 'answer-question-correction' : 'answer-question',
        timeoutMs: answerTimeout,
      });

      let parsed;
      try {
        parsed = tryJSON(raw);
      } catch (error) {
        debugLog(`模型原始 content 无法解析为 JSON: ${raw.slice(0, 4000)}`);
        throw error;
      }
      debugJSON(correction ? '纠正后的答案 JSON' : '解析后的答案 JSON', parsed);
      return parsed;
    };

    let parsed = await makeRequest();

    if (question.type === 'essay') {
      const liveInputs = getLiveFillInputs(question);
      if (!liveInputs.length) throw new Error('找不到简答题输入框');

      const answer = Array.isArray(answerObj.answer)
        ? answerObj.answer.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n')
        : String(answerObj.answer ?? '').trim();

      if (!answer) throw new Error('AI 返回的简答题答案为空');

      debugLog(`简答题写入：inputs=${liveInputs.length}, answerLength=${answer.length}`);
      const ok = await fillControl(liveInputs[0], answer);
      if (!ok) throw new Error('简答题写入后校验失败');
      return;
    }

    if (question.type === 'fill') {
      const normalizeFillAnswers = (answer) => {
        if (Array.isArray(answer)) return answer.map((x) => String(x ?? '').trim());
        if (answer === undefined || answer === null) return [];
        return [String(answer).trim()];
      };

      let answers = normalizeFillAnswers(parsed.answer);
      debugLog(`填空答案数量检查：页面可见空=${visibleBlankCount}, 模型返回=${answers.length}`);

      if (answers.length !== visibleBlankCount) {
        addLog(
          'warning',
          `模型返回 ${answers.length} 个填空答案，但页面只有 ${visibleBlankCount} 个可见空；自动重问一次`
        );

        parsed = await makeRequest({
          correction: true,
          previousAnswer: parsed.answer,
        });
        answers = normalizeFillAnswers(parsed.answer);

        debugLog(`纠正后数量检查：页面可见空=${visibleBlankCount}, 模型返回=${answers.length}`);

        if (answers.length !== visibleBlankCount) {
          throw new Error(
            `模型纠正后仍返回 ${answers.length} 个答案，但本题实际有 ${visibleBlankCount} 个可见填空框；已停止填写`
          );
        }

        parsed.answer = answers;
        addLog('success', `模型输出已自动纠正为 ${visibleBlankCount} 个填空答案`);
      } else {
        parsed.answer = answers;
      }
    }

    return parsed;
  }

  async function testActiveAPI() {
    const model = getActiveModel();
    if (!model) throw new Error('请先添加并选择模型');
    const apiKey = getSecret(model.id);
    if (!apiKey) throw new Error('当前页面没有这个模型的 API Key，请重新输入或勾选“记住 API Key”');

    addLog('info', `开始测试模型：${model.name} / ${model.model}`);
    debugLog(`API 连通性测试：model=${model.model}, baseUrl=${model.baseUrl}`);
    const raw = await callOpenAICompatible({
      modelConfig: model,
      apiKey,
      system: '你是 API 连通性测试器。只返回 JSON。',
      user: '{"task":"ping","reply":{"ok":true}}',
      purpose: 'api-connection-test',
      timeoutMs: 20000,
    });
    const parsed = tryJSON(raw);
    if (parsed?.ok === true || parsed?.reply?.ok === true) {
      addLog('success', 'API 测试通过');
      return true;
    }
    addLog('warning', 'API 已成功返回，但测试内容不是预期 JSON；连接本身是通的');
    return true;
  }

  // ---------- Applying answers ----------

  function dispatchFormEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    dispatchFormEvents(el);
  }

  function setNativeChecked(el, checked) {
    if (!(el instanceof HTMLInputElement)) return;
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (desc?.set) desc.set.call(el, !!checked);
    else el.checked = !!checked;
    dispatchFormEvents(el);
  }

  function findVisibleChoiceTarget(el) {
    if (!(el instanceof HTMLInputElement)) return el;

    // Explicit associated <label>.
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && isVisible(label)) return label;
      } catch {}
    }

    const wrappingLabel = el.closest('label');
    if (wrappingLabel && isVisible(wrappingLabel)) return wrappingLabel;

    // Generic custom-control wrappers used by many quiz/form frameworks.
    const wrapper = el.closest(
      '.ui-checkbox,.ui-radio,.checkbox-option,.radio-option,.option,.choice,[role="checkbox"],[role="radio"],[class*="checkbox"],[class*="radio"]'
    );

    if (wrapper) {
      const preferred = [
        'label',
        '.label',
        '.jqcheck',
        '.jqradio',
        '[role="checkbox"]',
        '[role="radio"]',
        '.checkbox',
        '.radio',
      ];
      for (const selector of preferred) {
        const target = safeQuery(wrapper, selector);
        if (target && target !== el && isVisible(target)) return target;
      }
      if (isVisible(wrapper)) return wrapper;
    }

    const parent = el.parentElement;
    if (parent) {
      for (const selector of ['label', '.label', '.jqcheck', '.jqradio']) {
        const target = safeQuery(parent, selector);
        if (target && target !== el && isVisible(target)) return target;
      }
    }

    return el;
  }

  function syncChoiceAccessibility(el) {
    if (!(el instanceof HTMLInputElement)) return;
    const checked = !!el.checked;
    const wrapper = el.closest('[role="checkbox"],[role="radio"]');
    if (wrapper) wrapper.setAttribute('aria-checked', checked ? 'true' : 'false');

    // Common visual helper classes. These are generic state-sync fallbacks,
    // not site templates; real visible clicks are always attempted first.
    const container = el.closest('.ui-checkbox,.ui-radio,.checkbox-option,.radio-option');
    if (container) {
      safeQueryAll(container, '.jqcheck,.jqradio').forEach((node) => {
        node.classList.toggle('jqchecked', checked);
        node.classList.toggle('checked', checked);
      });
    }
  }

  async function clickControl(el, desiredChecked = true) {
    if (!el) return false;

    if (el instanceof HTMLInputElement && ['radio', 'checkbox'].includes(el.type)) {
      const desired = !!desiredChecked;
      let current = !!el.checked;
      const visualTarget = findVisibleChoiceTarget(el);

      debugLog(
        `选择控件：${describeElement(el)}, desired=${desired}, before=${current}, visualTarget=${describeElement(visualTarget)}`
      );

      if (current !== desired) {
        // First choice: perform a real click on the visible control surface.
        // This lets the website update its own classes/animations and fixes the
        // "answer submits correctly but no visible checkmark" problem.
        try {
          if (visualTarget && visualTarget !== el) visualTarget.click();
          else el.click();
          await sleep(90);
        } catch (error) {
          debugLog(`可视选项点击异常：${error.message}`);
        }

        current = !!el.checked;
      }

      if (current !== desired) {
        // Second attempt: native input activation. Some delegated handlers listen
        // specifically for the input click rather than the wrapper click.
        try {
          el.click();
          await sleep(70);
        } catch {}
        current = !!el.checked;
      }

      if (current !== desired) {
        // Last resort: set native state so form submission is still correct.
        setNativeChecked(el, desired);
        await sleep(30);
        current = !!el.checked;
      }

      syncChoiceAccessibility(el);
      dispatchFormEvents(el);
      debugLog(`选择控件结果：checked=${el.checked}, success=${el.checked === desired}`);
      return el.checked === desired;
    }

    try {
      el.click();
      return true;
    } catch {
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch {
        return false;
      }
    }
  }

  async function fillControl(el, value) {
    if (!el) return false;
    const wanted = String(value ?? '');
    debugLog(`准备写入：${describeElement(el)} <= ${JSON.stringify(wanted)}`);

    try {
      el.focus();

      if (el.isContentEditable) {
        el.textContent = wanted;
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: wanted,
          }));
        } catch {
          dispatchFormEvents(el);
        }
      } else {
        setNativeValue(el, wanted);
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: wanted,
          }));
        } catch {}
      }

      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      await sleep(90);

      const actual = el.isContentEditable ? el.textContent : el.value;
      const ok = String(actual ?? '') === wanted;
      debugLog(`写入后检查：${describeElement(el)} actual=${JSON.stringify(actual)} expected=${JSON.stringify(wanted)} ok=${ok}`);
      return ok;
    } catch (error) {
      debugLog(`写入异常：${describeElement(el)} error=${error.message}`);
      return false;
    }
  }

  function getLiveQuestionContainer(question) {
    const live = getLiveElement(question?.element, question?.locator);
    if (live) {
      question.element = live;
      return live;
    }
    return null;
  }

  function getLiveFillInputs(question) {
    const container = getLiveQuestionContainer(question);
    if (container) {
      const live = collectFillInputs(container);
      if (live.length) return live;
    }

    return (question.inputs || [])
      .map((input) => getLiveElement(input.element, input.locator))
      .filter(Boolean);
  }

  function normalizeAnswerLetters(answer) {
    if (Array.isArray(answer)) return answer.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    return String(answer || '')
      .toUpperCase()
      .split(/[^A-Z]+/)
      .join('')
      .split('')
      .filter(Boolean);
  }

  async function applyAnswer(question, answerObj) {
    if (!answerObj || answerObj.answer === undefined || answerObj.answer === null) {
      throw new Error('AI 返回中缺少 answer');
    }

    if (question.type === 'single') {
      const letter = String(answerObj.answer).trim().toUpperCase().match(/[A-Z]/)?.[0];
      const option = question.options.find((o) => String(o.label).toUpperCase() === letter);
      if (!option) throw new Error(`找不到 AI 返回的选项 ${letter || JSON.stringify(answerObj.answer)}`);
      await clickControl(option.element, true);
      return;
    }

    if (question.type === 'multiple') {
      const wanted = new Set(normalizeAnswerLetters(answerObj.answer));
      for (const option of question.options) {
        const shouldCheck = wanted.has(String(option.label).toUpperCase());
        if (option.element instanceof HTMLInputElement && option.element.type === 'checkbox') {
          await clickControl(option.element, shouldCheck);
        } else if (shouldCheck) {
          await clickControl(option.element, true);
        }
        await sleep(60);
      }
      return;
    }

    if (question.type === 'fill') {
      const answers = Array.isArray(answerObj.answer) ? answerObj.answer : [answerObj.answer];
      let liveInputs = getLiveFillInputs(question);

      debugLog(`填空映射开始：AI答案=${JSON.stringify(answers)}, 扫描记录inputs=${question.inputs?.length || 0}, 当前DOM inputs=${liveInputs.length}`);

      if (!liveInputs.length) throw new Error('找不到填空输入框');

      if (answers.length > 1 && liveInputs.length < answers.length) {
        throw new Error(`填空映射失败：AI 返回 ${answers.length} 个答案，但当前只定位到 ${liveInputs.length} 个输入框。请开启 Debug 查看扫描结果`);
      }

      if (liveInputs.length === 1) {
        const ok = await fillControl(liveInputs[0], answers[0]);
        if (!ok) throw new Error('填空写入后校验失败');
        return;
      }

      const count = Math.min(answers.length, liveInputs.length);
      for (let i = 0; i < count; i++) {
        liveInputs = getLiveFillInputs(question);
        const target = liveInputs[i];
        debugLog(`填空映射 ${i + 1}/${count}: target=${describeElement(target)}, answer=${JSON.stringify(answers[i])}`);
        if (!target) throw new Error(`第 ${i + 1} 个填空输入框在页面更新后丢失`);

        const ok = await fillControl(target, answers[i]);
        if (!ok) {
          await sleep(120);
          const retryInputs = getLiveFillInputs(question);
          const retryTarget = retryInputs[i];
          debugLog(`第 ${i + 1} 空首次校验失败，重新定位后重试：${describeElement(retryTarget)}`);
          if (!retryTarget || !(await fillControl(retryTarget, answers[i]))) {
            throw new Error(`第 ${i + 1} 个填空写入后校验失败`);
          }
        }
        await sleep(130);
      }

      const finalInputs = getLiveFillInputs(question);
      debugLog(`填空映射完成：当前DOM inputs=${finalInputs.length}`);
      finalInputs.slice(0, count).forEach((el, i) => {
        debugLog(`  最终值 #${i + 1}: ${describeElement(el)} value=${JSON.stringify(el.isContentEditable ? el.textContent : el.value)}`);
      });
    }
  }

  function highlightQuestion(question, active) {
    const settings = getSettings();
    if (!settings.highlight || !question?.element) return;
    const el = question.element;
    if (active) {
      el.setAttribute('data-aia-processing', '1');
      if (settings.scroll) {
        try {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {}
      }
    } else {
      el.removeAttribute('data-aia-processing');
    }
  }

  function markCompleted(question) {
    if (question?.element) {
      question.element.removeAttribute('data-aia-processing');
      question.element.setAttribute('data-aia-completed', '1');
    }
  }

  async function startAnswering() {
    if (state.isRunning) return;
    if (!state.questions.length) {
      addLog('warning', '请先扫描题目');
      return;
    }

    const model = getActiveModel();
    if (!model) {
      addLog('error', '请先在“模型”中添加 OpenAI 兼容 API');
      switchTab('models');
      return;
    }
    if (!getSecret(model.id)) {
      addLog('error', '当前模型没有 API Key，请重新输入');
      switchTab('models');
      return;
    }

    state.isRunning = true;
    renderHome();
    addLog('info', `开始答题，共 ${state.questions.length} 题`);

    const settings = getSettings();

    for (let i = 0; i < state.questions.length; i++) {
      if (!state.isRunning) break;
      const q = state.questions[i];
      if (q.answered) continue;

      highlightQuestion(q, true);
      addLog('info', `第 ${i + 1}/${state.questions.length} 题：${cleanText(q.text, 60)}`);

      try {
        const answer = await askAnswer(q);
        if (!state.isRunning) {
          highlightQuestion(q, false);
          break;
        }
        await applyAnswer(q, answer);
        q.answer = answer.answer;
        q.explanation = answer.explanation || '';
        q.answered = true;
        state.answeredCount += 1;
        markCompleted(q);
        updateCounters();
        addLog('success', `第 ${i + 1} 题完成，答案：${JSON.stringify(answer.answer)}`);
      } catch (error) {
        highlightQuestion(q, false);
        addLog('error', `第 ${i + 1} 题失败：${error.message}`);
      }

      await sleep(clamp(Number(settings.delayMs) || 450, 100, 5000));
    }

    const wasStopped = !state.isRunning;
    state.isRunning = false;
    renderHome();
    if (wasStopped) addLog('warning', '答题已暂停');
    else addLog('success', `全部处理完成：${state.answeredCount}/${state.questions.length}`);
  }

  function stopAnswering() {
    state.isRunning = false;
    document.querySelectorAll('[data-aia-processing]').forEach((el) => el.removeAttribute('data-aia-processing'));
    renderHome();
  }

  // ---------- UI ----------

  function injectStyles() {
    const style = document.createElement('style');
    style.id = `${APP.id}-style`;
    style.textContent = `
      #${APP.rootId}, #${APP.rootId} * { box-sizing: border-box; }
      #${APP.rootId} { all: initial; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
      #aia-fab {
        position: fixed; right: 22px; bottom: 22px; width: 52px; height: 52px;
        border: 0; border-radius: 16px; background: #111827; color: #fff;
        font: 700 15px/1 sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.24);
        cursor: pointer; z-index: 2147483646; display:flex;align-items:center;justify-content:center;
      }
      #aia-fab:hover { transform: translateY(-1px); }
      #aia-panel {
        position: fixed; top: 0; right: 0; width: min(420px, 94vw); height: 100vh;
        background: #f8fafc; color: #111827; z-index: 2147483647;
        box-shadow: -12px 0 40px rgba(15,23,42,.20);
        transform: translateX(102%); transition: transform .22s ease;
        display:flex;flex-direction:column; font: 14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      }
      #aia-panel.open { transform: translateX(0); }
      .aia-header { padding:16px 16px 12px;background:#fff;border-bottom:1px solid #e5e7eb; }
      .aia-title-row { display:flex;align-items:center;justify-content:space-between;gap:10px; }
      .aia-title { font-size:17px;font-weight:760;letter-spacing:.1px; }
      .aia-subtitle { margin-top:4px;color:#64748b;font-size:12px; }
      .aia-close {border:0;background:#f1f5f9;border-radius:10px;width:34px;height:34px;cursor:pointer;font-size:20px;color:#334155;}
      .aia-tabs {display:flex;gap:4px;padding:9px 10px;background:#fff;border-bottom:1px solid #e5e7eb;overflow:auto;}
      .aia-tab {border:0;background:transparent;padding:7px 10px;border-radius:9px;color:#64748b;cursor:pointer;white-space:nowrap;font-weight:650;}
      .aia-tab.active {background:#111827;color:#fff;}
      .aia-body {padding:14px;overflow:auto;flex:1;}
      .aia-view {display:none;}
      .aia-view.active {display:block;}
      .aia-card {background:#fff;border:1px solid #e5e7eb;border-radius:15px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(15,23,42,.04);}
      .aia-row {display:flex;gap:10px;align-items:center;}
      .aia-between {justify-content:space-between;}
      .aia-stat {flex:1;text-align:center;padding:12px;background:#f8fafc;border-radius:12px;}
      .aia-stat strong {display:block;font-size:25px;line-height:1.1;}
      .aia-stat span {font-size:12px;color:#64748b;}
      .aia-btn {border:0;border-radius:11px;padding:10px 13px;cursor:pointer;font-weight:700;font-size:13px;}
      .aia-btn:disabled {opacity:.45;cursor:not-allowed;}
      .aia-primary {background:#111827;color:#fff;}
      .aia-secondary {background:#e2e8f0;color:#0f172a;}
      .aia-danger {background:#fee2e2;color:#991b1b;}
      .aia-warn {background:#fef3c7;color:#92400e;}
      .aia-success {background:#dcfce7;color:#166534;}
      .aia-full {width:100%;}
      .aia-grid2 {display:grid;grid-template-columns:1fr 1fr;gap:9px;}
      .aia-label {display:block;font-size:12px;font-weight:700;color:#475569;margin:10px 0 5px;}
      .aia-input, .aia-select, .aia-textarea {
        width:100%;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#0f172a;
        padding:9px 10px;font:13px/1.4 inherit;outline:none;
      }
      .aia-input:focus,.aia-select:focus,.aia-textarea:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(100,116,139,.12);}
      .aia-textarea{min-height:95px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;}
      .aia-muted {font-size:12px;color:#64748b;}
      .aia-note {padding:10px 11px;border-radius:11px;background:#eff6ff;color:#1e40af;font-size:12px;margin-bottom:10px;}
      .aia-privacy-note {padding:10px 11px;border-radius:11px;background:#ecfdf5;color:#166534;font-size:12px;margin-bottom:10px;}
      .aia-model {padding:11px;border:1px solid #e5e7eb;border-radius:12px;margin-top:9px;}
      .aia-model.active {border-color:#111827;box-shadow:0 0 0 1px #111827 inset;}
      .aia-model-name {font-weight:750;}
      .aia-model-meta {font-size:11px;color:#64748b;margin-top:2px;word-break:break-all;}
      .aia-small-btn {border:0;background:#f1f5f9;border-radius:8px;padding:6px 8px;cursor:pointer;font-size:11px;}
      .aia-log {background:#0f172a;border-radius:12px;padding:10px;max-height:330px;overflow:auto;color:#dbeafe;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;}
      .aia-log-item {margin:0 0 5px;word-break:break-word;}
      .aia-log-time {color:#64748b;margin-right:6px;}
      .aia-log-success{color:#86efac}.aia-log-error{color:#fca5a5}.aia-log-warning{color:#fde68a}.aia-log-info{color:#bfdbfe}.aia-log-debug{color:#c4b5fd}
      .aia-switch-row {display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #f1f5f9;}
      .aia-switch-row:last-child {border-bottom:0;}
      .aia-check {width:18px;height:18px;accent-color:#111827;}
      .aia-toggle {
        all: unset; box-sizing:border-box; flex:0 0 auto; width:46px; height:26px;
        border-radius:999px; background:#cbd5e1; border:1px solid #94a3b8;
        position:relative; cursor:pointer; box-shadow:inset 0 1px 2px rgba(15,23,42,.12);
        transition:background .18s ease,border-color .18s ease;
      }
      .aia-toggle::after {
        content:''; position:absolute; width:20px; height:20px; left:2px; top:2px;
        border-radius:50%; background:#fff; box-shadow:0 1px 4px rgba(15,23,42,.35);
        transition:transform .18s ease;
      }
      .aia-toggle.on { background:#22c55e; border-color:#16a34a; }
      .aia-toggle.on::after { transform:translateX(20px); }
      .aia-toggle:focus-visible { outline:3px solid rgba(59,130,246,.4); outline-offset:2px; }
      .aia-network {font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;padding:8px;background:#f8fafc;border-radius:9px;margin-top:6px;word-break:break-all;}
      .aia-divider {height:1px;background:#e5e7eb;margin:12px 0;}
      .aia-kbd {font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#e2e8f0;border-radius:5px;padding:1px 5px;}
      [data-aia-processing="1"] { outline: 3px solid #3b82f6 !important; outline-offset: 3px !important; box-shadow: 0 0 0 7px rgba(59,130,246,.16) !important; transition: box-shadow .2s ease !important; }
      [data-aia-completed="1"] { outline: 2px solid #22c55e !important; outline-offset: 2px !important; }
      @media (prefers-color-scheme: dark) {
        #aia-panel {background:#0b1220;color:#e5e7eb;}
        .aia-header,.aia-tabs,.aia-card{background:#111827;border-color:#253047;}
        .aia-subtitle,.aia-muted,.aia-model-meta{color:#94a3b8;}
        .aia-stat,.aia-network{background:#0f172a;}
        .aia-input,.aia-select,.aia-textarea{background:#0f172a;border-color:#334155;color:#e5e7eb;}
        .aia-tab{color:#94a3b8}.aia-tab.active{background:#e5e7eb;color:#111827;}
        .aia-close,.aia-small-btn,.aia-secondary{background:#1e293b;color:#e2e8f0;}
        .aia-model{border-color:#334155}.aia-model.active{border-color:#e5e7eb;box-shadow:0 0 0 1px #e5e7eb inset;}
        .aia-switch-row{border-color:#1e293b}
        .aia-toggle{background:#334155;border-color:#475569}
        .aia-toggle.on{background:#22c55e;border-color:#16a34a}
      }
    `;
    document.documentElement.appendChild(style);
  }

  function createUI() {
    if (document.getElementById(APP.rootId)) return;

    const root = document.createElement('div');
    root.id = APP.rootId;
    root.innerHTML = `
      <button id="aia-fab" title="${APP.name}">AI</button>
      <aside id="aia-panel" aria-label="${APP.name}">
        <div class="aia-header">
          <div class="aia-title-row">
            <div>
              <div class="aia-title">${APP.name}</div>
              <div class="aia-subtitle">Privacy Safe · v${APP.version}</div>
            </div>
            <button class="aia-close" id="aia-close" aria-label="关闭">×</button>
          </div>
        </div>
        <div class="aia-tabs">
          <button class="aia-tab active" data-tab="home">答题</button>
          <button class="aia-tab" data-tab="models">模型</button>
          <button class="aia-tab" data-tab="privacy">隐私</button>
        </div>
        <div class="aia-body">
          <section class="aia-view active" data-view="home"></section>
          <section class="aia-view" data-view="models"></section>
          <section class="aia-view" data-view="privacy"></section>
        </div>
      </aside>
    `;
    document.documentElement.appendChild(root);

    root.querySelector('#aia-fab').addEventListener('click', () => togglePanel(true));
    root.querySelector('#aia-close').addEventListener('click', () => togglePanel(false));
    root.querySelectorAll('.aia-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    renderAll();
  }

  function togglePanel(open) {
    state.panelOpen = open ?? !state.panelOpen;
    document.getElementById('aia-panel')?.classList.toggle('open', state.panelOpen);
  }

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.aia-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
    document.querySelectorAll('.aia-view').forEach((el) => el.classList.toggle('active', el.dataset.view === tab));
    renderAll();
  }

  function logItemsHTML() {
    if (!state.logs.length) return '<div class="aia-log-item aia-log-info">暂无日志</div>';
    return state.logs
      .map(
        (l) =>
          `<div class="aia-log-item aia-log-${escapeHtml(l.level)}"><span class="aia-log-time">${escapeHtml(
            l.time
          )}</span>${escapeHtml(l.message)}</div>`
      )
      .join('');
  }

  function renderHome() {
    const view = document.querySelector('[data-view="home"]');
    if (!view) return;
    const settings = getSettings();
    const model = getActiveModel();

    view.innerHTML = `
      <div class="aia-privacy-note">
        🔒 无站点模板。AI 扫描开启时强制由 AI 识别题目结构；关闭时只使用本地 DOM。答题内容只发送到你配置的 API。
      </div>
      <div class="aia-card">
        <div class="aia-row">
          <div class="aia-stat"><strong data-aia-count-total>${state.questions.length}</strong><span>扫描题目</span></div>
          <div class="aia-stat"><strong data-aia-count-answered>${state.answeredCount}</strong><span>已完成</span></div>
        </div>
        <div class="aia-divider"></div>
        <div class="aia-muted">当前模型：${model ? `<b>${escapeHtml(model.name)}</b> · ${escapeHtml(model.model)}` : '未配置'}</div>
      </div>
      <div class="aia-grid2">
        <button class="aia-btn aia-secondary" id="aia-scan" ${state.isScanning || state.isRunning ? 'disabled' : ''}>
          ${state.isScanning ? '扫描中…' : '扫描题目'}
        </button>
        ${
          state.isRunning
            ? '<button class="aia-btn aia-warn" id="aia-stop">暂停答题</button>'
            : `<button class="aia-btn aia-primary" id="aia-start" ${!state.questions.length ? 'disabled' : ''}>开始自动答题</button>`
        }
      </div>
      <div class="aia-card" style="margin-top:12px">
        <div class="aia-switch-row">
          <div><b>AI 扫描</b><div class="aia-muted">开启：强制 AI 识别全部题目；关闭：仅本地 DOM 扫描</div></div>
          <button type="button" class="aia-toggle ${settings.aiScan ? 'on' : ''}" id="aia-setting-ai-scan" aria-pressed="${settings.aiScan ? 'true' : 'false'}" aria-label="AI 扫描"></button>
        </div>
        <div class="aia-switch-row">
          <div><b>自动滚动</b><div class="aia-muted">答题时滚到当前题目</div></div>
          <button type="button" class="aia-toggle ${settings.scroll ? 'on' : ''}" id="aia-setting-scroll" aria-pressed="${settings.scroll ? 'true' : 'false'}" aria-label="自动滚动"></button>
        </div>
        <div class="aia-switch-row">
          <div><b>Debug 模式</b><div class="aia-muted">显示 API 状态、响应摘要、扫描映射和输入框写入校验</div></div>
          <button type="button" class="aia-toggle ${settings.debug ? 'on' : ''}" id="aia-setting-debug" aria-pressed="${settings.debug ? 'true' : 'false'}" aria-label="Debug 模式"></button>
        </div>
        <label class="aia-label">题间延迟（毫秒）</label>
        <input class="aia-input" id="aia-setting-delay" type="number" min="100" max="5000" value="${Number(settings.delayMs) || 450}">
        <label class="aia-label">单题 API 超时（秒）</label>
        <input class="aia-input" id="aia-setting-timeout" type="number" min="30" max="240" value="${Math.round((Number(settings.requestTimeoutMs) || 120000) / 1000)}">
        <div class="aia-muted" style="margin-top:5px">普通模型建议 120 秒；reasoner / reasoning 模型最低自动提升到 180 秒。</div>
      </div>
      <div class="aia-card">
        <div class="aia-row aia-between"><b>运行日志</b><button class="aia-small-btn" id="aia-log-clear">清空</button></div>
        <div class="aia-log" id="aia-log-box" style="margin-top:9px">${logItemsHTML()}</div>
      </div>
    `;

    view.querySelector('#aia-scan')?.addEventListener('click', scanQuestions);
    view.querySelector('#aia-start')?.addEventListener('click', startAnswering);
    view.querySelector('#aia-stop')?.addEventListener('click', stopAnswering);
    const bindToggle = (selector, key, currentValue, label) => {
      view.querySelector(selector)?.addEventListener('click', () => {
        const next = !currentValue;
        setSettings({ [key]: next });
        if (key === 'debug') addLog('info', next ? 'Debug 模式已开启' : 'Debug 模式已关闭');
        else addLog('info', `${label}${next ? '已开启' : '已关闭'}`);
        renderHome();
      });
    };
    bindToggle('#aia-setting-ai-scan', 'aiScan', !!settings.aiScan, 'AI 扫描');
    bindToggle('#aia-setting-scroll', 'scroll', !!settings.scroll, '自动滚动');
    bindToggle('#aia-setting-debug', 'debug', !!settings.debug, 'Debug 模式');
    view.querySelector('#aia-setting-delay')?.addEventListener('change', (e) => {
      setSettings({ delayMs: clamp(Number(e.target.value) || 450, 100, 5000) });
    });
    view.querySelector('#aia-setting-timeout')?.addEventListener('change', (e) => {
      const seconds = clamp(Number(e.target.value) || 120, 30, 240);
      setSettings({ requestTimeoutMs: seconds * 1000 });
      e.target.value = String(seconds);
    });
    view.querySelector('#aia-log-clear')?.addEventListener('click', () => {
      state.logs = [];
      renderHome();
    });
    const box = view.querySelector('#aia-log-box');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function renderModels() {
    const view = document.querySelector('[data-view="models"]');
    if (!view) return;
    const models = getModels();
    const activeId = getActiveModelId();

    view.innerHTML = `
      <div class="aia-note">
        为了兼容任意 OpenAI 格式 API，userscript 需要 <span class="aia-kbd">@connect *</span>。
        代码只会请求你在这里配置的 Base URL；没有任何隐藏服务器。
      </div>
      <div class="aia-card">
        <b>添加 / 编辑模型</b>
        <label class="aia-label">名称</label>
        <input class="aia-input" id="aia-model-name" placeholder="例如 OpenAI / 本地 Ollama">
        <label class="aia-label">API Base URL</label>
        <input class="aia-input" id="aia-model-url" placeholder="https://api.openai.com/v1">
        <label class="aia-label">API Key</label>
        <input class="aia-input" id="aia-model-key" type="password" autocomplete="off" placeholder="sk-...">
        <label class="aia-label">模型</label>
        <input class="aia-input" id="aia-model-model" placeholder="gpt-4.1-mini">
        <div class="aia-switch-row">
          <div><b>记住 API Key</b><div class="aia-muted">默认关闭；关闭时仅当前页面会话保存在内存</div></div>
          <input class="aia-check" id="aia-model-remember" type="checkbox">
        </div>
        <input type="hidden" id="aia-model-edit-id">
        <button class="aia-btn aia-primary aia-full" id="aia-model-save">保存模型</button>
      </div>
      <div class="aia-card">
        <b>模型列表</b>
        <div id="aia-model-list">
          ${
            models.length
              ? models
                  .map((m) => {
                    const hasKey = !!getSecret(m.id);
                    return `
                    <div class="aia-model ${m.id === activeId ? 'active' : ''}" data-model-id="${escapeHtml(m.id)}">
                      <div class="aia-row aia-between">
                        <div>
                          <div class="aia-model-name">${escapeHtml(m.name)}</div>
                          <div class="aia-model-meta">${escapeHtml(m.model)} · ${escapeHtml(m.baseUrl)}</div>
                          <div class="aia-model-meta">${hasKey ? '🔑 API Key 可用' : '⚠️ 本会话没有 API Key'}</div>
                        </div>
                        <div>
                          <button class="aia-small-btn" data-action="use">使用</button>
                          <button class="aia-small-btn" data-action="edit">编辑</button>
                          <button class="aia-small-btn" data-action="delete">删除</button>
                        </div>
                      </div>
                    </div>`;
                  })
                  .join('')
              : '<div class="aia-muted" style="margin-top:8px">还没有模型。这里不会提供任何内置第三方中转服务。</div>'
          }
        </div>
      </div>
      <div class="aia-card">
        <b>API 连通性测试</b>
        <div class="aia-muted" style="margin:5px 0 9px">只发送一个很短的 ping，不代表真实题目能在 20 秒内回答。测试结果同时写入“答题”页日志。</div>
        <button class="aia-btn aia-success aia-full" id="aia-test-current-api" ${!getActiveModel() ? 'disabled' : ''}>测试当前 API</button>
      </div>
    `;

    view.querySelector('#aia-model-save')?.addEventListener('click', () => {
      const name = cleanText(view.querySelector('#aia-model-name').value, 80);
      const baseUrl = view.querySelector('#aia-model-url').value.trim();
      const apiKey = view.querySelector('#aia-model-key').value.trim();
      const modelName = cleanText(view.querySelector('#aia-model-model').value, 120);
      const remember = view.querySelector('#aia-model-remember').checked;
      const editId = view.querySelector('#aia-model-edit-id').value;

      if (!name || !baseUrl || !modelName) {
        alert('请填写名称、Base URL 和模型名');
        return;
      }

      try {
        normalizedEndpoint(baseUrl);
      } catch (error) {
        alert(error.message);
        return;
      }

      const all = getModels();
      let id = editId;
      if (editId) {
        const idx = all.findIndex((m) => m.id === editId);
        if (idx < 0) return;
        all[idx] = { ...all[idx], name, baseUrl, model: modelName };
      } else {
        id = uid('model');
        all.push({ id, name, baseUrl, model: modelName });
      }

      saveModels(all);
      if (!getActiveModelId()) setActiveModelId(id);
      if (apiKey) {
        setSecret(id, apiKey, remember);
      } else if (editId) {
        if (!remember) GM_deleteValue(`aia:secret:${id}`);
        setRememberFlag(id, remember);
      }

      addLog('success', `模型已保存：${name}`);
      renderModels();
      renderHome();
    });

    view.querySelector('#aia-test-current-api')?.addEventListener('click', async () => {
      addLog('info', 'API 连通性测试已启动，已切换到答题页查看日志');
      switchTab('home');
      try {
        await testActiveAPI();
      } catch (error) {
        addLog('error', `API 测试失败：${error.message}`);
      }
    });

    view.querySelectorAll('.aia-model').forEach((card) => {
      const id = card.dataset.modelId;
      card.querySelector('[data-action="use"]')?.addEventListener('click', () => {
        setActiveModelId(id);
        addLog('success', `已切换模型：${getModels().find((m) => m.id === id)?.name || id}`);
        renderModels();
        renderHome();
      });

      card.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
        const m = getModels().find((x) => x.id === id);
        if (!m) return;
        view.querySelector('#aia-model-name').value = m.name;
        view.querySelector('#aia-model-url').value = m.baseUrl;
        view.querySelector('#aia-model-model').value = m.model;
        view.querySelector('#aia-model-key').value = '';
        view.querySelector('#aia-model-key').placeholder = getSecret(id) ? '留空则保持现有 Key' : '请输入 API Key';
        view.querySelector('#aia-model-remember').checked = !!getRememberFlags()[id];
        view.querySelector('#aia-model-edit-id').value = id;
        view.querySelector('#aia-model-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      card.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
        if (!confirm('确定删除这个模型和已保存的 API Key 吗？')) return;
        const next = getModels().filter((x) => x.id !== id);
        saveModels(next);
        deleteSecret(id);
        if (getActiveModelId() === id) setActiveModelId(next[0]?.id || '');
        renderModels();
        renderHome();
      });
    });
  }


  function renderPrivacy() {
    const view = document.querySelector('[data-view="privacy"]');
    if (!view) return;
    const rememberedCount = Object.values(getRememberFlags()).filter(Boolean).length;

    view.innerHTML = `
      <div class="aia-privacy-note">
        <b>网络边界：</b>本脚本只有一个网络请求函数，它只会访问当前选中模型的 Base URL。
        没有统计、更新检查、CDN、远程脚本、默认中转服务。Debug 日志只显示在本机页面，不会上传。
      </div>
      <div class="aia-card">
        <b>永不主动上传</b>
        <div class="aia-muted" style="margin-top:8px">✓ 当前网页 URL / 域名 / 标题</div>
        <div class="aia-muted">✓ Cookie / localStorage / sessionStorage</div>
        <div class="aia-muted">✓ 页面完整 HTML / DOM 属性 / data-* 属性</div>
        <div class="aia-muted">✓ 输入框原有值、账号信息、浏览记录</div>
        <div class="aia-muted">✓ 使用统计、设备指纹、IP 之外的额外标识</div>
        <div class="aia-divider"></div>
        <b>必要发送</b>
        <div class="aia-muted" style="margin-top:8px">• 答题：当前单道题的题干、选项、题型、可见填空数量</div>
        <div class="aia-muted">• AI 扫描：脱敏后的候选题干、选项文本、随机临时 ref</div>
        <div class="aia-muted">这些内容只发到你主动配置并选择的 API。</div>
      </div>
      <div class="aia-card">
        <div class="aia-row aia-between"><b>API Key</b><span class="aia-muted">已选择“记住”的模型：${rememberedCount}</span></div>
        <button class="aia-btn aia-danger aia-full" id="aia-clear-secrets" style="margin-top:10px">清除所有已保存 API Key</button>
      </div>
      <div class="aia-card">
        <div class="aia-row aia-between"><b>本页网络审计</b><button class="aia-small-btn" id="aia-clear-network">清空</button></div>
        <div class="aia-muted">这里只记录目标域名、用途和请求体字节数，不记录题目内容或 Key。</div>
        <div id="aia-network-list">
          ${
            state.networkEvents.length
              ? state.networkEvents
                  .slice()
                  .reverse()
                  .map(
                    (e) =>
                      `<div class="aia-network">${escapeHtml(e.time)}<br>${escapeHtml(e.purpose)} → ${escapeHtml(
                        e.destination
                      )}<br>${e.bytes} bytes</div>`
                  )
                  .join('')
              : '<div class="aia-muted" style="margin-top:8px">本页尚无 AI 网络请求。</div>'
          }
        </div>
      </div>
      <div class="aia-card">
        <b>最高隐私用法</b>
        <div class="aia-muted" style="margin-top:8px">
          把 Base URL 指向本机 OpenAI 兼容服务，例如 <span class="aia-kbd">http://127.0.0.1:11434/v1</span>。
          这样题目内容也不会离开你的电脑。
        </div>
      </div>
    `;

    view.querySelector('#aia-clear-secrets')?.addEventListener('click', () => {
      if (!confirm('确定清除所有已保存的 API Key 吗？')) return;
      for (const model of getModels()) deleteSecret(model.id);
      sessionSecrets.clear();
      addLog('success', '所有已保存 API Key 已清除');
      renderPrivacy();
      renderModels();
    });

    view.querySelector('#aia-clear-network')?.addEventListener('click', () => {
      state.networkEvents = [];
      renderPrivacy();
    });
  }


  function renderAll() {
    renderHome();
    renderModels();
    renderPrivacy();
    updateCounters();
  }


  // ---------- Keyboard / menu ----------

  function setupMenu() {
    try {
      GM_registerMenuCommand('打开 / 关闭答题助手', () => togglePanel());
      GM_registerMenuCommand('扫描题目', () => {
        togglePanel(true);
        switchTab('home');
        scanQuestions();
      });
    } catch {}
  }

  function setupKeyboard() {
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && e.shiftKey && e.code === 'KeyA') {
          e.preventDefault();
          togglePanel();
        }
      },
      true
    );
  }

  // ---------- Init ----------

  function init() {
    if (isSystemOrSensitivePage()) return;
    injectStyles();
    createUI();
    setupMenu();
    setupKeyboard();

    const settings = getSettings();
    addLog('info', `${APP.name} 已加载；无遥测，API Key 默认仅会话保存`);
    if (settings.autoOpen) togglePanel(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
