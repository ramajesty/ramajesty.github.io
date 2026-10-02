// フォルダとドキュメントの一覧(サイドバー)
import { h, uuid, debounce, bySortKey, choose, popupMenu, toast, generateKeyBetween } from './util.js';

let api;
let ui; // { tree, onOpen, currentDocId }
const folders = new Map();
const docs = new Map();
const pendingDocSaves = new Map();
const OPEN_KEY = 'todo.openFolders';

let openFolders;
try { openFolders = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { openFolders = new Set(); }
const rememberOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openFolders])); } catch {} };

export function initLibrary(apiRef, opts) {
  api = apiRef;
  ui = opts;
}

export async function loadLibrary() {
  const [fs, ds] = await Promise.all([api.listFolders(), api.listDocuments()]);
  folders.clear();
  docs.clear();
  for (const f of fs) folders.set(f.id, f);
  for (const d of ds) docs.set(d.id, d);
  render();
}

export const getDoc = (id) => { const d = docs.get(id); return d && !d.deleted_at ? d : undefined; };
export const allDocs = () => [...docs.values()].filter((d) => !d.deleted_at);
export const docTitle = (id) => docs.get(id)?.title || '無題';

const childFolders = (parentId) => [...folders.values()].filter((f) => !f.deleted_at && (f.parent_id ?? null) === parentId).sort(bySortKey);
const childDocs = (folderId) => [...docs.values()].filter((d) => !d.deleted_at && (d.folder_id ?? null) === folderId).sort(bySortKey);

function lastKey(list) {
  return generateKeyBetween(list.at(-1)?.sort_key ?? null, null);
}

// 並び順(フォルダ階層順)のドキュメント一覧。移動先選択に使う
export function docOptions() {
  const out = [];
  const walk = (folderId, depth) => {
    for (const f of childFolders(folderId)) walk(f.id, depth + 1);
    for (const d of childDocs(folderId)) out.push({ value: d.id, label: d.title || '無題', depth });
  };
  walk(null, 0);
  return out;
}

function folderOptions(excludeId) {
  const out = [{ value: '__top__', label: '(いちばん上)', depth: 0 }];
  const walk = (parentId, depth) => {
    for (const f of childFolders(parentId)) {
      if (f.id === excludeId) continue;
      out.push({ value: f.id, label: `📁 ${f.name || '無題'}`, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

// ---------- 保存

export function saveDoc(d) {
  let fn = pendingDocSaves.get(d.id);
  if (!fn) {
    fn = debounce(async () => {
      try { await api.saveDocument(clean(d)); }
      catch (err) { console.error(err); toast('ドキュメントの保存に失敗しました'); }
    }, 600);
    pendingDocSaves.set(d.id, fn);
  }
  fn();
  renderSoon();
}

const clean = ({ id, folder_id, title, sort_key, show_checked, deleted_at }) =>
  ({ id, folder_id: folder_id ?? null, title, sort_key, show_checked, deleted_at: deleted_at ?? null });

async function saveFolder(f) {
  try {
    await api.saveFolder({ id: f.id, parent_id: f.parent_id ?? null, name: f.name, sort_key: f.sort_key, deleted_at: f.deleted_at ?? null });
  } catch (err) { console.error(err); toast('フォルダの保存に失敗しました'); }
}

export async function createDoc(title = '', folderId = null) {
  const d = { id: uuid(), folder_id: folderId, title, sort_key: lastKey(childDocs(folderId)), show_checked: true, deleted_at: null };
  docs.set(d.id, d);
  if (folderId) openFolders.add(folderId);
  render();
  await api.saveDocument(d);
  return d;
}

async function createFolder(parentId = null) {
  const name = prompt('フォルダ名');
  if (!name) return;
  const f = { id: uuid(), parent_id: parentId, name, sort_key: lastKey(childFolders(parentId)), deleted_at: null };
  folders.set(f.id, f);
  openFolders.add(f.id);
  if (parentId) openFolders.add(parentId);
  rememberOpen();
  render();
  await saveFolder(f);
}

// ---------- 他端末からの変更

export function applyRemote(table, row) {
  if (!row) return;
  if (table === 'folders') folders.set(row.id, { ...folders.get(row.id), ...row });
  if (table === 'documents') {
    if (pendingDocSaves.has(row.id) && docs.has(row.id)) {
      // 自分の保存の反映は無視(入力中のタイトルを戻さない)
      const d = docs.get(row.id);
      if (row.title === d.title) return;
      if (document.activeElement?.id === 'title') return;
    }
    const d = docs.get(row.id);
    if (d) Object.assign(d, row); else docs.set(row.id, row);
  }
  renderSoon();
}

// ---------- 描画

const renderSoon = debounce(() => render(), 100);

export function render() {
  const tree = ui.tree;
  tree.textContent = '';
  const current = ui.currentDocId();
  const walk = (folderId, container, depth) => {
    for (const f of childFolders(folderId)) {
      const open = openFolders.has(f.id);
      const kids = h('div', { class: 'tree-kids', hidden: !open });
      container.append(h('div', { class: 'tree-folder' + (open ? ' open' : '') },
        h('div', { class: 'tree-item folder', style: `padding-left:${8 + depth * 14}px`, onclick: () => toggleFolder(f.id) },
          h('span', { class: 'tree-caret', text: open ? '▾' : '▸' }),
          h('span', { class: 'tree-label', text: f.name || '無題' }),
          h('button', { class: 'tree-more', title: 'メニュー', text: '⋯', onclick: (e) => { e.stopPropagation(); folderMenu(f, e); } })),
        kids));
      if (open) walk(f.id, kids, depth + 1);
    }
    for (const d of childDocs(folderId)) {
      container.append(h('a', {
        class: 'tree-item doc' + (d.id === current ? ' active' : ''),
        href: `#/d/${d.id}`,
        style: `padding-left:${8 + depth * 14 + 14}px`,
      },
      h('span', { class: 'tree-label', text: d.title || '無題' }),
      h('button', { class: 'tree-more', title: 'メニュー', text: '⋯', onclick: (e) => { e.preventDefault(); e.stopPropagation(); docMenu(d, e); } })));
    }
  };
  walk(null, tree, 0);
  if (!docs.size && !folders.size) tree.append(h('div', { class: 'tree-empty', text: 'ドキュメントがありません' }));
}

function toggleFolder(id) {
  if (openFolders.has(id)) openFolders.delete(id); else openFolders.add(id);
  rememberOpen();
  render();
}

function reorder(list, item, dir, save) {
  const i = list.indexOf(item);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const others = list.filter((x) => x !== item);
  const a = others[j - 1]?.sort_key ?? null;
  const b = others[j]?.sort_key ?? null;
  try { item.sort_key = generateKeyBetween(a, b); }
  catch { return; }
  save(item);
  render();
}

function docMenu(d, e) {
  const list = childDocs(d.folder_id ?? null);
  popupMenu(e.clientX, e.clientY, [
    { label: '名前を変更', action: () => { const t = prompt('ドキュメント名', d.title); if (t != null) { d.title = t; saveDoc(d); ui.onRenamed?.(d); } } },
    { label: 'フォルダへ移動', action: async () => {
      const to = await choose('移動先のフォルダ', folderOptions());
      if (!to) return;
      d.folder_id = to === '__top__' ? null : to;
      d.sort_key = lastKey(childDocs(d.folder_id).filter((x) => x !== d));
      if (d.folder_id) { openFolders.add(d.folder_id); rememberOpen(); }
      saveDoc(d);
    } },
    { label: '上へ', action: () => reorder(list, d, -1, saveDoc) },
    { label: '下へ', action: () => reorder(list, d, 1, saveDoc) },
    { label: '削除', danger: true, action: () => {
      if (!confirm(`「${d.title || '無題'}」を削除しますか?`)) return;
      d.deleted_at = new Date().toISOString();
      saveDoc(d);
      ui.onDeleted?.(d);
    } },
  ]);
}

function folderMenu(f, e) {
  const list = childFolders(f.parent_id ?? null);
  popupMenu(e.clientX, e.clientY, [
    { label: 'ここに新しいドキュメント', action: async () => { const d = await createDoc('', f.id); location.hash = `#/d/${d.id}`; } },
    { label: 'ここに新しいフォルダ', action: () => createFolder(f.id) },
    { label: '名前を変更', action: () => { const t = prompt('フォルダ名', f.name); if (t != null) { f.name = t; saveFolder(f); render(); } } },
    { label: 'フォルダへ移動', action: async () => {
      const to = await choose('移動先のフォルダ', folderOptions(f.id).filter((o) => o.value === '__top__' || !isFolderInside(o.value, f.id)));
      if (!to) return;
      f.parent_id = to === '__top__' ? null : to;
      f.sort_key = lastKey(childFolders(f.parent_id).filter((x) => x !== f));
      saveFolder(f);
      render();
    } },
    { label: '上へ', action: () => reorder(list, f, -1, saveFolder) },
    { label: '下へ', action: () => reorder(list, f, 1, saveFolder) },
    { label: '削除', danger: true, action: () => {
      if (childFolders(f.id).length || childDocs(f.id).length) { toast('中身が空のフォルダだけ削除できます'); return; }
      f.deleted_at = new Date().toISOString();
      saveFolder(f);
      render();
    } },
  ]);
}

function isFolderInside(id, ancestorId) {
  for (let f = folders.get(id); f; f = folders.get(f.parent_id)) if (f.id === ancestorId) return true;
  return false;
}

export const newFolder = () => createFolder(null);
export function expandFolder(id) {
  openFolders.add(id);
  rememberOpen();
}
// いちばん上の階層の末尾に置くフォルダの並び順キー
export const nextTopFolderKey = () => lastKey(childFolders(null));
