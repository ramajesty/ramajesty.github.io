// 検索結果・期日一覧・タグ一覧の画面
import { h, toast, isTouch } from './util.js';
import { renderInto, ATT_RE, MD_LINK_RE } from './content.js';
import { ensureLoaded } from './attachments.js';
import { attIds } from './content.js';
import { parseDue, dueGroup, setDueInText, toDateValue } from './syntax.js';
import { chooseDate, openLink } from './outline.js';

let api;
let ui; // { view, crumbs, onChanged }
const INCLUDE_KEY = 'todo.view.includeChecked';

export function initViews(apiRef, opts) {
  api = apiRef;
  ui = opts;
}

const plain = (text) => text.replace(ATT_RE, '📎').replace(MD_LINK_RE, '$1').trim() || '(空の項目)';

function includeChecked() {
  try { return localStorage.getItem(INCLUDE_KEY) === '1'; } catch { return false; }
}

function header(title, rerender) {
  const box = h('input', { type: 'checkbox', checked: includeChecked() });
  box.addEventListener('change', () => {
    try { localStorage.setItem(INCLUDE_KEY, box.checked ? '1' : '0'); } catch {}
    rerender();
  });
  return h('div', { class: 'view-head' },
    h('h1', { class: 'title', text: title }),
    h('label', { class: 'view-option' }, box, ' 完了も表示'));
}

// 結果の行: チェック・本文・期日・ドキュメント名とパンくず。押すと元の場所へ
function resultRow(n, crumbs) {
  const content = h('div', { class: 'content' });
  renderInto(content, n.content);
  const cb = n.checkbox ? h('span', { class: 'cb', role: 'checkbox', 'aria-checked': n.checked ? 'true' : 'false' }) : h('span', { class: 'bullet' });
  const row = h('div', { class: `result node${n.checked ? ' checked' : ''}${n.checkbox ? ' has-checkbox' : ''}` },
    h('div', { class: 'row' }, cb,
      h('div', { class: 'text' }, content,
        h('div', { class: 'result-path', text: crumbs }))));
  const go = () => { location.hash = `#/d/${n.document_id}?focus=${n.id}`; };
  row.addEventListener('click', (e) => {
    if (e.target.closest('a.link')) { e.preventDefault(); openLink(e.target.closest('a.link').href); return; }
    if (e.target.closest('.att')) return;
    if (e.target.closest('.cb')) { toggleChecked(n, row); return; }
    if (e.target.closest('.due')) { changeDue(n, row, e.target.closest('.due')); return; }
    const tag = e.target.closest('.tag');
    if (tag) { location.hash = `#/search/${encodeURIComponent(tag.dataset.tag)}`; return; }
    go();
  });
  return row;
}

async function toggleChecked(n, row) {
  const checked = !n.checked;
  try {
    await api.updateNode(n.id, { checked });
    n.checked = checked;
    row.classList.toggle('checked', checked);
    row.querySelector('.cb')?.setAttribute('aria-checked', checked ? 'true' : 'false');
    ui.onChanged?.();
  } catch (err) { console.error(err); toast('更新できませんでした'); }
}

function changeDue(n, row, anchor) {
  const due = parseDue(n.content);
  chooseDate(due ? toDateValue(due.date) : '', anchor, async (value) => {
    const content = setDueInText(n.content, value);
    try {
      await api.updateNode(n.id, { content, note: n.note });
      n.content = content;
      renderInto(row.querySelector('.content'), content);
      ui.onChanged?.();
    } catch (err) { console.error(err); toast('更新できませんでした'); }
  });
}

// 親をたどってパンくずの文字列を作る
async function pathsFor(rows) {
  const known = new Map();
  let need = [...new Set(rows.map((r) => r.parent_id).filter(Boolean))];
  for (let depth = 0; depth < 15 && need.length; depth++) {
    const got = await api.loadNodesByIds(need.filter((id) => !known.has(id)));
    for (const g of got) known.set(g.id, g);
    need = [...new Set(got.map((g) => g.parent_id).filter((id) => id && !known.has(id)))];
  }
  const paths = new Map();
  for (const r of rows) {
    const parts = [];
    for (let p = known.get(r.parent_id); p && parts.length < 15; p = known.get(p.parent_id)) parts.unshift(plain(p.content));
    paths.set(r.id, [r.documents?.title || '無題', ...parts].join(' › '));
  }
  return paths;
}

function loading() {
  ui.view.textContent = '';
  ui.view.append(h('div', { class: 'view-loading', text: '読み込み中…' }));
}

// ---------- 検索

// q: 空白区切りで AND。#xxx / @xxx はタグとして絞り込む
export async function renderSearch(q) {
  ui.crumbs.textContent = '検索';
  const input = h('input', { class: 'search-input', type: 'search', value: q, placeholder: '検索(空白区切りで AND、#タグ @人名 も可)', enterkeyhint: 'search' });
  const results = h('div', { class: 'results' });
  ui.view.textContent = '';
  ui.view.append(header('検索', () => renderSearch(input.value.trim())), h('div', { class: 'search-box' }, input), results);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); location.hash = `#/search/${encodeURIComponent(input.value.trim())}`; }
  });
  if (!isTouch() || !q) setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  if (!q) { results.append(h('div', { class: 'view-empty', text: '言葉やタグを入れて Enter で検索します' })); return; }
  results.append(h('div', { class: 'view-loading', text: '検索中…' }));
  const parts = q.split(/\s+/).filter(Boolean);
  const tags = parts.filter((p) => /^[#@]./.test(p)).map((p) => p.toLowerCase());
  const words = parts.filter((p) => !/^[#@]./.test(p));
  try {
    let rows = await api.searchNodes({ words, tag: tags[0] ?? null, includeChecked: includeChecked() });
    if (tags.length > 1) rows = rows.filter((r) => tags.every((t) => (r.tags || []).includes(t)));
    const paths = await pathsFor(rows);
    results.textContent = '';
    results.append(h('div', { class: 'view-count', text: `${rows.length}件${rows.length >= 300 ? '(先頭300件)' : ''}` }));
    for (const r of rows) results.append(resultRow(r, paths.get(r.id)));
    ensureLoaded(rows.flatMap((r) => attIds(r.content)));
  } catch (err) {
    console.error(err);
    results.textContent = '';
    results.append(h('div', { class: 'view-empty', text: '検索できませんでした' }));
  }
}

// ---------- 期日一覧

const GROUPS = [
  ['overdue', '期限切れ'], ['today', '今日'], ['tomorrow', '明日'], ['week', '今週(7日以内)'], ['later', 'それ以降'],
];

export async function renderDue() {
  ui.crumbs.textContent = '期日一覧';
  loading();
  try {
    const rows = await api.dueNodes({ includeChecked: includeChecked() });
    const paths = await pathsFor(rows);
    ui.view.textContent = '';
    ui.view.append(header('期日一覧', renderDue));
    if (!rows.length) {
      ui.view.append(h('div', { class: 'view-empty', text: '期日の付いた項目はありません。項目で Ctrl+D(スマホは📅)を押すと期日を付けられます' }));
      return;
    }
    const now = new Date();
    for (const [key, label] of GROUPS) {
      const list = rows.filter((r) => dueGroup(new Date(r.due_at), now) === key);
      if (!list.length) continue;
      ui.view.append(h('h2', { class: `due-group due-group-${key}` }, `${label}`, h('span', { class: 'due-count', text: String(list.length) })));
      for (const r of list) ui.view.append(resultRow(r, paths.get(r.id)));
    }
    ensureLoaded(rows.flatMap((r) => attIds(r.content)));
  } catch (err) {
    console.error(err);
    ui.view.textContent = '';
    ui.view.append(h('div', { class: 'view-empty', text: '読み込めませんでした' }));
  }
}

// ---------- サイドバーのタグ一覧

export async function renderTagList(container) {
  try {
    const tags = await api.listTags();
    container.textContent = '';
    if (!tags.length) return tags;
    container.append(h('div', { class: 'side-label', text: 'タグ' }));
    for (const { tag, count } of tags.slice(0, 50)) {
      container.append(h('a', { class: 'tree-item tag-item', href: `#/search/${encodeURIComponent(tag)}` },
        h('span', { class: 'tree-label', text: tag }), h('span', { class: 'tag-count', text: String(count) })));
    }
    return tags;
  } catch (err) {
    console.error(err);
    return [];
  }
}

// ---------- ゴミ箱(30日間は元に戻せる)

export const TRASH_DAYS = 30;

function daysLeft(deletedAt) {
  const left = TRASH_DAYS - Math.floor((Date.now() - new Date(deletedAt)) / 86400000);
  return Math.max(0, left);
}

function trashRow(label, sub, deletedAt, onRestore, onDelete) {
  const restore = h('button', { class: 'btn small', type: 'button', text: '元に戻す' });
  const del = h('button', { class: 'link-btn danger-link', type: 'button', text: '完全に削除' });
  const row = h('div', { class: 'trash-row' },
    h('div', { class: 'trash-main' },
      h('div', { class: 'trash-label', text: label }),
      h('div', { class: 'result-path', text: `${sub} ・ あと${daysLeft(deletedAt)}日で完全に削除` })),
    h('div', { class: 'trash-actions' }, restore, del));
  const run = async (fn, doneText) => {
    restore.disabled = true;
    del.disabled = true;
    try {
      await fn();
      row.remove();
      toast(doneText, 1500);
      ui.onChanged?.();
    } catch (err) {
      console.error(err);
      toast('うまくいきませんでした');
      restore.disabled = false;
      del.disabled = false;
    }
  };
  restore.addEventListener('click', () => run(onRestore, '元に戻しました'));
  del.addEventListener('click', () => {
    if (!confirm(`「${label}」を完全に削除しますか?元に戻せなくなります`)) return;
    run(onDelete, '完全に削除しました');
  });
  return row;
}

// 削除した項目を、一緒に削除された子ごとの「まとまり」にする
function nodeBatches(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of nodes) {
    const p = byId.get(n.parent_id);
    if (p && p.deleted_at === n.deleted_at) {
      if (!kids.has(p.id)) kids.set(p.id, []);
      kids.get(p.id).push(n);
    }
  }
  const count = (id) => (kids.get(id) || []).reduce((s, k) => s + 1 + count(k.id), 0);
  return nodes
    .filter((n) => { const p = byId.get(n.parent_id); return !p || p.deleted_at !== n.deleted_at; })
    .map((n) => ({ root: n, more: count(n.id) }))
    // 中身のない空の項目だけのもの(Backspace で消した行など)は出さない
    .filter((b) => b.more > 0 || plain(b.root.content) !== '(空の項目)' || b.root.note);
}

const when = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} に削除`;
};

export async function renderTrash() {
  ui.crumbs.textContent = 'ゴミ箱';
  loading();
  const since = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
  try {
    const { docs, folders, nodes } = await api.listTrash(since);
    const batches = nodeBatches(nodes);
    ui.view.textContent = '';
    const emptyBtn = h('button', { class: 'btn small', type: 'button', text: 'ゴミ箱を空にする' });
    emptyBtn.addEventListener('click', async () => {
      if (!confirm('ゴミ箱の中身をすべて完全に削除しますか?元に戻せなくなります')) return;
      try { await api.purgeTrash(); toast('ゴミ箱を空にしました'); ui.onChanged?.(); renderTrash(); }
      catch (err) { console.error(err); toast('うまくいきませんでした'); }
    });
    ui.view.append(h('div', { class: 'view-head' }, h('h1', { class: 'title', text: 'ゴミ箱' }), emptyBtn),
      h('p', { class: 'import-help', text: `削除したものは ${TRASH_DAYS} 日間ここに残り、その後自動で完全に削除されます。` }));
    if (!docs.length && !folders.length && !batches.length) {
      ui.view.append(h('div', { class: 'view-empty', text: 'ゴミ箱は空です' }));
      return;
    }
    if (docs.length || folders.length) {
      ui.view.append(h('h2', { class: 'due-group', text: 'ドキュメント・フォルダ' }));
      for (const d of docs) {
        ui.view.append(trashRow(`📄 ${d.title || '無題'}`, when(d.deleted_at), d.deleted_at,
          () => api.restoreRows('documents', [d.id]),
          () => api.hardDelete('documents', [d.id])));
      }
      for (const f of folders) {
        ui.view.append(trashRow(`📁 ${f.name || '無題'}`, when(f.deleted_at), f.deleted_at,
          () => api.restoreRows('folders', [f.id]),
          () => api.hardDelete('folders', [f.id])));
      }
    }
    if (batches.length) {
      ui.view.append(h('h2', { class: 'due-group', text: '項目' }));
      for (const { root, more } of batches) {
        const label = plain(root.content) + (more ? `(ほか ${more} 項目)` : '');
        ui.view.append(trashRow(label, `${root.documents?.title || '無題'} ・ ${when(root.deleted_at)}`, root.deleted_at,
          () => restoreBatch(root),
          async () => api.hardDelete('nodes', await batchIds(root))));
      }
    }
  } catch (err) {
    console.error(err);
    ui.view.textContent = '';
    ui.view.append(h('div', { class: 'view-empty', text: 'ゴミ箱を読み込めませんでした' }));
  }
}

// root と、同時に削除されたその子孫の ID
async function batchIds(root) {
  const rows = await api.loadNodesDeletedAt(root.document_id, root.deleted_at);
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
    kids.get(r.parent_id).push(r.id);
  }
  const ids = [root.id];
  for (let i = 0; i < ids.length; i++) ids.push(...(kids.get(ids[i]) || []));
  return ids;
}

async function restoreBatch(root) {
  const ids = await batchIds(root);
  await api.restoreRows('nodes', ids);
  // 親も削除されていたら、ドキュメントのいちばん上に戻す
  if (root.parent_id) {
    const [parent] = await api.loadNodesByIds([root.parent_id]);
    if (!parent || parent.deleted_at) await api.updateNode(root.id, { parent_id: null });
  }
}
