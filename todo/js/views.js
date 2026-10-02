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
  chooseDate(due ? toDateValue(due.date) : toDateValue(new Date()), anchor, async (value) => {
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
