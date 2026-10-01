// アウトライン編集画面(1ドキュメント分のモデル・描画・操作・保存)
import {
  h, uuid, debounce, bySortKey, modKey, makeEditable, toast, popupMenu, choose, isTouch,
  generateKeyBetween, generateNKeysBetween,
} from './util.js';
import {
  renderInto, serialize, getCaret, setCaret, focusAt, focusAtX, caretOnEdgeLine, caretX,
  attIds, marker, ATT_RE, MD_LINK_RE, hasMdLink,
} from './content.js';
import { parseClipboard } from './paste.js';
import { ensureLoaded, startUpload, handleChipClick } from './attachments.js';

const SNAP_FIELDS = ['document_id', 'parent_id', 'sort_key', 'content', 'note', 'checkbox', 'checked', 'collapsed', 'deleted_at'];
const ROOT = '__root__';

let api;
let library;
let ui; // { page, title, titleNote, outline, crumbs, onStatus, onZoom, onTitleChange }

let doc = null;
let nodes = new Map();
let kids = new Map();
let zoomId = null;
const els = new Map();

const dirty = new Set();
let history = [];
let future = [];
let tx = null;
let textSession = null;
let lastFocus = null;
let pointerWasFocused = false;
let lastCompositionEnd = 0;

// ============================================================ 初期化

export function initOutline(opts) {
  ({ api, library, ...ui } = opts);
  const { outline, title, titleNote } = ui;
  makeEditable(title);
  makeEditable(titleNote);

  for (const el of [outline, title, titleNote]) {
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('input', onInput);
    el.addEventListener('paste', onPaste);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('compositionend', () => { lastCompositionEnd = Date.now(); });
    el.addEventListener('pointerdown', (e) => {
      const field = e.target.closest?.('.content, .note, .title, .title-note');
      pointerWasFocused = !!field && document.activeElement === field;
    });
    el.addEventListener('click', onClick);
  }
  outline.addEventListener('contextmenu', onContextMenu);
  setupLongPress(outline);
  setupDragDrop();
  document.addEventListener('selectionchange', () => {
    const f = currentFocus();
    if (f) lastFocus = f;
  });
  document.addEventListener('keydown', (e) => {
    // どこにもフォーカスがなくても Undo/Redo は効かせる
    if (!doc || e.defaultPrevented) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (modKey(e) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  });
  addEventListener('beforeunload', (e) => {
    if (dirty.size) { flush(); e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

// ============================================================ モデル

const key = (parentId) => parentId ?? ROOT;
const childrenOf = (id) => kids.get(key(id)) || [];

function reindex() {
  kids = new Map();
  for (const n of nodes.values()) {
    if (n.deleted_at || n.document_id !== doc.id) continue;
    const k = key(n.parent_id);
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(n);
  }
  for (const list of kids.values()) list.sort(bySortKey);
}

const isHidden = (n) => n.checked && !doc.show_checked;
const visibleChildren = (id) => childrenOf(id).filter((n) => !isHidden(n));

function snap(n) {
  return Object.fromEntries(SNAP_FIELDS.map((f) => [f, n[f]]));
}

function ancestors(id) {
  const out = [];
  let n = nodes.get(id);
  while (n && n.parent_id) {
    n = nodes.get(n.parent_id);
    if (!n) break;
    out.unshift(n);
  }
  return out;
}

function isInside(id, ancestorId) {
  for (let n = nodes.get(id); n; n = nodes.get(n.parent_id)) if (n.id === ancestorId) return true;
  return false;
}

function subtree(id) {
  const out = [nodes.get(id)];
  for (let i = 0; i < out.length; i++) out.push(...childrenOf(out[i].id));
  return out;
}

// 兄弟の index 番目(exclude を除いて数える)に入るための sort_key
function slotKey(parentId, index, excludeId) {
  const sibs = childrenOf(parentId).filter((s) => s.id !== excludeId);
  const a = sibs[index - 1]?.sort_key ?? null;
  const b = sibs[index]?.sort_key ?? null;
  try {
    return generateKeyBetween(a, b);
  } catch {
    // 同じキーが並んだ等で間が作れないときは、兄弟のキーを振り直す
    const keys = generateNKeysBetween(null, null, sibs.length);
    sibs.forEach((s, i) => set(s.id, { sort_key: keys[i] }));
    return generateKeyBetween(keys[index - 1] ?? null, keys[index] ?? null);
  }
}

const idxEx = (n, excludeId) => childrenOf(n.parent_id).filter((s) => s.id !== excludeId).indexOf(n);

// ============================================================ 変更の記録(Undo)と保存

function set(id, fields) {
  const n = nodes.get(id);
  if (tx && !tx.changes.has(id)) tx.changes.set(id, snap(n));
  Object.assign(n, fields);
  markDirty(id);
}

function create(fields) {
  const n = {
    id: uuid(), document_id: doc.id, parent_id: null, sort_key: 'a0', content: '', note: '',
    checkbox: false, checked: false, collapsed: false, deleted_at: null, ...fields,
  };
  nodes.set(n.id, n);
  if (tx) tx.changes.set(n.id, null);
  markDirty(n.id);
  return n;
}

function begin() {
  commitText();
  tx = { changes: new Map(), focusBefore: currentFocus() };
}

function commit(focusAfter) {
  if (!tx) return;
  const changes = [...tx.changes].map(([id, before]) => ({ id, before, after: snap(nodes.get(id)) }));
  if (changes.length) {
    history.push({ changes, focusBefore: tx.focusBefore, focusAfter });
    if (history.length > 300) history.shift();
    future = [];
  }
  tx = null;
}

const commitTextSoon = debounce(() => commitText(), 1500);

function commitText() {
  commitTextSoon.cancel();
  if (!textSession) return;
  const { id, before, focus } = textSession;
  textSession = null;
  const n = nodes.get(id);
  if (!n) return;
  const after = snap(n);
  if (after.content === before.content && after.note === before.note) return;
  history.push({ changes: [{ id, before, after }], focusBefore: focus, focusAfter: { ...focus, offset: null } });
  future = [];
}

function applySnap(id, s) {
  let n = nodes.get(id);
  if (!n) { n = { id }; nodes.set(id, n); }
  Object.assign(n, s);
  markDirty(id);
}

export function undo() {
  commitText();
  const op = history.pop();
  if (!op) return;
  const now = new Date().toISOString();
  for (const c of op.changes) applySnap(c.id, c.before ?? { ...c.after, deleted_at: now });
  future.push(op);
  afterHistory(op.focusBefore);
}

export function redo() {
  commitText();
  const op = future.pop();
  if (!op) return;
  for (const c of op.changes) applySnap(c.id, c.after);
  history.push(op);
  afterHistory(op.focusAfter);
}

function afterHistory(focus) {
  reindex();
  if (zoomId && (!nodes.get(zoomId) || nodes.get(zoomId).deleted_at)) zoomId = null;
  renderAll();
  if (focus) {
    for (const a of ancestors(focus.id)) if (a.collapsed && isInside(a.id, zoomId ?? a.id)) expand(a.id, false);
    restoreFocus(focus);
  }
}

let dirtySince = 0;
function markDirty(id) {
  if (!dirty.size) dirtySince = Date.now();
  dirty.add(id);
  ui.onStatus('saving');
  // 入力が続いていても3秒に1回は保存する
  if (Date.now() - dirtySince > 3000) flush();
  else flushSoon();
}

const flushSoon = debounce(() => flush(), 500);
let flushing = null;
let retryDelay = 2000;

export async function flush() {
  flushSoon.cancel();
  if (flushing) { await flushing; if (!dirty.size) return; }
  if (!dirty.size) return;
  const ids = [...dirty];
  dirty.clear();
  const rows = ids.map((id) => nodes.get(id)).filter(Boolean);
  flushing = api.upsertNodes(rows).then(() => {
    retryDelay = 2000;
    ui.onStatus(dirty.size ? 'saving' : 'saved');
  }, (err) => {
    console.error(err);
    for (const id of ids) dirty.add(id);
    ui.onStatus('error');
    setTimeout(flush, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60000);
  }).finally(() => { flushing = null; });
  await flushing;
}

export const hasUnsaved = () => dirty.size > 0 || !!flushing;

// ============================================================ 描画

function buildEl(n) {
  const content = makeEditable(h('div', { class: 'content' }));
  const note = makeEditable(h('div', { class: 'note' }));
  const row = h('div', { class: 'row' },
    h('span', { class: 'toggle', title: '折りたたみ' }),
    h('span', { class: 'bullet', draggable: isTouch() ? 'false' : 'true', title: 'クリックでズーム' }),
    h('span', { class: 'cb', role: 'checkbox' }),
    h('div', { class: 'text' }, content, note));
  const kidsEl = h('div', { class: 'kids' });
  const el = h('div', { class: 'node', 'data-id': n.id }, row, kidsEl);
  const rec = { el, row, content, note, kidsEl, rendered: false };
  els.set(n.id, rec);
  paint(n);
  renderInto(content, n.content);
  renderInto(note, n.note);
  if (!n.collapsed) renderKids(n.id);
  return el;
}

function paint(n) {
  const r = n && els.get(n.id);
  if (!r) return;
  const c = r.el.classList;
  c.toggle('checked', !!n.checked);
  c.toggle('collapsed', !!n.collapsed);
  c.toggle('has-kids', childrenOf(n.id).length > 0);
  c.toggle('has-checkbox', !!n.checkbox);
  c.toggle('has-note', !!n.note);
  r.row.querySelector('.cb').setAttribute('aria-checked', n.checked ? 'true' : 'false');
}

function repaintText(n) {
  const r = els.get(n.id);
  if (r) {
    renderInto(r.content, n.content);
    renderInto(r.note, n.note);
    paint(n);
  }
  if (n.id === zoomId) renderTitle();
  ensureLoaded([...attIds(n.content), ...attIds(n.note)]);
}

function renderKids(id) {
  const r = els.get(id);
  r.kidsEl.textContent = '';
  for (const c of childrenOf(id)) r.kidsEl.append(buildEl(c));
  r.rendered = true;
}

function dropEls(el) {
  for (const d of el.querySelectorAll('.node')) els.delete(d.dataset.id);
  els.delete(el.dataset.id);
}

function containerFor(parentId) {
  if (parentId === zoomId) return ui.outline;
  const r = els.get(parentId);
  return r && r.rendered ? r.kidsEl : null;
}

// モデル上の位置に合わせて DOM を移動・追加・削除する
function place(n) {
  const cont = n.deleted_at || n.document_id !== doc.id ? null : containerFor(n.parent_id);
  let r = els.get(n.id);
  if (!cont) {
    if (r) { r.el.remove(); dropEls(r.el); }
    return;
  }
  if (!r) { buildEl(n); r = els.get(n.id); ensureLoaded(attIdsIn(n.id)); }
  const sibs = childrenOf(n.parent_id);
  const next = sibs[sibs.indexOf(n) + 1];
  const nextEl = next && els.get(next.id)?.el;
  if (nextEl && nextEl.parentNode === cont) cont.insertBefore(r.el, nextEl);
  else cont.append(r.el);
}

function attIdsIn(id) {
  return subtree(id).flatMap((n) => [...attIds(n.content), ...attIds(n.note)]);
}

function renderAll() {
  els.clear();
  ui.outline.textContent = '';
  ui.outline.classList.toggle('hide-checked', !doc.show_checked);
  for (const c of childrenOf(zoomId)) ui.outline.append(buildEl(c));
  renderTitle();
  const ids = [];
  for (const id of els.keys()) {
    const n = nodes.get(id);
    ids.push(...attIds(n.content), ...attIds(n.note));
  }
  if (zoomId) ids.push(...attIds(nodes.get(zoomId).content), ...attIds(nodes.get(zoomId).note));
  ensureLoaded(ids);
}

function renderTitle() {
  const { title, titleNote } = ui;
  if (zoomId) {
    const z = nodes.get(zoomId);
    if (document.activeElement !== title) renderInto(title, z.content);
    if (document.activeElement !== titleNote) renderInto(titleNote, z.note);
    title.dataset.placeholder = '';
    titleNote.hidden = !z.note && !titleNote.classList.contains('open');
    ui.page.classList.toggle('zoom-checked', !!z.checked);
  } else {
    if (document.activeElement !== title) title.textContent = doc.title;
    title.dataset.placeholder = '無題';
    titleNote.hidden = true;
    ui.page.classList.remove('zoom-checked');
  }
  renderCrumbs();
}

function plain(text) {
  return text.replace(ATT_RE, '📎').replace(MD_LINK_RE, '$1').trim() || '(空の項目)';
}

function renderCrumbs() {
  const c = ui.crumbs;
  c.textContent = '';
  const link = (label, hash) => h('a', { href: hash, class: 'crumb', text: label });
  if (!zoomId) return;
  c.append(link(doc.title || '無題', `#/d/${doc.id}`));
  for (const a of ancestors(zoomId)) {
    c.append(h('span', { class: 'crumb-sep', text: '›' }), link(plain(a.content), `#/d/${doc.id}/${a.id}`));
  }
}

// ============================================================ フォーカス

function fieldEl(id, field) {
  if (field === 'title') return ui.title;
  if (id && id === zoomId) return field === 'note' ? ui.titleNote : ui.title;
  const r = els.get(id);
  return r && (field === 'note' ? r.note : r.content);
}

function currentFocus() {
  const a = document.activeElement;
  if (!a || !doc) return null;
  if (a === ui.title) return zoomId ? { id: zoomId, field: 'content', offset: getCaret(a)?.start ?? null } : { id: null, field: 'title' };
  if (a === ui.titleNote) return { id: zoomId, field: 'note', offset: getCaret(a)?.start ?? null };
  const nodeEl = a.closest?.('.node');
  if (!nodeEl || !ui.outline.contains(nodeEl)) return null;
  return {
    id: nodeEl.dataset.id,
    field: a.classList.contains('note') ? 'note' : 'content',
    offset: getCaret(a)?.start ?? null,
  };
}

function restoreFocus(f) {
  if (!f) return;
  const el = fieldEl(f.id, f.field);
  if (!el) return;
  if (f.field === 'note') openNote(f.id);
  focusAt(el, f.offset ?? Infinity);
}

function focusNode(id, offset = Infinity, field = 'content') {
  const el = fieldEl(id, field);
  if (el) focusAt(el, offset);
}

function visibleIds() {
  return [...ui.outline.querySelectorAll('.node')].filter((el) => el.offsetParent !== null).map((el) => el.dataset.id);
}

function neighbor(id, dir) {
  const v = visibleIds();
  return v[v.indexOf(id) + dir] ?? null;
}

function openNote(id) {
  if (id === zoomId) { ui.titleNote.hidden = false; ui.titleNote.classList.add('open'); return; }
  els.get(id)?.el.classList.add('note-open');
}

function noteShown(id) {
  if (id === zoomId) return !ui.titleNote.hidden;
  const r = els.get(id);
  return !!r && (r.el.classList.contains('has-note') || r.el.classList.contains('note-open'));
}

// ============================================================ 構造の操作

function moveNode(id, parentId, index) {
  const n = nodes.get(id);
  const oldParent = n.parent_id;
  const sort_key = slotKey(parentId, index, id);
  set(id, { parent_id: parentId, sort_key });
  reindex();
  place(n);
  paint(nodes.get(oldParent));
  paint(nodes.get(parentId));
}

function expand(id, record = true) {
  const n = nodes.get(id);
  if (!n.collapsed) return;
  if (record) set(id, { collapsed: false });
  else { n.collapsed = false; markDirty(id); }
  syncCollapsed(n);
}

function withFocusKept(fn) {
  const f = currentFocus() ?? lastFocus;
  fn();
  restoreFocus(f);
}

export function indent(id) {
  const n = nodes.get(id);
  const vis = visibleChildren(n.parent_id);
  const i = vis.indexOf(n);
  if (i <= 0) return;
  const p = vis[i - 1];
  withFocusKept(() => {
    begin();
    expand(p.id);
    moveNode(id, p.id, childrenOf(p.id).filter((c) => c.id !== id).length);
    commit(currentFocus());
  });
}

export function outdent(id) {
  const n = nodes.get(id);
  const p = nodes.get(n.parent_id);
  if (!p || p.id === zoomId) return;
  withFocusKept(() => {
    begin();
    moveNode(id, p.parent_id, idxEx(p, id) + 1);
    commit();
  });
}

export function moveUp(id) {
  const n = nodes.get(id);
  const vis = visibleChildren(n.parent_id);
  const i = vis.indexOf(n);
  withFocusKept(() => {
    begin();
    if (i > 0) moveNode(id, n.parent_id, idxEx(vis[i - 1], id));
    else {
      const p = nodes.get(n.parent_id);
      if (!p || p.id === zoomId) { tx = null; return; }
      moveNode(id, p.parent_id, idxEx(p, id));
    }
    commit();
  });
}

export function moveDown(id) {
  const n = nodes.get(id);
  const vis = visibleChildren(n.parent_id);
  const i = vis.indexOf(n);
  withFocusKept(() => {
    begin();
    if (i < vis.length - 1) moveNode(id, n.parent_id, idxEx(vis[i + 1], id) + 1);
    else {
      const p = nodes.get(n.parent_id);
      if (!p || p.id === zoomId) { tx = null; return; }
      moveNode(id, p.parent_id, idxEx(p, id) + 1);
    }
    commit();
  });
}

export function toggleChecked(id) {
  const n = nodes.get(id);
  const f = currentFocus();
  const next = neighbor(id, 1) ?? neighbor(id, -1);
  begin();
  set(id, { checked: !n.checked });
  paint(n);
  if (id === zoomId) renderTitle();
  commit();
  if (isHidden(n) && f?.id === id) {
    if (next) focusNode(next); else document.activeElement?.blur();
  }
}

export function toggleCheckbox(id) {
  const n = nodes.get(id);
  withFocusKept(() => {
    begin();
    set(id, { checkbox: !n.checkbox });
    paint(n);
    commit();
  });
}

export function toggleCollapse(id) {
  const n = nodes.get(id);
  if (!childrenOf(id).length || id === zoomId) return;
  n.collapsed = !n.collapsed;
  markDirty(id);
  syncCollapsed(n);
}

// n.collapsed に合わせて子の表示を作る/消す
function syncCollapsed(n) {
  const r = els.get(n.id);
  if (!r) return;
  if (n.collapsed && r.rendered) {
    for (const d of r.kidsEl.querySelectorAll('.node')) els.delete(d.dataset.id);
    r.kidsEl.textContent = '';
    r.rendered = false;
  } else if (!n.collapsed && !r.rendered) {
    renderKids(n.id);
    ensureLoaded(attIdsIn(n.id));
  }
  paint(n);
}

export function toggleNote(id, field) {
  if (field === 'note') {
    const n = nodes.get(id);
    if (!n.note) closeNote(id);
    focusNode(id, Infinity, 'content');
  } else {
    openNote(id);
    focusNode(id, Infinity, 'note');
  }
}

function closeNote(id) {
  if (id === zoomId) { ui.titleNote.classList.remove('open'); ui.titleNote.hidden = !nodes.get(id).note; return; }
  els.get(id)?.el.classList.remove('note-open');
}

function deleteSubtree(id) {
  const now = new Date().toISOString();
  for (const d of subtree(id)) set(d.id, { deleted_at: now });
  const n = nodes.get(id);
  reindex();
  place(n);
  paint(nodes.get(n.parent_id));
}

export function deleteNode(id) {
  if (id === zoomId) return;
  const target = neighbor(id, -1) ?? neighbor(id, 1);
  begin();
  deleteSubtree(id);
  ensureNotEmpty();
  commit();
  const t = target && !isInside(target, id) ? target : visibleIds()[0];
  if (t) focusNode(t);
  else document.activeElement?.blur();
}

// ドキュメント(またはズーム先)が空にならないよう最低1項目を置く
function ensureNotEmpty() {
  if (childrenOf(zoomId).length) return null;
  const m = create({ parent_id: zoomId, sort_key: slotKey(zoomId, 0) });
  reindex();
  place(m);
  paint(nodes.get(zoomId));
  return m;
}

function enter(id) {
  const n = nodes.get(id);
  const el = fieldEl(id, 'content');
  const c = getCaret(el) ?? { start: n.content.length, end: n.content.length };
  const start = Math.min(c.start, c.end);
  const end = Math.max(c.start, c.end);
  begin();
  if (id === zoomId) {
    // ズーム中のタイトルで Enter: 先頭に子を作る
    const m = create({ parent_id: id, sort_key: slotKey(id, 0), checkbox: childrenOf(id)[0]?.checkbox ?? false });
    reindex();
    place(m);
    commit({ id: m.id, field: 'content', offset: 0 });
    focusNode(m.id, 0);
    return;
  }
  const idx = idxEx(n);
  if (start === 0 && end === 0 && n.content.length > 0) {
    const m = create({ parent_id: n.parent_id, sort_key: slotKey(n.parent_id, idx), checkbox: n.checkbox });
    reindex();
    place(m);
    commit({ id, field: 'content', offset: 0 });
    focusNode(id, 0);
    return;
  }
  const before = n.content.slice(0, start);
  const after = n.content.slice(end);
  if (after || end !== start) { set(id, { content: before }); repaintText(n); }
  const intoKids = !n.collapsed && visibleChildren(id).length > 0;
  const m = intoKids
    ? create({ parent_id: id, sort_key: slotKey(id, 0), checkbox: n.checkbox, content: after })
    : create({ parent_id: n.parent_id, sort_key: slotKey(n.parent_id, idx + 1), checkbox: n.checkbox, content: after });
  reindex();
  place(m);
  paint(nodes.get(m.parent_id));
  commit({ id: m.id, field: 'content', offset: 0 });
  focusNode(m.id, 0);
}

function backspaceAtStart(id) {
  const n = nodes.get(id);
  if (childrenOf(id).length) return false;
  const prevId = neighbor(id, -1);
  if (!n.content && !n.note) {
    if (!prevId) {
      if (visibleIds().length <= 1) return true;
      begin(); deleteSubtree(id); commit();
      focusNode(visibleIds()[0], 0);
      return true;
    }
    begin(); deleteSubtree(id); commit({ id: prevId, field: 'content', offset: null });
    focusNode(prevId);
    return true;
  }
  if (!prevId) return false;
  const prev = nodes.get(prevId);
  const pos = prev.content.length;
  begin();
  set(prevId, {
    content: prev.content + n.content,
    note: [prev.note, n.note].filter(Boolean).join('\n'),
  });
  deleteSubtree(id);
  repaintText(prev);
  commit({ id: prevId, field: 'content', offset: pos });
  focusNode(prevId, pos);
  return true;
}

function duplicate(id) {
  const src = nodes.get(id);
  begin();
  const copy = (n, parentId, sortKey) => {
    const m = create({ ...snap(n), parent_id: parentId, sort_key: sortKey, deleted_at: null });
    const ks = childrenOf(n.id);
    const keys = generateNKeysBetween(null, null, ks.length);
    ks.forEach((k, i) => copy(k, m.id, keys[i]));
    return m;
  };
  const m = copy(src, src.parent_id, slotKey(src.parent_id, idxEx(src) + 1));
  reindex();
  place(m);
  commit({ id: m.id, field: 'content', offset: null });
  focusNode(m.id);
}

async function moveToDocument(id) {
  const options = library.docOptions().filter((o) => o.value !== doc.id);
  if (!options.length) { toast('移動先のドキュメントがありません'); return; }
  const targetId = await choose('移動先のドキュメント', options);
  if (!targetId) return;
  let lastKey = null;
  try {
    const roots = (await api.loadNodes(targetId)).filter((r) => !r.parent_id).sort(bySortKey);
    lastKey = roots.at(-1)?.sort_key ?? null;
  } catch (err) {
    console.error(err);
    toast('移動先を読み込めませんでした');
    return;
  }
  const next = neighbor(id, 1) ?? neighbor(id, -1);
  begin();
  const n = nodes.get(id);
  const oldParent = n.parent_id;
  for (const d of subtree(id)) set(d.id, { document_id: targetId });
  set(id, { parent_id: null, sort_key: generateKeyBetween(lastKey, null) });
  reindex();
  place(n);
  paint(nodes.get(oldParent));
  ensureNotEmpty();
  commit();
  toast(`「${library.docTitle(targetId)}」へ移動しました`);
  if (next && !isInside(next, id)) focusNode(next);
}

// 複数行の貼り付け: 1行目はキャレット位置に、2行目以降は階層を保って下に項目として追加
function pasteItems(id, items) {
  const n = nodes.get(id);
  const el = fieldEl(id, 'content');
  const c = getCaret(el) ?? { start: n.content.length, end: n.content.length };
  begin();
  const tail = n.content.slice(Math.max(c.start, c.end));
  // チェックボックスの有無が書かれていればそれに従い、書かれていない行は付けない。全く書かれていなければ今の項目に合わせる
  const fallback = items.some((it) => 'checkbox' in it) ? false : n.checkbox;
  const flags = (it) => ('checkbox' in it ? { checkbox: it.checkbox, checked: it.checked } : { checkbox: fallback });
  set(id, {
    content: n.content.slice(0, Math.min(c.start, c.end)) + items[0].text,
    ...('checkbox' in items[0] && !n.content && flags(items[0])),
  });
  repaintText(n);
  // parents[k] = 深さ k の直近の項目。深さ0の1つ目は今の項目そのもの
  const parents = [n];
  let last = n;
  for (const it of items.slice(1)) {
    let parentId;
    let index;
    if (it.level === 0) {
      const ref = parents[0];
      parentId = ref.parent_id;
      index = idxEx(ref) + 1;
    } else {
      const p = parents[it.level - 1];
      if (p.collapsed) expand(p.id);
      parentId = p.id;
      index = childrenOf(p.id).length;
    }
    const m = create({ parent_id: parentId, sort_key: slotKey(parentId, index), content: it.text, ...flags(it) });
    reindex();
    place(m);
    parents[it.level] = m;
    parents.length = it.level + 1;
    last = m;
  }
  if (tail) { set(last.id, { content: last.content + tail }); repaintText(last); }
  paint(nodes.get(n.parent_id));
  paint(n);
  for (const p of parents) paint(p);
  const pos = last.content.length - tail.length;
  commit({ id: last.id, field: 'content', offset: pos });
  focusNode(last.id, pos);
}

// ============================================================ 添付の挿入

export function insertFiles(files, target = currentFocus() ?? lastFocus) {
  if (!target || !target.id || !nodes.get(target.id)) {
    toast('添付先の項目を選んでから貼り付けてください');
    return;
  }
  const n = nodes.get(target.id);
  const markers = [...files].map((f) => startUpload(f, n.id)).filter(Boolean).map(marker).join('');
  if (!markers) return;
  const field = target.field === 'note' ? 'note' : 'content';
  const text = n[field];
  const off = Math.min(target.offset ?? text.length, text.length);
  begin();
  set(n.id, { [field]: text.slice(0, off) + markers + text.slice(off) });
  repaintText(n);
  if (field === 'note') openNote(n.id);
  commit({ id: n.id, field, offset: off + markers.length });
  restoreFocus({ id: n.id, field, offset: off + markers.length });
}

export const focusForAttach = () => currentFocus() ?? lastFocus;

// ============================================================ イベント

function eventTarget(e) {
  const t = e.target;
  if (t === ui.title) return zoomId ? { id: zoomId, field: 'content', el: t } : { id: null, field: 'title', el: t };
  if (t === ui.titleNote) return { id: zoomId, field: 'note', el: t };
  const nodeEl = t.closest?.('.node');
  if (!nodeEl || !t.classList) return null;
  if (t.classList.contains('content')) return { id: nodeEl.dataset.id, field: 'content', el: t };
  if (t.classList.contains('note')) return { id: nodeEl.dataset.id, field: 'note', el: t };
  return null;
}

function onInput(e) {
  const t = eventTarget(e);
  if (!t) return;
  if (t.field === 'title') {
    doc.title = t.el.textContent.replace(/\n/g, ' ');
    library.saveDoc(doc);
    ui.onTitleChange?.(doc);
    return;
  }
  const n = nodes.get(t.id);
  if (!n) return;
  if (!textSession || textSession.id !== t.id) {
    commitText();
    textSession = { id: t.id, before: snap(n), focus: { id: t.id, field: t.field, offset: null } };
  }
  n[t.field] = serialize(t.el, { multiline: t.field === 'note' });
  markDirty(t.id);
  paint(n);
  if (t.id === zoomId) renderCrumbs();
  commitTextSoon();
}

// 編集を始めたら [表示名](URL) を元の書き方で見せる(Dynalist と同じ)
function onFocusIn(e) {
  const t = eventTarget(e);
  if (!t || t.field === 'title') return;
  const n = nodes.get(t.id);
  if (!n || !hasMdLink(n[t.field])) return;
  // クリック位置にキャレットが置かれてから差し替える
  setTimeout(() => {
    if (document.activeElement !== t.el || !t.el.querySelector('[data-md]')) return;
    const c = getCaret(t.el);
    renderInto(t.el, n[t.field], { raw: true });
    setCaret(t.el, c?.start ?? n[t.field].length);
  });
}

function onFocusOut(e) {
  const t = eventTarget(e);
  if (!t || t.field === 'title') return;
  commitText();
  const n = nodes.get(t.id);
  if (!n) return;
  // 入力中は素の文字列で、離れたらリンク等を付けて描き直す
  if (e.relatedTarget !== t.el) renderInto(t.el, n[t.field]);
  if (t.field === 'note' && !n.note && e.relatedTarget) closeNote(t.id);
}

function onKeyDown(e) {
  const t = eventTarget(e);
  if (!t) return;
  if (e.isComposing || e.keyCode === 229) return;
  const k = e.key;
  const mod = modKey(e);
  const stop = () => { e.preventDefault(); e.stopPropagation(); };

  if (mod && k.toLowerCase() === 'z') { stop(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k.toLowerCase() === 'y') { stop(); redo(); return; }

  if (t.field === 'title') {
    if (k === 'Enter' || k === 'ArrowDown') {
      stop();
      const first = visibleIds()[0];
      if (first && k === 'ArrowDown') return focusNode(first, 0);
      begin();
      const m = create({ parent_id: null, sort_key: slotKey(null, 0), checkbox: childrenOf(null)[0]?.checkbox ?? false });
      reindex(); place(m);
      commit({ id: m.id, field: 'content', offset: 0 });
      focusNode(m.id, 0);
    }
    return;
  }

  const { id, field } = t;
  const isTitle = id === zoomId;

  if (k === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
    if (field === 'note') return; // メモ欄は改行
    stop();
    // 変換確定の Enter が遅れて届くブラウザがあるので、確定直後は項目を分けない
    if (Date.now() - lastCompositionEnd < 30) return;
    enter(id); return;
  }
  if (k === 'Enter' && e.shiftKey && !mod) { stop(); toggleNote(id, field); return; }
  if (k === 'Enter' && mod && e.shiftKey) { stop(); if (!isTitle) toggleCheckbox(id); return; }
  if (k === 'Enter' && mod) { stop(); toggleChecked(id); return; }
  if (k === 'Escape') { stop(); t.el.blur(); return; }

  if (isTitle) {
    if (k === 'ArrowDown' && (field === 'note' || !noteShown(id)) && caretOnEdgeLine(t.el, 1)) {
      const first = visibleIds()[0];
      if (first) { stop(); focusAtX(fieldEl(first, 'content'), caretX(), 1); }
    } else if (k === 'ArrowDown' && field === 'content' && caretOnEdgeLine(t.el, 1)) {
      stop(); focusAtX(ui.titleNote, caretX(), 1);
    } else if (k === 'ArrowUp' && field === 'note' && caretOnEdgeLine(t.el, -1)) {
      stop(); focusAtX(ui.title, caretX(), -1);
    } else if (k === 'ArrowLeft' && e.altKey) {
      stop(); zoomOut();
    }
    return;
  }

  if (k === 'Tab') { stop(); e.shiftKey ? outdent(id) : indent(id); return; }
  if (mod && k === 'ArrowUp') { stop(); moveUp(id); return; }
  if (mod && k === 'ArrowDown') { stop(); moveDown(id); return; }
  if (mod && k === '.') { stop(); toggleCollapse(id); return; }
  if (e.altKey && k === 'ArrowRight') { stop(); zoomTo(id); return; }
  if (e.altKey && k === 'ArrowLeft') { stop(); zoomOut(); return; }
  if (mod && e.shiftKey && k === 'Backspace') { stop(); deleteNode(id); return; }

  if (k === 'Backspace' && !mod && !e.altKey) {
    const c = getCaret(t.el);
    if (c && c.start === 0 && c.end === 0) {
      if (field === 'note') {
        if (!nodes.get(id).note) { stop(); closeNote(id); focusNode(id); }
        return;
      }
      if (backspaceAtStart(id)) stop();
    }
    return;
  }

  if ((k === 'ArrowUp' || k === 'ArrowDown') && !e.shiftKey && !mod && !e.altKey) {
    const dir = k === 'ArrowUp' ? -1 : 1;
    if (!caretOnEdgeLine(t.el, dir)) return;
    const x = caretX();
    let dest = null;
    if (dir < 0) {
      if (field === 'note') dest = fieldEl(id, 'content');
      else {
        const p = neighbor(id, -1);
        if (p) dest = fieldEl(p, noteShown(p) ? 'note' : 'content');
        else dest = zoomId ? (noteShown(zoomId) ? ui.titleNote : ui.title) : ui.title;
      }
    } else if (field === 'content' && noteShown(id)) dest = fieldEl(id, 'note');
    else {
      const nx = neighbor(id, 1);
      if (nx) dest = fieldEl(nx, 'content');
    }
    if (dest) { stop(); focusAtX(dest, x, dir); }
  }
}

function onPaste(e) {
  const t = eventTarget(e);
  if (!t) return;
  const dt = e.clipboardData;
  const files = [...(dt?.files || [])];
  e.preventDefault();
  if (files.length && t.field !== 'title') {
    insertFiles(files, { id: t.id, field: t.field, offset: getCaret(t.el)?.start ?? null });
    return;
  }
  if (!dt) return;
  let text;
  if (t.field === 'note') {
    text = (dt.getData('text/plain') || '').replace(/\r\n?/g, '\n');
  } else {
    const items = parseClipboard(dt);
    if (!items.length) return;
    if (items.length > 1 && t.field === 'content' && t.id !== zoomId) return pasteItems(t.id, items);
    text = items.map((it) => it.text).join(' ');
  }
  if (!text) return;
  document.execCommand('insertText', false, text);
}

function onClick(e) {
  const chip = e.target.closest?.('.att');
  if (chip) { e.preventDefault(); handleChipClick(chip); return; }
  const link = e.target.closest?.('a.link');
  if (link && (modKey(e) || !pointerWasFocused)) {
    e.preventDefault();
    window.open(link.href, '_blank', 'noopener');
    return;
  }
  const nodeEl = e.target.closest?.('.node');
  if (!nodeEl) return;
  const id = nodeEl.dataset.id;
  if (e.target.classList.contains('bullet')) { zoomTo(id); return; }
  if (e.target.classList.contains('toggle')) { toggleCollapse(id); return; }
  if (e.target.classList.contains('cb')) { toggleChecked(id); }
}

// ---------- 項目メニュー(右クリック・長押し)

function onContextMenu(e) {
  const bullet = e.target.closest?.('.bullet');
  if (!bullet) return;
  e.preventDefault();
  showNodeMenu(bullet.closest('.node').dataset.id, e.clientX, e.clientY);
}

function setupLongPress(el) {
  let timer = null;
  let start = null;
  el.addEventListener('touchstart', (e) => {
    const bullet = e.target.closest?.('.bullet');
    if (!bullet) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      bullet.dataset.longpress = '1';
      showNodeMenu(bullet.closest('.node').dataset.id, start.x, start.y);
    }, 500);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    cancel();
    const bullet = e.target.closest?.('.bullet');
    if (bullet?.dataset.longpress) { e.preventDefault(); delete bullet.dataset.longpress; }
  });
}

let fileInput;
export function pickFiles(target) {
  if (!fileInput) {
    fileInput = h('input', { type: 'file', multiple: true, hidden: true });
    document.body.append(fileInput);
  }
  fileInput.onchange = () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) insertFiles(files, target);
  };
  fileInput.click();
}

function showNodeMenu(id, x, y) {
  const n = nodes.get(id);
  popupMenu(x, y, [
    { label: n.checked ? '未完了に戻す' : '完了にする', action: () => toggleChecked(id) },
    { label: n.checkbox ? 'チェックボックスを消す' : 'チェックボックスを付ける', action: () => toggleCheckbox(id) },
    { label: 'メモを書く', action: () => { openNote(id); focusNode(id, Infinity, 'note'); } },
    { label: 'ファイルを添付', action: () => pickFiles({ id, field: 'content', offset: null }) },
    { label: 'ズーム', action: () => zoomTo(id) },
    { label: '複製', action: () => duplicate(id) },
    { label: '別のドキュメントへ移動', action: () => moveToDocument(id) },
    { label: '削除', danger: true, action: () => deleteNode(id) },
  ]);
}

// ---------- ドラッグ&ドロップ(項目の並べ替え・ファイルの添付)

function setupDragDrop() {
  const { outline, page } = ui;
  const indicator = h('div', { class: 'drop-indicator', hidden: true });
  page.append(indicator);
  let dragId = null;
  let drop = null;

  outline.addEventListener('dragstart', (e) => {
    const bullet = e.target.closest?.('.bullet');
    if (!bullet) return;
    dragId = bullet.closest('.node').dataset.id;
    e.dataTransfer.setData('text/plain', plain(nodes.get(dragId).content));
    e.dataTransfer.effectAllowed = 'move';
    els.get(dragId)?.el.classList.add('dragging');
  });
  outline.addEventListener('dragend', () => {
    els.get(dragId)?.el.classList.remove('dragging');
    dragId = null;
    indicator.hidden = true;
  });

  page.addEventListener('dragover', (e) => {
    const hasFiles = [...e.dataTransfer.types].includes('Files');
    if (!dragId && !hasFiles) return;
    e.preventDefault();
    if (!dragId) { e.dataTransfer.dropEffect = 'copy'; return; }
    const row = e.target.closest?.('.row');
    const nodeEl = row?.closest('.node');
    if (!row || !ui.outline.contains(row) || isInside(nodeEl.dataset.id, dragId)) {
      indicator.hidden = true; drop = null; return;
    }
    const tid = nodeEl.dataset.id;
    const tn = nodes.get(tid);
    const rect = row.getBoundingClientRect();
    const textLeft = row.querySelector('.text').getBoundingClientRect().left;
    let mode;
    if (e.clientY < rect.top + rect.height / 2) mode = 'before';
    else if (!tn.collapsed && visibleChildren(tid).length) mode = 'first-child';
    else if (e.clientX > textLeft + 24) mode = 'child';
    else mode = 'after';
    drop = { tid, mode };
    const pageRect = page.getBoundingClientRect();
    const left = (mode === 'child' || mode === 'first-child' ? textLeft + 24 : textLeft) - pageRect.left;
    indicator.hidden = false;
    indicator.style.top = `${(mode === 'before' ? rect.top : rect.bottom) - pageRect.top + page.scrollTop - 1}px`;
    indicator.style.left = `${left}px`;
    indicator.style.width = `${Math.max(40, rect.right - pageRect.left - left)}px`;
  });

  page.addEventListener('drop', (e) => {
    indicator.hidden = true;
    if (!dragId) {
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      e.preventDefault();
      const target = dropTarget(e);
      if (target) insertFiles(files, target);
      return;
    }
    e.preventDefault();
    if (!drop) return;
    const { tid, mode } = drop;
    const tn = nodes.get(tid);
    const id = dragId;
    begin();
    if (mode === 'before') moveNode(id, tn.parent_id, idxEx(tn, id));
    else if (mode === 'after') moveNode(id, tn.parent_id, idxEx(tn, id) + 1);
    else if (mode === 'first-child') moveNode(id, tid, 0);
    else { expand(tid); moveNode(id, tid, childrenOf(tid).filter((c) => c.id !== id).length); }
    commit();
    drop = null;
  });
}

function dropTarget(e) {
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
  const field = (range?.startContainer.nodeType === 3 ? range.startContainer.parentElement : range?.startContainer)
    ?.closest?.('.content, .note, .title, .title-note') ?? e.target.closest?.('.content, .note');
  const fake = { target: field };
  const t = field && eventTarget(fake);
  if (t && t.id) {
    let offset = null;
    if (range) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      offset = getCaret(t.el)?.start ?? null;
    }
    return { id: t.id, field: t.field, offset };
  }
  const nodeEl = e.target.closest?.('.node');
  if (nodeEl) return { id: nodeEl.dataset.id, field: 'content', offset: null };
  const f = lastFocus;
  return f?.id ? f : null;
}

// ============================================================ ズーム・ドキュメント

export function zoomTo(id) {
  if (!doc) return;
  location.hash = id ? `#/d/${doc.id}/${id}` : `#/d/${doc.id}`;
}

function zoomOut() {
  if (!zoomId) return;
  const z = nodes.get(zoomId);
  zoomTo(z.parent_id);
}

export function setZoom(id) {
  commitText();
  const target = id && nodes.get(id) && !nodes.get(id).deleted_at ? id : null;
  const from = zoomId;
  zoomId = target;
  ui.titleNote.classList.remove('open');
  ensureNotEmpty();
  renderAll();
  if (target) {
    const first = visibleIds()[0];
    if (!isTouch() && first) focusNode(first, Infinity);
  } else if (from && els.get(from)) {
    els.get(from).row.scrollIntoView({ block: 'center' });
    if (!isTouch()) focusNode(from);
  }
}

export async function openDoc(d, zoom) {
  commitText();
  await flush();
  history = [];
  future = [];
  doc = d;
  zoomId = null;
  ui.outline.textContent = '';
  ui.title.textContent = d.title;
  const rows = await api.loadNodes(d.id);
  if (doc !== d) return;
  nodes = new Map(rows.map((r) => [r.id, r]));
  reindex();
  if (!childrenOf(null).length) create({ parent_id: null, sort_key: 'a0' }) && reindex();
  setZoom(zoom);
  if (!zoom && isTouch()) window.scrollTo(0, 0);
}

export const currentDoc = () => doc;
export const currentZoom = () => zoomId;

export function setShowChecked(show) {
  doc.show_checked = show;
  ui.outline.classList.toggle('hide-checked', !show);
  library.saveDoc(doc);
}

export function refreshTitle() {
  if (doc) renderTitle();
}

// ============================================================ 他端末からの変更

export function applyRemoteNode(row) {
  if (!doc || !row?.id) return;
  const local = nodes.get(row.id);
  if (dirty.has(row.id) || textSession?.id === row.id) return;
  if (row.document_id !== doc.id && !(local && local.document_id === doc.id)) return;
  const editing = currentFocus()?.id === row.id;
  if (!local) {
    const n = { ...row };
    nodes.set(n.id, n);
    reindex();
    place(n);
    paint(nodes.get(n.parent_id));
    return;
  }
  const same = SNAP_FIELDS.every((f) => (local[f] ?? null) === (row[f] ?? null));
  if (same) return;
  const structural = local.parent_id !== row.parent_id || local.sort_key !== row.sort_key
    || !!local.deleted_at !== !!row.deleted_at || local.document_id !== row.document_id;
  const textChanged = local.content !== row.content || local.note !== row.note;
  const oldParent = local.parent_id;
  const keep = editing ? { content: local.content, note: local.note } : {};
  const collapsedChanged = local.collapsed !== row.collapsed;
  Object.assign(local, row, keep);
  if (structural) {
    const f = currentFocus();
    reindex();
    place(local);
    paint(nodes.get(oldParent));
    paint(nodes.get(local.parent_id));
    if (f && f.id !== row.id) restoreFocus(f);
  }
  if (collapsedChanged) syncCollapsed(local);
  if (textChanged && !editing) repaintText(local);
  paint(local);
  if (row.id === zoomId) renderTitle();
}

// 復帰時などに、編集中でなければ読み直す
export async function reloadIfIdle() {
  if (!doc || hasUnsaved() || textSession || currentFocus()) return;
  const d = doc;
  const rows = await api.loadNodes(d.id);
  if (doc !== d || hasUnsaved() || currentFocus()) return;
  nodes = new Map(rows.map((r) => [r.id, r]));
  reindex();
  if (zoomId && !nodes.get(zoomId)) zoomId = null;
  const y = window.scrollY;
  renderAll();
  window.scrollTo(0, y);
}
