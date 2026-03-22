// ==UserScript==
// @name         Suno 自動入力ヘルパー
// @namespace    https://suno.com/
// @version      1.1.2
// @description  ChatGPT で作った Suno 用プロンプトを解析し、Suno のカスタム作成欄へ自動入力します。必要なら生成まで実行します。
// @match        https://suno.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// 配布して自動更新も使いたい場合は、配布用 metadata に設定する URL 例です。
// @downloadURL  https://raw.githubusercontent.com/monmonx2-cmd/Tampermonkey/main/suno一括入力.user.js
// @updateURL    https://raw.githubusercontent.com/monmonx2-cmd/Tampermonkey/main/suno一括入力.user.js
// そのうえで更新のたびに @version を上げると、利用者側の Tampermonkey が自動更新を検知できます。

(function () {
  'use strict';

  const PANEL_ID = 'tm-suno-autofill-panel';
  const STATUS_ID = 'tm-suno-autofill-status';
  const INPUT_ID = 'tm-suno-autofill-input';
  const STORAGE_KEY = 'tm-suno-autofill-panel-pos-v1';
  const POLL_INTERVAL_MS = 1000;
  const MAX_FIELD_SEARCH_DEPTH = 5;
  const FIELD_TYPES = ['textarea', 'input', 'select', '[contenteditable="true"]', '[role="textbox"]', '[role="combobox"]', '[aria-autocomplete]'];

  const HEADING_ALIASES = {
    title: ['曲名', 'title', 'song title', 'track title', 'タイトル'],
    lyrics: ['lyrics', 'lyric', '歌詞'],
    styles: ['styles', 'style', 'genre', 'mood', 'スタイル'],
    excludeStyles: ['exclude styles', 'exclude style', 'exclude', 'negative prompt', 'negative', 'avoid', '除外スタイル'],
    weirdness: ['weirdness', 'weird', '奇妙さ'],
    styleInfluence: ['style influence', 'influence', 'style strength', 'スタイル影響', '影響度'],
    voiceGender: ['voice gender', 'vocal gender', 'gender', 'voice', '性別', 'ボーカル性別']
  };

  const MALE_PATTERNS = [
    /^male$/i,
    /^man$/i,
    /^male vocal$/i,
    /^solo male vocal$/i,
    /^男性$/,
    /^男$/,
    /^男声$/
  ];

  const FEMALE_PATTERNS = [
    /^female$/i,
    /^woman$/i,
    /^female vocal$/i,
    /^solo female vocal$/i,
    /^女性$/,
    /^女$/,
    /^女声$/
  ];

  const STYLE_GENDER_TOKENS = [
    'male',
    'female',
    'male vocal',
    'female vocal',
    'solo male vocal',
    'solo female vocal'
  ];

  const GENERATE_LABELS = [
    'generate',
    'create',
    'make song',
    'make',
    '生成',
    '作成'
  ];

  const FIELD_HINTS = {
    title: ['title', 'song title', 'track title', '曲名', 'タイトル'],
    lyrics: ['lyrics', 'lyric', '歌詞'],
    styles: ['styles', 'style', 'genre', 'mood', 'describe your song', 'スタイル'],
    excludeStyles: ['exclude styles', 'exclude style', 'exclude', 'negative prompt', 'avoid', '除外'],
    weirdness: ['weirdness', 'weird'],
    styleInfluence: ['style influence', 'influence'],
    voiceGender: ['voice gender', 'vocal gender', 'gender', 'voice']
  };

  const state = {
    parsed: null,
    lastStatus: '',
    observer: null
  };

  function log(...args) {
    console.log('[Suno 自動入力]', ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/[：]/g, ':')
      .replace(/[\t\u00A0]+/g, ' ')
      .trim();
  }

  function cleanPastedText(raw) {
    let text = String(raw || '');
    text = text.replace(/^```[a-zA-Z0-9_-]*\n?/gm, '');
    text = text.replace(/^```$/gm, '');
    return text.replace(/\r/g, '');
  }

  function toLines(text) {
    return cleanPastedText(text)
      .split('\n')
      .map((line) => line.replace(/\u3000/g, ' ').replace(/[\t]+/g, ' '));
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function allAliases() {
    const entries = [];
    for (const [key, aliases] of Object.entries(HEADING_ALIASES)) {
      for (const alias of aliases) {
        entries.push({ key, alias });
      }
    }
    return entries.sort((a, b) => b.alias.length - a.alias.length);
  }

  const SORTED_ALIASES = allAliases();

  function detectHeading(line) {
    const trimmed = normalizeText(line);
    if (!trimmed) return null;

    for (const { key, alias } of SORTED_ALIASES) {
      const pattern = new RegExp(`^${escapeRegExp(alias)}(?:\\s*:)?\\s*(.*)$`, 'i');
      const match = trimmed.match(pattern);
      if (match) {
        return { key, inlineValue: match[1] ? match[1].trim() : '' };
      }
    }
    return null;
  }

  function normalizeGender(raw) {
    const value = normalizeText(raw).toLowerCase();
    if (!value) return '';
    if (MALE_PATTERNS.some((p) => p.test(raw.trim())) || /\bmale\b/i.test(value) || /\bman\b/i.test(value)) {
      return 'male';
    }
    if (FEMALE_PATTERNS.some((p) => p.test(raw.trim())) || /\bfemale\b/i.test(value) || /\bwoman\b/i.test(value)) {
      return 'female';
    }
    return '';
  }

  function extractNumeric(raw) {
    const match = String(raw || '').match(/-?\d+(?:\.\d+)?/);
    return match ? match[0] : '';
  }

  function parsePrompt(text) {
    const lines = toLines(text);
    const result = {
      title: '',
      lyrics: '',
      styles: '',
      excludeStyles: '',
      weirdness: '',
      styleInfluence: '',
      voiceGender: ''
    };

    const warnings = [];
    let currentKey = null;
    const buckets = {
      title: [],
      lyrics: [],
      styles: [],
      excludeStyles: [],
      weirdness: [],
      styleInfluence: [],
      voiceGender: []
    };

    for (const line of lines) {
      const heading = detectHeading(line);
      if (heading) {
        currentKey = heading.key;
        if (heading.inlineValue) buckets[currentKey].push(heading.inlineValue);
        continue;
      }
      if (currentKey) buckets[currentKey].push(line);
    }

    result.title = buckets.title.join('\n').trim();
    result.lyrics = buckets.lyrics.join('\n').trim();
    result.styles = buckets.styles.join('\n').trim();
    result.excludeStyles = buckets.excludeStyles.join('\n').trim();
    result.weirdness = extractNumeric(buckets.weirdness.join(' ').trim());
    result.styleInfluence = extractNumeric(buckets.styleInfluence.join(' ').trim());

    const genderRaw = buckets.voiceGender.join(' ').trim();
    result.voiceGender = normalizeGender(genderRaw);
    if (genderRaw && !result.voiceGender) warnings.push('性別未認識');

    return { data: result, warnings };
  }

  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && style.opacity !== '0'
      && rect.width > 1
      && rect.height > 1;
  }

  function normalizedNodeText(el) {
    if (!el) return '';
    const parts = [
      el.textContent,
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('placeholder'),
      el.getAttribute && el.getAttribute('name'),
      el.getAttribute && el.getAttribute('id'),
      el.getAttribute && el.getAttribute('data-testid')
    ].filter(Boolean);
    return normalizeText(parts.join(' | ')).toLowerCase();
  }

  function collectLabelText(el) {
    const texts = new Set();
    let node = el;
    for (let i = 0; node && i < MAX_FIELD_SEARCH_DEPTH; i += 1) {
      if (node instanceof HTMLElement) {
        const id = node.getAttribute('id');
        if (id) {
          document.querySelectorAll(`label[for="${CSS.escape(id)}"]`).forEach((label) => {
            texts.add(normalizeText(label.textContent || '').toLowerCase());
          });
        }
        node.querySelectorAll?.('label').forEach((label) => {
          texts.add(normalizeText(label.textContent || '').toLowerCase());
        });
        texts.add(normalizedNodeText(node));
      }
      node = node.parentElement;
    }
    return Array.from(texts).join(' | ');
  }

  function scoreField(el, hints) {
    const text = [normalizedNodeText(el), collectLabelText(el)].join(' | ');
    let score = 0;
    for (const hint of hints) {
      const norm = hint.toLowerCase();
      if (text.includes(norm)) score += norm.length;
    }
    if (el.tagName === 'TEXTAREA') score += 2;
    if (el.matches('[contenteditable="true"]')) score += 1;
    if (el.matches('[role="combobox"], [aria-autocomplete]')) score += 2;
    return score;
  }

  function getCandidateFields(root = document) {
    return Array.from(root.querySelectorAll(FIELD_TYPES.join(',')))
      .filter((el) => isVisible(el) && !el.closest(`#${PANEL_ID}`));
  }

  function getElementLabelText(el) {
    if (!el || !(el instanceof HTMLElement)) return '';
    const raw = normalizeText(el.innerText || el.textContent || '');
    if (!raw) return '';
    const firstLine = raw.split(/\n+/).map((part) => normalizeText(part)).find(Boolean) || raw;
    return firstLine.toLowerCase();
  }

  function findRowContainerInRoot(labels, root) {
    const heading = findHeadingElementInRoot(labels, root);
    if (!heading) return null;
    const targetLabels = labels.map((label) => label.toLowerCase());
    const crossRowMarkers = ['vocal gender', 'lyrics mode', 'weirdness', 'style influence', 'exclude'];
    let best = heading;
    let bestScore = -Infinity;
    let node = heading;
    for (let i = 0; node && i < 5; i += 1) {
      if (node instanceof HTMLElement) {
        const rect = node.getBoundingClientRect?.();
        if (rect && rect.width >= 220 && rect.height >= 40 && rect.height <= 240) {
          const text = normalizeText(node.innerText || node.textContent || '').toLowerCase();
          let score = 0;
          score += 80 - i * 10;
          score += Math.max(0, 200 - rect.height);
          targetLabels.forEach((label) => {
            if (text.includes(label)) score += 80;
          });
          const foreignHits = crossRowMarkers.filter((marker) => !targetLabels.includes(marker) && text.includes(marker)).length;
          if (foreignHits) score -= foreignHits * 60;
          if (score > bestScore) {
            best = node;
            bestScore = score;
          }
        }
      }
      node = node.parentElement;
    }
    return best.parentElement && best === heading ? best.parentElement : best;
  }

  function findHeadingElementInRoot(labels, root) {
    const searchRoot = root || document.body;
    const lowered = labels.map((label) => label.toLowerCase());
    const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = normalizeText(node.textContent || '');
        if (!value || value.length > 60) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || !isVisible(parent) || parent.closest(`#${PANEL_ID}`)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const matches = [];
    let current;
    while ((current = walker.nextNode())) {
      const value = normalizeText(current.textContent || '').toLowerCase();
      let score = 0;
      lowered.forEach((label) => {
        if (value === label) score += label.length + 200;
        else if (value.startsWith(label)) score += label.length + 40;
        else if (value.includes(label)) score += label.length;
      });
      if (score > 0 && current.parentElement) matches.push({ el: current.parentElement, score });
    }

    matches.sort((a, b) => b.score - a.score);
    return matches[0]?.el || null;
  }

  function findHeadingElement(labels) {
    const lowered = labels.map((label) => label.toLowerCase());
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = normalizeText(node.textContent || '');
        if (!value || value.length > 40) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || !isVisible(parent) || parent.closest(`#${PANEL_ID}`)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const matches = [];
    let current;
    while ((current = walker.nextNode())) {
      const value = normalizeText(current.textContent || '').toLowerCase();
      let score = 0;
      lowered.forEach((label) => {
        if (value === label) score += label.length + 200;
        else if (value.startsWith(label)) score += label.length + 40;
        else if (value.includes(label)) score += label.length;
      });
      if (score > 0 && current.parentElement) {
        matches.push({ el: current.parentElement, score });
      }
    }

    if (matches.length) {
      matches.sort((a, b) => b.score - a.score);
      return matches[0].el;
    }

    const fallback = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, label, span, div, p'))
      .filter((el) => isVisible(el) && !el.closest(`#${PANEL_ID}`))
      .map((el) => {
        const labelText = getElementLabelText(el);
        if (!labelText || labelText.length > 40) return { el, score: 0 };
        let score = 0;
        lowered.forEach((label) => {
          if (labelText === label) score += label.length + 100;
          else if (labelText.startsWith(label)) score += label.length + 20;
          else if (labelText.includes(label)) score += label.length;
        });
        return { el, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return fallback[0]?.el || null;
  }

  function findMoreOptionsSection() {
    return findSectionContainerByHeading(['more options', 'advanced options', '詳細', '詳細設定']);
  }

  function findSectionContainerByHeading(labels) {
    const heading = findHeadingElement(labels);
    if (!heading) return null;

    const headingText = getElementLabelText(heading);
    const viewportHeight = window.innerHeight || 1200;
    let best = heading;
    let bestScore = -Infinity;
    let node = heading;

    for (let i = 0; node && i < 7; i += 1) {
      if (node instanceof HTMLElement) {
        const rect = node.getBoundingClientRect?.();
        if (rect && rect.width >= 220 && rect.height >= 32 && rect.height <= viewportHeight * 0.75) {
          const text = normalizeText(node.innerText || node.textContent || '').toLowerCase();
          let score = 0;
          score += Math.min(rect.height, 420);
          score += Math.min(rect.width / 10, 80);
          score -= i * 8;
          if (text.includes(headingText)) score += 30;
          if (text.length > headingText.length + 20) score += 20;
          if (rect.height >= 80) score += 20;
          if (rect.height > viewportHeight * 0.6) score -= 120;

          const topLevelMarkers = ['audio', 'persona', 'inspo', 'lyrics', 'styles', 'more options', 'save to'];
          const markerHits = topLevelMarkers.filter((marker) => text.includes(marker)).length;
          if (markerHits >= 3) score -= markerHits * 80;
          else if (markerHits === 2 && !text.startsWith(headingText)) score -= 60;

          if (score > bestScore) {
            best = node;
            bestScore = score;
          }
        }
      }
      node = node.parentElement;
    }

    return best;
  }

  function findFieldFromLabeledContainers(fieldKey) {
    const hints = (FIELD_HINTS[fieldKey] || []).map((hint) => hint.toLowerCase());
    const containers = Array.from(document.querySelectorAll('label, section, div, fieldset'))
      .filter((el) => isVisible(el) && !el.closest(`#${PANEL_ID}`));

    const rankedContainers = containers
      .map((el) => {
        const text = normalizedNodeText(el);
        let score = 0;
        hints.forEach((hint) => {
          if (text.includes(hint)) score += hint.length;
        });
        return { el, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const { el } of rankedContainers) {
      const descendants = getCandidateFields(el);
      const bestDescendant = descendants
        .map((node) => ({ el: node, score: scoreField(node, FIELD_HINTS[fieldKey] || []) + 20 }))
        .sort((a, b) => b.score - a.score)[0];
      if (bestDescendant) return bestDescendant.el;

      const parent = el.parentElement;
      if (parent) {
        const siblingDescendants = getCandidateFields(parent);
        const bestSibling = siblingDescendants
          .map((node) => ({ el: node, score: scoreField(node, FIELD_HINTS[fieldKey] || []) + 10 }))
          .sort((a, b) => b.score - a.score)[0];
        if (bestSibling) return bestSibling.el;
      }
    }

    return null;
  }

  function findBestField(fieldKey) {
    if (fieldKey === 'styles') {
      const stylesSection = findSectionContainerByHeading(['styles']);
      if (stylesSection) {
        return findEditorSurface(stylesSection) || findLargeTextSurface(stylesSection) || stylesSection;
      }
    }

    const moreOptionsSection = findMoreOptionsSection();
    if (['excludeStyles', 'weirdness', 'styleInfluence', 'voiceGender'].includes(fieldKey) && moreOptionsSection && isVisible(moreOptionsSection)) {
      const rowHintsMap = {
        excludeStyles: ['exclude styles', 'exclude style', 'exclude'],
        weirdness: ['weirdness'],
        styleInfluence: ['style influence'],
        voiceGender: ['vocal gender', 'voice gender', 'gender']
      };
      const row = findRowContainerInRoot(rowHintsMap[fieldKey] || [], moreOptionsSection);
      if (row) {
        if (['weirdness', 'styleInfluence', 'voiceGender'].includes(fieldKey)) {
          return row;
        }
        const scopedCandidates = getCandidateFields(row)
          .map((el) => ({ el, score: scoreField(el, FIELD_HINTS[fieldKey] || []) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        if (scopedCandidates[0]?.el) return scopedCandidates[0].el;
        return row;
      }
    }

    if (fieldKey === 'excludeStyles') {
      const excludeSection = findSectionContainerByHeading(['exclude styles', 'exclude style', 'exclude']);
      if (excludeSection) {
        return findEditorSurface(excludeSection) || findLargeTextSurface(excludeSection) || excludeSection;
      }
    }

    const containerMatch = findFieldFromLabeledContainers(fieldKey);
    if (containerMatch) return containerMatch;

    const hints = FIELD_HINTS[fieldKey] || [];
    const candidates = getCandidateFields()
      .map((el) => ({ el, score: scoreField(el, hints) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function isWritableElement(el) {
    return !!el && (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      el.isContentEditable ||
      el.getAttribute?.('role') === 'textbox'
    );
  }

  function findEditorSurface(el) {
    if (!el || !(el instanceof HTMLElement)) return null;
    const descendants = Array.from(el.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"], [tabindex]'))
      .filter((node) => isVisible(node) && !node.closest('button, [role="button"]'));
    const ranked = descendants
      .map((node) => {
        const rect = node.getBoundingClientRect();
        let score = rect.width * Math.max(rect.height, 1);
        if (isWritableElement(node)) score += 100000;
        if (node.matches('[contenteditable="true"], [role="textbox"]')) score += 50000;
        if (node.matches('[tabindex]')) score += 1000;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.node || null;
  }

  function activateEditableSurface(el) {
    if (!el || !(el instanceof HTMLElement)) return null;
    const candidates = [el, findEditorSurface(el)].filter(Boolean);

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      clickElement(candidate);
      candidate.focus?.();

      const active = document.activeElement;
      if (isWritableElement(active)) return active;

      const liveInner = candidate.querySelector?.('input, textarea, select, [contenteditable="true"], [role="textbox"]');
      if (isWritableElement(liveInner) && isVisible(liveInner)) return liveInner;
    }

    const selectionNode = window.getSelection()?.anchorNode;
    const selectionElement = selectionNode?.nodeType === Node.TEXT_NODE ? selectionNode.parentElement : selectionNode;
    if (isWritableElement(selectionElement)) return selectionElement;
    return null;
  }

  function resolveWritableElement(el) {
    if (!el) return null;
    if (isWritableElement(el)) {
      return el;
    }
    const inner = el.querySelector?.('input, textarea, select, [contenteditable="true"], [role="textbox"]');
    if (inner && isVisible(inner)) return inner;
    return activateEditableSurface(el) || el;
  }

  function dispatchInputEvents(el, finalValue) {
    const inputEventPayload = { bubbles: true, cancelable: true, data: finalValue, inputType: 'insertText' };
    try {
      el.dispatchEvent(new InputEvent('beforeinput', inputEventPayload));
    } catch (_error) {
      // ignore unsupported InputEvent
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function findLargeTextSurface(container) {
    if (!container || !(container instanceof HTMLElement)) return null;
    const descendants = Array.from(container.querySelectorAll('div, p, span'))
      .filter((node) => isVisible(node) && !node.closest('button, [role="button"]'));

    const ranked = descendants
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const text = normalizeText(node.textContent || '');
        let score = rect.width * Math.max(rect.height, 1);
        if (text.length >= 8) score += 30000;
        if (rect.height >= 60) score += 50000;
        if (rect.top < container.getBoundingClientRect().top + 220) score += 20000;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.node || null;
  }

  function setSurfaceText(el, value) {
    const surface = findLargeTextSurface(el);
    if (!surface) return false;
    clickElement(surface);
    surface.textContent = String(value);
    dispatchInputEvents(surface, String(value));
    let parent = surface.parentElement;
    for (let i = 0; parent && i < 3; i += 1) {
      dispatchInputEvents(parent, String(value));
      parent = parent.parentElement;
    }
    return normalizeText(surface.textContent || '') === normalizeText(String(value));
  }

  function dispatchPasteLikeEvent(el, value) {
    if (!el) return false;
    try {
      const data = new DataTransfer();
      data.setData('text/plain', String(value));
      const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      el.dispatchEvent(pasteEvent);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function describeElement(el) {
    if (!el || !(el instanceof Element)) return '(none)';
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push(`#${el.id}`);
    const role = el.getAttribute('role');
    if (role) parts.push(`[role="${role}"]`);
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(`aria="${aria}"`);
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    if (cls) parts.push(`.${cls}`);
    return parts.join(' ');
  }

  function forcePasteIntoSurface(el, value) {
    const surface = findLargeTextSurface(el);
    if (!surface) return { ok: false, detail: 'surface not found' };

    clickElement(surface);
    surface.focus?.();

    const active = document.activeElement;
    if (active && active !== document.body && active !== surface && setElementValue(active, value)) {
      return { ok: true, detail: `active element write: ${describeElement(active)}` };
    }

    const pasteTarget = active && active !== document.body ? active : surface;
    const pasted = dispatchPasteLikeEvent(pasteTarget, value);
    if (pasted) {
      dispatchInputEvents(pasteTarget, String(value));
    }

    const selectedNode = window.getSelection()?.anchorNode;
    const selectedEl = selectedNode?.nodeType === Node.TEXT_NODE ? selectedNode.parentElement : selectedNode;
    if (selectedEl && selectedEl !== pasteTarget && setElementValue(selectedEl, value)) {
      return { ok: true, detail: `selection write: ${describeElement(selectedEl)}` };
    }

    const replaced = setSurfaceText(el, value);
    return {
      ok: replaced || pasted,
      detail: `surface=${describeElement(surface)}, active=${describeElement(active)}, selection=${describeElement(selectedEl)}`
    };
  }

  function extractPercentFromText(text) {
    const matches = String(text || '').match(/(\d{1,3})\s*%/g);
    if (!matches || !matches.length) return null;
    const last = matches[matches.length - 1].match(/(\d{1,3})/);
    return last ? Number(last[1]) : null;
  }

  function readElementText(el) {
    if (!el) return '';
    const target = resolveWritableElement(el);
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      return String(target.value || '');
    }
    if (target?.isContentEditable || target?.getAttribute?.('role') === 'textbox') {
      return String(target.textContent || '');
    }
    const surface = findLargeTextSurface(el);
    if (surface) return String(surface.textContent || '');
    return String(el.textContent || '');
  }

  function readFieldValue(fieldKey, el) {
    if (fieldKey === 'weirdness' || fieldKey === 'styleInfluence') {
      const actualPercent = extractPercentFromText(normalizeText(el?.textContent || ''));
      return actualPercent == null ? '' : `${actualPercent}`;
    }
    return normalizeText(readElementText(el));
  }

  function valueLooksApplied(fieldKey, el, expectedValue) {
    if (!expectedValue) return true;
    const actual = normalizeText(readFieldValue(fieldKey, el)).toLowerCase();
    const expected = normalizeText(expectedValue).toLowerCase();
    if (!actual) return false;

    if (fieldKey === 'styles' || fieldKey === 'excludeStyles') {
      const parts = expected
        .split(',')
        .map((part) => normalizeText(part).toLowerCase())
        .filter((part) => part.length >= 3);
      if (!parts.length) return actual.includes(expected);
      const matched = parts.filter((part) => actual.includes(part));
      return matched.length >= Math.min(parts.length, 2);
    }

    if (fieldKey === 'weirdness' || fieldKey === 'styleInfluence') {
      const actualPercent = Number(actual);
      const expectedPercent = Number(extractNumeric(expected));
      if (Number.isNaN(actualPercent) || Number.isNaN(expectedPercent)) return false;
      return Math.abs(actualPercent - expectedPercent) <= 3;
    }

    return actual.includes(expected) || expected.includes(actual);
  }

  function setElementValue(el, value) {
    const target = resolveWritableElement(el);
    if (!target) return false;
    const finalValue = value == null ? '' : String(value);

    target.focus?.();

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(target, finalValue);
      } else {
        target.value = finalValue;
      }
      dispatchInputEvents(target, finalValue);
      return true;
    }

    if (target instanceof HTMLSelectElement) {
      const option = Array.from(target.options).find((opt) => normalizeText(opt.textContent || '').toLowerCase() === finalValue.toLowerCase());
      target.value = option ? option.value : finalValue;
      dispatchInputEvents(target, finalValue);
      return true;
    }

    if (target.isContentEditable || target.getAttribute?.('role') === 'textbox') {
      target.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand?.('selectAll', false, null);
      document.execCommand?.('insertText', false, finalValue);
      if (normalizeText(target.textContent || '') !== normalizeText(finalValue)) {
        target.textContent = finalValue;
      }
      dispatchInputEvents(target, finalValue);
      return true;
    }

    if (target.getAttribute?.('role') === 'combobox') {
      const inner = resolveWritableElement(target);
      if (inner && inner !== target) {
        return setElementValue(inner, finalValue);
      }
    }

    return false;
  }

  function readSliderPercent(el) {
    if (!el) return null;
    const ariaValueNow = el.getAttribute?.('aria-valuenow');
    if (ariaValueNow != null && ariaValueNow !== '') {
      const numeric = Number(extractNumeric(ariaValueNow));
      if (!Number.isNaN(numeric)) return numeric;
    }
    const ariaValueText = el.getAttribute?.('aria-valuetext');
    const ariaPercent = extractPercentFromText(ariaValueText || '');
    if (ariaPercent != null) return ariaPercent;
    const textPercent = extractPercentFromText(el.textContent || '');
    if (textPercent != null) return textPercent;
    return null;
  }

  function keyEventCode(key) {
    const codes = {
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      ArrowLeft: 37,
      ArrowRight: 39,
      Enter: 13,
      ' ': 32
    };
    return codes[key] || 0;
  }

  function dispatchKeyboardStep(el, key, count) {
    let moved = false;
    const keyCode = keyEventCode(key);
    const code = key === ' ' ? 'Space' : key;
    for (let i = 0; i < count; i += 1) {
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        try {
          el.dispatchEvent(new KeyboardEvent(type, {
            bubbles: true,
            key,
            code,
            keyCode,
            which: keyCode,
            charCode: keyCode,
            cancelable: true
          }));
        } catch (_error) {
          // ignore unsupported keyboard cases
        }
      });
      moved = true;
    }
    return moved;
  }

  function dragSliderToPercent(slider, numeric) {
    if (!slider || !(slider instanceof HTMLElement)) return false;
    const rect = slider.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const ratio = Math.max(0, Math.min(100, Number(numeric))) / 100;
    const startX = rect.left + rect.width * 0.5;
    const endX = rect.left + rect.width * Math.min(0.98, Math.max(0.02, ratio));
    const y = rect.top + rect.height * 0.5;
    const pointerPayload = (clientX) => ({
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1
    });
    const mousePayload = (clientX) => ({
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: y,
      button: 0,
      buttons: 1,
      view: window
    });

    slider.focus?.();
    try {
      slider.dispatchEvent(new PointerEvent('pointerover', pointerPayload(startX)));
      slider.dispatchEvent(new PointerEvent('pointerenter', pointerPayload(startX)));
      slider.dispatchEvent(new PointerEvent('pointerdown', pointerPayload(startX)));
      slider.dispatchEvent(new PointerEvent('pointermove', pointerPayload(endX)));
      document.dispatchEvent(new PointerEvent('pointermove', pointerPayload(endX)));
      slider.dispatchEvent(new PointerEvent('pointerup', { ...pointerPayload(endX), buttons: 0 }));
    } catch (_error) {
      // ignore PointerEvent unsupported cases
    }

    slider.dispatchEvent(new MouseEvent('mouseover', mousePayload(startX)));
    slider.dispatchEvent(new MouseEvent('mouseenter', mousePayload(startX)));
    slider.dispatchEvent(new MouseEvent('mousedown', mousePayload(startX)));
    slider.dispatchEvent(new MouseEvent('mousemove', mousePayload(endX)));
    document.dispatchEvent(new MouseEvent('mousemove', mousePayload(endX)));
    slider.dispatchEvent(new MouseEvent('mouseup', { ...mousePayload(endX), buttons: 0 }));
    slider.dispatchEvent(new MouseEvent('click', { ...mousePayload(endX), buttons: 0 }));
    return true;
  }

  function setSliderLike(el, value) {
    if (!el || value === '') return false;
    const numeric = extractNumeric(value);
    if (!numeric) return false;

    if (el instanceof HTMLInputElement) {
      if (['range', 'number', 'text'].includes(el.type) || !el.type) {
        return setElementValue(el, numeric);
      }
    }

    const directSlider = el.matches?.('[role="slider"], [aria-valuenow], input[type="range"], input[type="number"]')
      ? el
      : el.querySelector?.('[role="slider"], [aria-valuenow], input[type="range"], input[type="number"]');
    if (directSlider && directSlider !== el) {
      return setSliderLike(directSlider, numeric) || setElementValue(directSlider, numeric);
    }

    const ariaValueNow = el.getAttribute?.('aria-valuenow');
    if (ariaValueNow != null) {
      el.setAttribute('aria-valuenow', numeric);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (el instanceof HTMLElement && el.matches?.('[role="slider"]')) {
      el.focus?.();
      clickElement(el);
      const current = readSliderPercent(el);
      let moved = false;
      if (current != null) {
        if (Number(numeric) <= 5) moved = dispatchKeyboardStep(el, 'Home', 1) || moved;
        else if (Number(numeric) >= 95) moved = dispatchKeyboardStep(el, 'End', 1) || moved;
        const delta = Number(numeric) - current;
        const pageSteps = Math.floor(Math.abs(delta) / 10);
        if (pageSteps > 0) moved = dispatchKeyboardStep(el, delta > 0 ? 'PageUp' : 'PageDown', pageSteps) || moved;
        const arrowSteps = Math.abs(Number(numeric) - (current + (delta > 0 ? pageSteps * 10 : -pageSteps * 10)));
        if (arrowSteps > 0) moved = dispatchKeyboardStep(el, delta > 0 ? 'ArrowRight' : 'ArrowLeft', Math.min(arrowSteps, 12)) || moved;
      }
      moved = dragSliderToPercent(el, numeric) || moved;
      moved = clickSliderRowByPercent(el, numeric) || moved;
      if (moved) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    if (el instanceof HTMLElement) {
      const clicked = clickSliderRowByPercent(el, numeric);
      if (clicked) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    return false;
  }

  function clickElement(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
    return true;
  }

  function clickAtPosition(container, ratioX, ratioY = 0.5) {
    if (!container || !(container instanceof HTMLElement)) return false;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = rect.left + rect.width * ratioX;
    const y = rect.top + rect.height * ratioY;
    const target = document.elementFromPoint(x, y) || container;
    ['pointerover', 'pointerdown', 'pointerup'].forEach((type) => {
      try {
        target.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: y,
          pointerType: 'mouse'
        }));
      } catch (_error) {
        // ignore PointerEvent unsupported cases
      }
    });
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach((type) => {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        view: window
      }));
    });
    return true;
  }

  function findSliderTrackInRow(row) {
    if (!row || !(row instanceof HTMLElement)) return row;
    const rowRect = row.getBoundingClientRect();
    const descendants = [row, ...Array.from(row.querySelectorAll('div, span, button, [role="slider"], [aria-valuenow]'))]
      .filter((el) => el instanceof HTMLElement && isVisible(el));

    const ranked = descendants
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const widthScore = Math.min(rect.width, rowRect.width) * 2;
        const heightPenalty = rect.height >= 8 && rect.height <= Math.max(56, rowRect.height + 12) ? 0 : 120;
        const rightBias = rowRect.width > 0 ? Math.max(0, rect.left + rect.width / 2 - (rowRect.left + rowRect.width * 0.35)) : 0;
        const areaPenalty = rect.width * rect.height > rowRect.width * Math.max(rowRect.height, 1) * 0.9 ? 120 : 0;
        const textPenalty = normalizeText(el.textContent || '').length > 80 ? 160 : 0;
        const sliderBonus = el.matches('[role="slider"], [aria-valuenow]') ? 400 : 0;
        const score = widthScore + rightBias + sliderBonus - heightPenalty - areaPenalty - textPenalty;
        return { el, score, rect };
      })
      .filter(({ rect }) => rect.width >= 40 && rect.height >= 4)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.el || row;
  }

  function clickSliderRowByPercent(row, numeric) {
    if (!row || !(row instanceof HTMLElement)) return false;
    const target = findSliderTrackInRow(row) || row;
    const normalized = Math.max(0, Math.min(100, Number(numeric))) / 100;
    const attempts = [
      [0.08 + normalized * 0.84, 0.50],
      [0.10 + normalized * 0.80, 0.35],
      [0.10 + normalized * 0.80, 0.65],
      [0.12 + normalized * 0.76, 0.50]
    ];
    let clicked = false;
    attempts.forEach(([x, y]) => {
      clicked = clickAtPosition(target, x, y) || clicked;
    });
    return clicked;
  }

  function findButtonLike(labels, root = document.body) {
    const nodes = Array.from(root.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], [role="option"], summary, div, span'))
      .filter((el) => isVisible(el));

    const lowered = labels.map((label) => label.toLowerCase());
    const matches = nodes
      .map((el) => {
        const text = normalizedNodeText(el);
        let score = 0;
        lowered.forEach((label) => {
          if (text.includes(label)) score += label.length;
        });
        return { el, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return matches[0]?.el || null;
  }

  function getActionLabels(el) {
    if (!el) return '';
    return normalizeText([
      el.innerText,
      el.textContent,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.getAttribute?.('value'),
      el.getAttribute?.('name'),
      el.getAttribute?.('data-testid')
    ].filter(Boolean).join(' | ')).toLowerCase();
  }

  function isDisabledButton(el) {
    if (!el) return true;
    const ariaDisabled = el.getAttribute?.('aria-disabled');
    return Boolean(el.disabled || ariaDisabled === 'true');
  }

  function findGenerateButton() {
    const lowered = GENERATE_LABELS.map((label) => label.toLowerCase());
    const nodes = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a, div, span'))
      .filter((el) => el instanceof HTMLElement && isVisible(el) && !el.closest(`#${PANEL_ID}`));

    const ranked = nodes
      .map((el) => {
        const labelText = getActionLabels(el);
        if (!labelText) return { el, score: -Infinity };
        let score = 0;
        lowered.forEach((label) => {
          if (labelText === label) score += 240;
          else if (labelText.startsWith(label)) score += 120;
          else if (labelText.includes(label)) score += 40;
        });
        if (score <= 0) return { el, score: -Infinity };
        const rect = el.getBoundingClientRect();
        if (el.matches('button, input, [role="button"]')) score += 60;
        if (rect.width >= 80 && rect.height >= 28) score += 30;
        score += Math.max(0, rect.top / 20);
        if (isDisabledButton(el)) score -= 400;
        return { el, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.el || null;
  }

  function triggerActionButton(el) {
    if (!el || !(el instanceof HTMLElement) || isDisabledButton(el)) return false;
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    el.focus?.();

    if (el.matches('button, input, a')) {
      return clickElement(el);
    }

    if (el.matches('[role="button"], div, span')) {
      return clickAtPosition(el, 0.5, 0.5);
    }

    return clickElement(el);
  }

  function hasVisibleAdvancedFields() {
    return Boolean(
      findHeadingElement(['exclude styles', 'exclude style']) ||
      findHeadingElement(['vocal gender', 'voice gender', 'gender']) ||
      findHeadingElement(['weirdness']) ||
      findHeadingElement(['style influence'])
    );
  }

  function needsMoreOptions(data) {
    return Boolean(data?.excludeStyles || data?.voiceGender || data?.weirdness || data?.styleInfluence);
  }

  function ensureMoreOptionsVisible(data) {
    return needsMoreOptions(data) ? hasVisibleAdvancedFields() : false;
  }

  function hasInstrumentalStyle(styles) {
    return /\binstrumental\b/i.test(styles || '');
  }

  function stylesContainGender(styles) {
    const text = normalizeText(styles).toLowerCase();
    return STYLE_GENDER_TOKENS.some((token) => text.includes(token));
  }

  function appendGenderToStyles(styles, gender) {
    if (!gender) return styles;
    const base = (styles || '').trim();
    if (stylesContainGender(base)) return base;

    const token = gender === 'male' ? 'solo male vocal' : 'solo female vocal';
    if (!base) return token;
    return `${base.replace(/[\s,]+$/, '')}, ${token}`;
  }

  function findLabeledContainer(labels) {
    const all = Array.from(document.querySelectorAll('section, div, fieldset'));
    const lowered = labels.map((v) => v.toLowerCase());
    const ranked = all
      .filter((el) => isVisible(el))
      .map((el) => {
        const text = normalizedNodeText(el);
        let score = 0;
        lowered.forEach((label) => {
          if (text.includes(label)) score += label.length;
        });
        return { el, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.el || null;
  }

  function findGenderControlRoot() {
    const moreOptionsSection = findMoreOptionsSection();
    if (moreOptionsSection && isVisible(moreOptionsSection)) {
      const row = findRowContainerInRoot(['vocal gender', 'voice gender', 'gender'], moreOptionsSection);
      if (row) {
        return row;
      }
      const local = findButtonLike(['vocal gender', 'voice gender', 'gender'], moreOptionsSection)?.parentElement;
      if (local) return local;
    }
    return findLabeledContainer(FIELD_HINTS.voiceGender);
  }

  function findGenderOption(root, labels) {
    if (!root) return null;
    const lowered = labels.map((label) => label.toLowerCase());
    const candidates = Array.from(root.querySelectorAll('button, label, [role="radio"], [role="button"], span, div'))
      .filter((el) => el instanceof HTMLElement && isVisible(el))
      .map((el) => {
        const text = normalizeText(el.innerText || el.textContent || '').toLowerCase();
        if (!text || text.length > 40) return { el, score: -Infinity };
        let score = 0;
        lowered.forEach((label) => {
          if (text === label) score += 300;
          else if (text.startsWith(label)) score += 120;
          else if (text.includes(label)) score += 40;
        });
        const rect = el.getBoundingClientRect();
        if (rect.width > 12 && rect.width < 220 && rect.height > 12 && rect.height < 80) score += 20;
        if (el.matches('button, label, [role="radio"], [role="button"]')) score += 40;
        return { el, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function readGenderSelectionState(root, gender) {
    if (!root || !gender) return 'unknown';
    const selectedTokens = gender === 'male'
      ? ['male', 'man', '男性', '男']
      : ['female', 'woman', '女性', '女'];
    const candidates = Array.from(root.querySelectorAll('button, label, [role="radio"], [role="button"], span, div'))
      .filter((el) => el instanceof HTMLElement && isVisible(el));

    for (const el of candidates) {
      const text = normalizeText(el.innerText || el.textContent || '').toLowerCase();
      if (!text || !selectedTokens.some((token) => text === token || text.startsWith(token))) continue;
      const classText = `${el.className || ''}`.toLowerCase();
      const dataState = `${el.getAttribute?.('data-state') || ''}`.toLowerCase();
      const ariaChecked = el.getAttribute?.('aria-checked');
      const ariaPressed = el.getAttribute?.('aria-pressed');
      const ariaSelected = el.getAttribute?.('aria-selected');
      if ([ariaChecked, ariaPressed, ariaSelected].some((value) => value === 'true')) return 'selected';
      if (['checked', 'active', 'selected', 'on'].includes(dataState)) return 'selected';
      if (/(selected|active|checked)/.test(classText)) return 'selected';
    }

    return 'unknown';
  }

  function chooseGenderInUi(gender) {
    if (!gender) return { mode: 'none', ok: false, message: '性別指定なし' };

    const root = findGenderControlRoot();
    const labels = gender === 'male'
      ? ['male', 'men', 'man', '男性', '男', 'male vocal']
      : ['female', 'women', 'woman', '女性', '女', 'female vocal'];

    if (root) {
      const specific = findGenderOption(root, labels) || findButtonLike(labels, root);
      if (specific) {
        clickElement(specific);
        specific.focus?.();
        if (specific.matches?.('[role="radio"]')) {
          [' ', 'Enter'].forEach((key) => dispatchKeyboardStep(specific, key, 1));
        }
        const selectionState = readGenderSelectionState(root, gender);
        const message = selectionState === 'selected'
          ? `ボーカル性別UIで ${gender} を選択`
          : `ボーカル性別UIで ${gender} の選択を試行（UI上の確定表示は未検出）`;
        return { mode: 'ui', ok: selectionState === 'selected', message };
      }

      const combo = root.querySelector('[role="combobox"], select');
      if (combo instanceof HTMLSelectElement) {
        const option = Array.from(combo.options).find((opt) => labels.some((label) => normalizeText(opt.textContent).toLowerCase().includes(label)));
        if (option) {
          combo.value = option.value;
          combo.dispatchEvent(new Event('change', { bubbles: true }));
          return { mode: 'ui', ok: true, message: `ボーカル性別selectで ${gender} を選択` };
        }
      } else if (combo) {
        clickElement(combo);
        const option = findGenderOption(document.body, labels) || findButtonLike(labels);
        if (option) {
          clickElement(option);
          return { mode: 'ui', ok: true, message: `ボーカル性別dropdownで ${gender} を選択` };
        }
      }
    }

    return { mode: 'fallback', ok: false, message: 'ボーカル性別の専用UI未検出' };
  }

  function updateStatus(lines, isError = false) {
    const box = document.getElementById(STATUS_ID);
    if (!box) return;
    state.lastStatus = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
    box.textContent = state.lastStatus;
    box.style.color = isError ? '#ffd4d4' : '#d8f3dc';
    box.style.borderColor = isError ? 'rgba(255,120,120,0.6)' : 'rgba(160,255,180,0.4)';
  }

  async function copyDiagnostics() {
    const lines = [];
    const stylesHeading = findHeadingElement(['styles']);
    const moreOptionsHeading = findHeadingElement(['more options', 'advanced options', '詳細', '詳細設定']);
    const stylesSection = findSectionContainerByHeading(['styles']);
    const moreOptionsSection = findSectionContainerByHeading(['more options', 'advanced options', '詳細', '詳細設定']);
    const genderRow = moreOptionsSection ? findRowContainerInRoot(['vocal gender', 'voice gender', 'gender'], moreOptionsSection) : null;
    const weirdnessRow = moreOptionsSection ? findRowContainerInRoot(['weirdness'], moreOptionsSection) : null;
    const styleInfluenceRow = moreOptionsSection ? findRowContainerInRoot(['style influence'], moreOptionsSection) : null;
    const weirdnessTrack = weirdnessRow ? findSliderTrackInRow(weirdnessRow) : null;
    const styleInfluenceTrack = styleInfluenceRow ? findSliderTrackInRow(styleInfluenceRow) : null;

    lines.push(`activeElement: ${describeElement(document.activeElement)}`);
    lines.push(`stylesHeading: ${describeElement(stylesHeading)}`);
    lines.push(`moreOptionsHeading: ${describeElement(moreOptionsHeading)}`);
    lines.push(`stylesSection: ${describeElement(stylesSection)}`);
    lines.push(`moreOptionsSection: ${describeElement(moreOptionsSection)}`);
    lines.push(`genderRow: ${describeElement(genderRow)}`);
    lines.push(`weirdnessRow: ${describeElement(weirdnessRow)}`);
    lines.push(`styleInfluenceRow: ${describeElement(styleInfluenceRow)}`);
    lines.push(`weirdnessTrack: ${describeElement(weirdnessTrack)}`);
    lines.push(`styleInfluenceTrack: ${describeElement(styleInfluenceTrack)}`);
    if (genderRow) lines.push(`genderRowText: ${normalizeText(genderRow.textContent || '').slice(0, 200)}`);
    if (genderRow) lines.push(`genderSelected: ${readGenderSelectionState(genderRow, 'male') === 'selected' ? 'male' : readGenderSelectionState(genderRow, 'female') === 'selected' ? 'female' : 'unknown'}`);
    if (weirdnessRow) lines.push(`weirdnessRowText: ${normalizeText(weirdnessRow.textContent || '').slice(0, 200)}`);
    if (styleInfluenceRow) lines.push(`styleInfluenceRowText: ${normalizeText(styleInfluenceRow.textContent || '').slice(0, 200)}`);
    if (weirdnessRow) lines.push(`weirdnessPercent: ${extractPercentFromText(weirdnessRow.textContent || '')}`);
    if (styleInfluenceRow) lines.push(`styleInfluencePercent: ${extractPercentFromText(styleInfluenceRow.textContent || '')}`);
    if (weirdnessRow) lines.push(`weirdnessCandidates: ${getCandidateFields(weirdnessRow).length}`);
    if (styleInfluenceRow) lines.push(`styleInfluenceCandidates: ${getCandidateFields(styleInfluenceRow).length}`);
    lines.push(`stylesVisible: ${Boolean(stylesSection && isVisible(stylesSection))}`);
    lines.push(`moreOptionsVisible: ${Boolean(moreOptionsSection && isVisible(moreOptionsSection))}`);
    if (stylesSection) lines.push(`stylesText: ${normalizeText(stylesSection.textContent || '').slice(0, 400)}`);
    if (moreOptionsSection) lines.push(`moreOptionsText: ${normalizeText(moreOptionsSection.textContent || '').slice(0, 400)}`);

    const payload = lines.join('\n');
    try {
      await navigator.clipboard.writeText(payload);
      updateStatus(['診断情報をクリップボードへコピーしました。', ...lines], false);
    } catch (error) {
      log('copyDiagnostics failed', error);
      updateStatus(['診断情報のコピーに失敗しました。', ...lines], true);
    }
  }

  function parseFromPanel() {
    const textarea = document.getElementById(INPUT_ID);
    const parsed = parsePrompt(textarea?.value || '');
    state.parsed = parsed;

    const lines = ['読み取り完了'];
    Object.entries(parsed.data).forEach(([key, value]) => {
      lines.push(`${key}: ${value ? 'OK' : '空欄'}`);
    });
    parsed.warnings.forEach((w) => lines.push(`警告: ${w}`));
    updateStatus(lines, false);
    return parsed;
  }

  async function fillFields(parsed, doGenerate) {
    const data = parsed?.data || state.parsed?.data;
    if (!data) {
      updateStatus('先に「読み取り」を実行してください。', true);
      return;
    }

    const status = [];
    const applied = [];
    const missing = [];
    let finalStyles = data.styles || '';

    try {
      const advancedVisibleAtStart = ensureMoreOptionsVisible(data);
      if (needsMoreOptions(data) && !advancedVisibleAtStart) {
        status.push('警告: More Options（詳細設定）は自動展開せず、開いている項目のみ入力します。必要なら手動で開いて再実行してください。');
      }

      if (data.voiceGender) {
        if (advancedVisibleAtStart) {
          const genderResult = chooseGenderInUi(data.voiceGender);
          status.push(genderResult.message);
        }
        if (hasInstrumentalStyle(finalStyles)) {
          status.push('警告: Styles に instrumental が含まれるため、ボーカル性別補完と矛盾する可能性があります。');
        }
        const beforeStyles = finalStyles;
        finalStyles = appendGenderToStyles(finalStyles, data.voiceGender);
        if (finalStyles !== beforeStyles) {
          status.push(`ボーカル性別をStylesへ保険補完: ${finalStyles || '(空)'}`);
        }
      } else if (parsed?.warnings?.includes('性別未認識')) {
        status.push('警告: 性別未認識');
      }

      const fieldPlan = [
        ['title', data.title],
        ['lyrics', data.lyrics],
        ['styles', finalStyles],
        ['excludeStyles', data.excludeStyles],
        ['weirdness', data.weirdness],
        ['styleInfluence', data.styleInfluence]
      ];

      for (const [key, value] of fieldPlan) {
        if (!value) {
          missing.push(`${key}(入力値なし)`);
          continue;
        }

        const isAdvancedField = ['excludeStyles', 'weirdness', 'styleInfluence'].includes(key);
        let field = findBestField(key);

        if (!field && isAdvancedField && !hasVisibleAdvancedFields()) {
          missing.push(`${key}(More Options／詳細設定を手動で開いて再実行)`);
          continue;
        }

        if (!field) {
          missing.push(`${key}(UI未検出)`);
          continue;
        }

        let ok;
        if (key === 'weirdness' || key === 'styleInfluence') {
          ok = setSliderLike(field, value) || setElementValue(field, value);
          if (ok) await sleep(180);
          if (!ok && field instanceof HTMLElement) {
            status.push(`${key}警告: スライダー行は見つかりましたが、Suno の見た目上のスライダーが自動操作に反応しませんでした。手動調整が必要です。`);
          }
        } else {
          ok = setElementValue(field, value);
          if (!ok && (key === 'styles' || key === 'excludeStyles')) {
            const forced = forcePasteIntoSurface(field, value);
            ok = forced.ok;
            status.push(`${key}診断: ${forced.detail}`);
          }
        }

        if (ok && !valueLooksApplied(key, field, value)) {
          ok = false;
          status.push(`${key}検証失敗: expected=${value} actual=${readFieldValue(key, field) || '(空)'}`);
        }

        if (ok) applied.push(key);
        else missing.push(`${key}(セット失敗)`);
      }

      status.push(`入力成功: ${applied.join(', ') || 'なし'}`);
      if (missing.length) status.push(`未入力/未検出: ${missing.join(', ')}`);

      if (doGenerate) {
        const button = findGenerateButton() || findButtonLike(GENERATE_LABELS);
        if (button && !isDisabledButton(button)) {
          triggerActionButton(button);
          status.push(`生成ボタンを実行: ${getActionLabels(button).slice(0, 80) || describeElement(button)}`);
        } else if (button) {
          status.push('警告: 生成ボタン候補は見つかりましたが、無効状態でした。');
        } else {
          status.push('警告: 生成ボタン未検出');
        }
      } else {
        status.push('安全モード: 入力のみ実行');
      }

      updateStatus(status, false);
    } catch (error) {
      log('fillFields error', error);
      updateStatus([`エラー: ${error?.message || error}`], true);
    }
  }

  function createButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      background: '#111827',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '8px',
      padding: '8px 10px',
      cursor: 'pointer',
      fontSize: '12px',
      fontWeight: '600'
    });
    button.addEventListener('click', onClick);
    return button;
  }

  function makePanelDraggable(panel, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('mousedown', (event) => {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      event.preventDefault();
    });

    document.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      const x = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, event.clientX - offsetX));
      const y = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, event.clientY - offsetY));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      top: '20px',
      right: '20px',
      width: '340px',
      zIndex: '2147483647',
      background: 'rgba(17,24,39,0.96)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.18)',
      borderRadius: '12px',
      boxShadow: '0 12px 30px rgba(0,0,0,0.35)',
      padding: '10px',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    });

    const savedPos = localStorage.getItem(STORAGE_KEY);
    if (savedPos) {
      try {
        const parsed = JSON.parse(savedPos);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          panel.style.left = `${parsed.x}px`;
          panel.style.top = `${parsed.y}px`;
          panel.style.right = 'auto';
        }
      } catch (error) {
        log('failed to restore panel position', error);
      }
    }

    const header = document.createElement('div');
    header.textContent = 'Suno 自動入力';
    Object.assign(header.style, {
      cursor: 'move',
      fontWeight: '700',
      marginBottom: '8px',
      userSelect: 'none'
    });

    const textarea = document.createElement('textarea');
    textarea.id = INPUT_ID;
    textarea.placeholder = 'ここに ChatGPT の Suno 用プロンプトを貼り付け';
    Object.assign(textarea.style, {
      width: '100%',
      minHeight: '150px',
      resize: 'vertical',
      borderRadius: '8px',
      border: '1px solid rgba(255,255,255,0.18)',
      padding: '8px',
      background: 'rgba(255,255,255,0.07)',
      color: '#fff',
      boxSizing: 'border-box',
      fontSize: '12px'
    });

    const buttonRow = document.createElement('div');
    Object.assign(buttonRow.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: '8px',
      marginTop: '8px'
    });

    buttonRow.append(
      createButton('読み取り', () => parseFromPanel()),
      createButton('入力のみ', async () => {
        const parsed = parseFromPanel();
        await fillFields(parsed, false);
      }),
      createButton('入力して生成', async () => {
        const parsed = parseFromPanel();
        await fillFields(parsed, true);
      }),
      createButton('診断コピー', async () => {
        await copyDiagnostics();
      })
    );

    const status = document.createElement('pre');
    status.id = STATUS_ID;
    status.textContent = '待機中';
    Object.assign(status.style, {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      margin: '8px 0 0',
      padding: '8px',
      minHeight: '84px',
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(160,255,180,0.3)',
      borderRadius: '8px',
      fontSize: '11px',
      lineHeight: '1.45'
    });

    panel.append(header, textarea, buttonRow, status);
    document.body.appendChild(panel);
    makePanelDraggable(panel, header);
  }

  function isCreateLikePage() {
    const text = normalizedNodeText(document.body);
    return /custom|lyrics|styles|create|generate/i.test(text);
  }

  function ensurePanel() {
    if (!document.body) return;
    if (document.getElementById(PANEL_ID)) return;
    if (isCreateLikePage()) buildPanel();
  }

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => ensurePanel());
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function init() {
    try {
      ensurePanel();
      startObserver();
      window.setInterval(ensurePanel, POLL_INTERVAL_MS);
      log('initialized');
    } catch (error) {
      log('init error', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
