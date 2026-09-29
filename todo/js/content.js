// 本文の表示(添付チップ・リンク)と、編集中DOMから本文文字列への変換、キャレット位置の扱い。
// 位置はすべて「本文文字列上の文字数」で表す。添付チップ1つは {{att:ID}} の文字数ぶんと数える。
import { h } from './util.js';
import { makeChip } from './attachments.js';

export const ATT_RE = /\{\{att:([0-9a-f-]{36})\}\}/g;
const URL_RE = /https?:\/\/[^\s<>"'「」、。)）]+/g;
export const marker = (id) => `{{att:${id}}}`;

export function attIds(text) {
  return [...text.matchAll(ATT_RE)].map((m) => m[1]);
}

// 本文文字列を el の中身として描画する
export function renderInto(el, text) {
  el.textContent = '';
  let last = 0;
  for (const m of text.matchAll(ATT_RE)) {
    appendText(el, text.slice(last, m.index));
    el.append(makeChip(m[1]));
    last = m.index + m[0].length;
  }
  appendText(el, text.slice(last));
}

function appendText(el, s) {
  if (!s) return;
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    if (m.index > last) el.append(document.createTextNode(s.slice(last, m.index)));
    el.append(h('a', { class: 'link', href: m[0], target: '_blank', rel: 'noopener', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < s.length) el.append(document.createTextNode(s.slice(last)));
}

const isChip = (n) => n.nodeType === 1 && n.classList.contains('att');
const isBlock = (n) => n.nodeType === 1 && (n.tagName === 'DIV' || n.tagName === 'P');

// 編集中の DOM を本文文字列に戻す
export function serialize(el, { multiline = false } = {}) {
  let out = '';
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) out += c.data;
      else if (isChip(c)) out += marker(c.dataset.att);
      else if (c.tagName === 'BR') out += multiline ? '\n' : '';
      else {
        if (multiline && isBlock(c) && out && !out.endsWith('\n')) out += '\n';
        walk(c);
      }
    }
  };
  walk(el);
  if (!multiline) out = out.replace(/\n/g, ' ');
  else if (out.endsWith('\n') && el.lastChild?.tagName === 'BR') out = out.slice(0, -1);
  return out;
}

// DOM 上の (container, offset) を本文文字列上の位置に変換
function domToOffset(el, container, offset) {
  let pos = 0;
  let found = null;
  const walk = (node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      if (found !== null) return;
      if (node === container && i === offset) { found = pos; return; }
      const c = node.childNodes[i];
      if (c === container && c.nodeType === 3) { found = pos + offset; return; }
      if (c.nodeType === 3) pos += c.data.length;
      else if (isChip(c)) pos += marker(c.dataset.att).length;
      else if (c.tagName === 'BR') pos += 0;
      else walk(c);
    }
    if (found === null && node === container) found = pos;
  };
  walk(el);
  return found ?? pos;
}

export function getCaret(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  return {
    start: domToOffset(el, r.startContainer, r.startOffset),
    end: domToOffset(el, r.endContainer, r.endOffset),
  };
}

export function setCaret(el, pos) {
  const range = document.createRange();
  let remaining = pos;
  let done = false;
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (done) return;
      if (c.nodeType === 3) {
        if (remaining <= c.data.length) { range.setStart(c, remaining); done = true; return; }
        remaining -= c.data.length;
      } else if (isChip(c)) {
        const len = marker(c.dataset.att).length;
        if (remaining === 0) { range.setStartBefore(c); done = true; return; }
        remaining -= len;
        if (remaining <= 0) { range.setStartAfter(c); done = true; return; }
      } else if (c.tagName !== 'BR') walk(c);
    }
  };
  walk(el);
  if (!done) { range.selectNodeContents(el); range.collapse(false); }
  range.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

export function focusAt(el, pos) {
  el.focus({ preventScroll: true });
  setCaret(el, pos ?? Infinity);
  const r = el.getBoundingClientRect();
  if (r.top < 60 || r.bottom > (visualViewport?.height ?? innerHeight) - 60) {
    el.scrollIntoView({ block: 'nearest' });
  }
}

// キャレットがその欄の1行目 / 最終行にあるか
export function caretOnEdgeLine(el, dir) {
  const sel = getSelection();
  if (!sel.rangeCount) return true;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  let rect = r.getClientRects()[0];
  if (!rect) return true;
  const box = el.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return dir < 0 ? rect.top - box.top < lh * 0.8 : box.bottom - rect.bottom < lh * 0.8;
}

export function caretX() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  return r.getClientRects()[0]?.left ?? null;
}

// 画面上の x 座標に近い位置へキャレットを置く(上下移動用)
export function focusAtX(el, x, dir) {
  const box = el.getBoundingClientRect();
  const y = dir < 0 ? box.bottom - 4 : box.top + 4;
  el.focus({ preventScroll: true });
  let range = null;
  if (x != null) {
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
    }
  }
  if (range && el.contains(range.startContainer)) {
    const sel = getSelection();
    sel.removeAllRanges();
    range.collapse(true);
    sel.addRange(range);
  } else {
    setCaret(el, dir < 0 ? Infinity : 0);
  }
  el.scrollIntoView({ block: 'nearest' });
}

// キャレット位置に文字列(添付マーカーを含んでよい)を挿入し、挿入後の位置を返す
export function insertAtCaret(el, text, { multiline = false } = {}) {
  const c = getCaret(el) ?? { start: serialize(el, { multiline }).length, end: 0 };
  const cur = serialize(el, { multiline });
  const end = Math.max(c.start, c.end);
  const next = cur.slice(0, c.start) + text + cur.slice(end);
  renderInto(el, next);
  const pos = c.start + text.length;
  setCaret(el, pos);
  return next;
}
