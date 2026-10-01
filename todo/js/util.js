import { generateKeyBetween, generateNKeysBetween } from '../vendor/fractional-indexing.js';

export { generateKeyBetween, generateNKeysBetween };

export const uuid = () => crypto.randomUUID();

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const bySortKey = (a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0);

export function isTouch() {
  return matchMedia('(pointer: coarse)').matches;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export function modKey(e) {
  return isMac ? e.metaKey : e.ctrlKey;
}

// plaintext-only がない古いブラウザでは通常の contenteditable にする
let plaintextOnly;
export function makeEditable(el) {
  if (plaintextOnly === undefined) {
    try { document.createElement('div').contentEditable = 'plaintext-only'; plaintextOnly = true; }
    catch { plaintextOnly = false; }
  }
  el.contentEditable = plaintextOnly ? 'plaintext-only' : 'true';
  el.spellcheck = false;
  return el;
}

export function toast(msg, ms = 3000) {
  let box = document.getElementById('toast');
  if (!box) { box = h('div', { id: 'toast' }); document.body.append(box); }
  box.textContent = msg;
  box.classList.add('show');
  clearTimeout(box._t);
  box._t = setTimeout(() => box.classList.remove('show'), ms);
}

export function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// 選択肢から1つ選ぶ小さなダイアログ。キャンセル時は null
export function choose(title, options) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(null); } },
      h('div', { class: 'modal' },
        h('div', { class: 'modal-title', text: title }),
        h('div', { class: 'modal-list' },
          options.map((o) => h('button', { class: 'modal-item', onclick: () => close(o.value) },
            h('span', { style: `padding-left:${(o.depth || 0) * 16}px`, text: o.label })))),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close(null), text: 'キャンセル' }))));
    document.body.append(overlay);
  });
}

// 項目メニュー(長押し・右クリック)
export function popupMenu(x, y, items) {
  document.querySelector('.popup-menu')?.remove();
  const menu = h('div', { class: 'popup-menu' },
    items.map((it) => h('button', {
      class: 'popup-item' + (it.danger ? ' danger' : ''),
      onclick: () => { menu.remove(); it.action(); },
      text: it.label,
    })));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (!Number.isFinite(x) || !Number.isFinite(y)) { x = (innerWidth - r.width) / 2; y = (innerHeight - r.height) / 2; }
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  const off = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', off, true); }
  };
  setTimeout(() => document.addEventListener('pointerdown', off, true));
}
