// ==UserScript==
// @name         Suno：プレイリスト一括ダウンロード（MP3）
// @namespace    http://tampermonkey.net/
// @version      1.4.1
// @description  プレイリスト画面でMP3を一括DL。ファイル名は曲名（重複は(2)(3)…）。完了後、YouTube用タイムスタンプリスト(txt)＋Repeat開始時間を出力。UIはドラッグ移動可（位置保存）。
// @match        *://suno.com/*
// @match        *://*.suno.com/*
// @match        *://suno.ai/*
// @match        *://*.suno.ai/*
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'suno-bulk-mp3-panel';
  const POS_KEY = 'suno_bulk_panel_pos_v1';
  const DEFAULT_DELAY_MS = 2000; // 安定優先：2秒固定
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function isPlaylistPage() {
    return location.pathname.startsWith('/playlist/');
  }

  function removePanel() {
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove();
  }

  function sanitizeFilename(name) {
    return (name || '')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  function getPlaylistTitle() {
    const h1 = document.querySelector('h1');
    const t1 = h1 ? (h1.textContent || '').trim() : '';
    if (t1) return t1;

    const og = document.querySelector('meta[property="og:title"]');
    const t2 = og ? (og.getAttribute('content') || '').trim() : '';
    if (t2) return t2;

    return (document.title || 'Suno Playlist').trim();
  }

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function formatTime(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;

    if (h > 0) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  function buildYoutubeTimestampText(entries) {
    const lines = [];
    lines.push('Track list:');

    let t = 0;
    let unknown = false;

    for (const e of entries) {
      if (!e.ok) continue;
      const timeStr = unknown ? '??:??' : formatTime(t);
      lines.push(`${timeStr} ${e.title}`);

      if (!unknown && typeof e.durationSec === 'number' && isFinite(e.durationSec) && e.durationSec > 0) {
        t += e.durationSec;
      } else {
        unknown = true;
      }
    }

    const repeatStr = unknown ? '??:??' : formatTime(t);
    lines.push(`${repeatStr} Repeat`);

    return lines.join('\n');
  }

  // ---------- 再生時間取得 ----------
  function fetchArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onload: (res) => {
          if (res.status >= 200 && res.status < 300 && res.response) resolve(res.response);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
        timeout: 60_000,
      });
    });
  }

  async function getMp3DurationSeconds(mp3Url) {
    try {
      const ab = await fetchArrayBuffer(mp3Url);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;

      const ctx = new AudioCtx();
      const audioBuffer = await ctx.decodeAudioData(ab.slice(0));
      await ctx.close();

      const sec = Math.round(audioBuffer.duration);
      return (sec > 0 ? sec : null);
    } catch {
      return null;
    }
  }

  // ---------- NextData ----------
  function tryGetNextDataJson() {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      return JSON.parse(el.textContent || 'null');
    } catch {
      return null;
    }
  }

  function collectFromNextData() {
    const data = tryGetNextDataJson();
    if (!data) return [];

    const results = [];
    const seen = new Set();

    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;

      const id = obj.clip_id || obj.clipId || obj.id || obj.clipID;
      const title = obj.title || obj.name || obj.song_title || obj.songTitle;
      const url =
        obj.audio_url || obj.audioUrl || obj.audioURL ||
        obj.mp3_url || obj.mp3Url || obj.mp3URL ||
        obj.url || obj.src;

      if (id && url && typeof url === 'string' && /\.mp3(\?|$)/i.test(url)) {
        const key = String(id);
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            clipId: key,
            title: sanitizeFilename(String(title || `suno_${key}`)),
            mp3Url: url
          });
        }
      }

      for (const k of Object.keys(obj)) walk(obj[k]);
    }

    walk(data);
    return results;
  }

  // ---------- DOM保険 ----------
  function getSongRows() {
    const a = Array.from(document.querySelectorAll('[data-testid="song-row"]'));
    if (a.length) return a;

    const b = Array.from(document.querySelectorAll('[role="row"]'));
    return b.filter(row => row.querySelector('button[aria-haspopup="menu"], button[aria-expanded]'));
  }

  function extractTrackFromRow(row) {
    const clipId =
      row.getAttribute('data-clip-id') ||
      row.getAttribute('data-id') ||
      row.dataset?.clipId ||
      null;

    let title = '';
    const titleEl =
      row.querySelector('[data-testid="song-title"]') ||
      row.querySelector('a[href*="/song/"]') ||
      row.querySelector('a[href*="/track/"]') ||
      row.querySelector('.line-clamp-1') ||
      row.querySelector('span,div,p');

    if (titleEl) title = (titleEl.textContent || '').trim();
    title = sanitizeFilename(title) || (clipId ? `suno_${clipId}` : 'suno_track');

    let mp3Url = '';
    const html = row.innerHTML || '';
    const m = html.match(/https:\/\/cdn1\.suno\.ai\/[a-zA-Z0-9_-]+\.mp3(\?[^"' ]*)?/);
    if (m && m[0]) mp3Url = m[0];

    if (!mp3Url && clipId) mp3Url = `https://cdn1.suno.ai/${clipId}.mp3`;

    return (clipId && mp3Url) ? { clipId: String(clipId), title, mp3Url } : null;
  }

  async function autoScrollAndCollectDom() {
    const seen = new Map();
    let stable = 0;
    let lastCount = -1;

    while (stable < 3) {
      if (!isPlaylistPage()) break;

      const rows = getSongRows();
      for (const r of rows) {
        const t = extractTrackFromRow(r);
        if (t && !seen.has(t.clipId)) seen.set(t.clipId, t);
      }

      const count = rows.length;
      if (count === lastCount) stable++;
      else stable = 0;
      lastCount = count;

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);
    }

    return Array.from(seen.values());
  }

  // ---------- DL ----------
  function gmDownload(url, filename) {
    return new Promise((resolve) => {
      GM_download({
        url,
        name: filename,
        saveAs: false,
        onload: () => resolve({ ok: true }),
        onerror: () => resolve({ ok: false }),
        ontimeout: () => resolve({ ok: false }),
      });
    });
  }

  async function downloadAll(setStatus, stopRef, startBtn) {
    if (!isPlaylistPage()) {
      setStatus('プレイリスト画面で実行してください。');
      return;
    }

    setStatus('曲情報を取得中…');

    let tracks = collectFromNextData();

    if (!tracks.length) {
      setStatus('曲情報を取得中…（自動スクロール）');
      tracks = await autoScrollAndCollectDom();
    }

    if (!tracks.length) {
      setStatus('曲が見つかりませんでした（Suno側UI変更の可能性）。');
      return;
    }

    setStatus(`取得：${tracks.length}曲。ダウンロード開始…`);

    let okCount = 0;
    let ngCount = 0;

    const used = new Map();
    const entries = [];

    for (let i = 0; i < tracks.length; i++) {
      if (stopRef.stop) break;
      if (!isPlaylistPage()) break;

      const t = tracks[i];
      const base = sanitizeFilename(t.title) || `suno_track_${i + 1}`;
      const n = (used.get(base) || 0) + 1;
      used.set(base, n);

      const titleForList = (n === 1 ? base : `${base} (${n})`);
      const filename = `${titleForList}.mp3`;

      setStatus(`(${i + 1}/${tracks.length}) 保存中…\n${filename}`);

      const durationSec = await getMp3DurationSeconds(t.mp3Url);
      const res = await gmDownload(t.mp3Url, filename);

      if (res.ok) okCount++;
      else ngCount++;

      entries.push({ title: titleForList, ok: res.ok, durationSec });

      await sleep(DEFAULT_DELAY_MS);
    }

    const doneText = stopRef.stop
      ? `停止しました。\n成功:${okCount} 失敗:${ngCount}`
      : `完了しました。\n成功:${okCount} 失敗:${ngCount}`;

    setStatus(doneText);

    try {
      const playlistTitle = sanitizeFilename(getPlaylistTitle());
      const txt = buildYoutubeTimestampText(entries);

      const d = new Date();
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const stamp = `${y}${mo}${da}-${hh}${mm}${ss}`;

      const safeTitle = sanitizeFilename(playlistTitle).slice(0, 60) || 'playlist';
      const txtName = `youtube_timestamps_${safeTitle}_${stamp}.txt`;

      downloadTextFile(txtName, txt);
      setStatus(doneText);
    } catch {
      setStatus(doneText);
    }

    if (startBtn) startBtn.classList.add('sbPulse');
  }

  // ---------- 位置保存 ----------
  function loadPanelPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.left !== 'number' || typeof obj.top !== 'number') return null;
      return obj;
    } catch {
      return null;
    }
  }

  function savePanelPos(left, top) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
    } catch {}
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    const onDown = (ev) => {
      dragging = true;

      const rect = panel.getBoundingClientRect();
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;

      startX = ev.clientX;
      startY = ev.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    };

    const onMove = (ev) => {
      if (!dragging) return;

      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      const rect = panel.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      const maxLeft = window.innerWidth - w;
      const maxTop = window.innerHeight - h;

      const left = clamp(startLeft + dx, 0, maxLeft);
      const top = clamp(startTop + dy, 0, maxTop);

      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;

      try { handle.releasePointerCapture(ev.pointerId); } catch {}

      const rect = panel.getBoundingClientRect();
      savePanelPos(rect.left, rect.top);
    };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  // ---------- UI ----------
  function injectPanel() {
    if (!isPlaylistPage()) return;
    if (document.getElementById(PANEL_ID)) return;
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position:fixed; left:0px; bottom:250px; right:auto; top:auto; z-index:2147483647;
      background:rgba(20,20,20,.94); color:#fff; padding:14px;
      border-radius:14px; font:14px/1.45 sans-serif;
      width:190px;
      box-shadow:0 10px 26px rgba(0,0,0,.40);
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes sbPulseAnim {
        0%   { box-shadow: 0 0 0 0 rgba(255,255,255,.55); transform: translateY(0); }
        70%  { box-shadow: 0 0 0 10px rgba(255,255,255,0); transform: translateY(-1px); }
        100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); transform: translateY(0); }
      }
      #${PANEL_ID} .sbPulse { animation: sbPulseAnim 1.2s infinite; }
      #${PANEL_ID} button { user-select:none; }
      #${PANEL_ID} #sbHandle {
        cursor: move;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
      }
    `;
    document.head.appendChild(style);

    panel.innerHTML = `
      <div id="sbHandle" style="font-weight:800; font-size:15px; margin-bottom:10px;">
        一括ダウンロード
      </div>

      <div style="display:flex; gap:8px; margin-bottom:10px; align-items:center;">
        <button id="sbStart"
          class="sbPulse"
          style="width:85px; padding:12px 8px; border:0; border-radius:12px; cursor:pointer;
                 font-weight:800; font-size:15px;">
          開始
        </button>

        <button id="sbStop"
          style="width:65px; padding:12px 8px; border:0; border-radius:12px; cursor:pointer;
                 font-weight:700; font-size:14px; opacity:.9;">
          停止
        </button>
      </div>

      <div id="sbStatus" style="white-space:pre-wrap; opacity:.95; padding:10px; border-radius:12px; background:rgba(0,0,0,.25);">
        &nbsp;
      </div>
    `;

    document.body.appendChild(panel);

    const pos = loadPanelPos();
    if (pos) {
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${pos.left}px`;
      panel.style.top = `${pos.top}px`;
    }

    const handle = panel.querySelector('#sbHandle');
    makeDraggable(panel, handle);

    const stopRef = { stop: false };
    const setStatus = (t) => {
      const el = panel.querySelector('#sbStatus');
      if (!t) el.innerHTML = '&nbsp;';
      else el.textContent = t;
    };

    const startBtn = panel.querySelector('#sbStart');
    const stopBtn = panel.querySelector('#sbStop');

    startBtn.addEventListener('click', async () => {
      stopRef.stop = false;
      startBtn.classList.remove('sbPulse');
      setStatus('開始しました…');
      await downloadAll(setStatus, stopRef, startBtn);
    });

    stopBtn.addEventListener('click', () => {
      stopRef.stop = true;
      setStatus('停止要求を受け付けました。');
      startBtn.classList.add('sbPulse');
    });
  }

  function onRouteChange() {
    if (isPlaylistPage()) injectPanel();
    else removePanel();
  }

  function hookHistory() {
    const _push = history.pushState;
    const _replace = history.replaceState;

    history.pushState = function () {
      const r = _push.apply(this, arguments);
      window.dispatchEvent(new Event('tm-route'));
      return r;
    };
    history.replaceState = function () {
      const r = _replace.apply(this, arguments);
      window.dispatchEvent(new Event('tm-route'));
      return r;
    };

    window.addEventListener('popstate', () => window.dispatchEvent(new Event('tm-route')));
    window.addEventListener('tm-route', onRouteChange);
  }

  (async () => {
    for (let i = 0; i < 80; i++) {
      if (document.body) break;
      await sleep(100);
    }

    hookHistory();
    onRouteChange();

    let last = location.pathname;
    setInterval(() => {
      if (location.pathname !== last) {
        last = location.pathname;
        onRouteChange();
      }
    }, 600);
  })();
})();
