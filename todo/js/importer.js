// Dynalist からの一括取り込み(API トークン、または OPML ファイル)
import { h, uuid, toast, generateNKeysBetween, generateKeyBetween } from './util.js';
import { MD_LINK_RE, ATT_RE } from './content.js';

const API = 'https://dynalist.io/api/v1';
const DOC_INTERVAL = 1200; // doc/read の間隔(回数制限よけ)

let api;
let library;
let onDone;

export function initImporter(apiRef, libraryRef, done) {
  api = apiRef;
  library = libraryRef;
  onDone = done;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
};

// ---------- Dynalist API

async function callDynalist(path, body) {
  const send = (contentType) => fetch(`${API}/${path}`, {
    method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(body),
  });
  let res;
  try { res = await send('application/json'); }
  catch {
    // ブラウザの制限(CORS)で弾かれたときは、事前確認の要らない形で送り直す
    res = await send('text/plain;charset=UTF-8');
  }
  const data = await res.json();
  return data;
}

async function dynalist(path, body, log) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const data = await callDynalist(path, body);
    if (data._code === 'Ok') return data;
    if (data._code === 'TooManyRequests') {
      log('Dynalist の回数制限にかかったので、少し待ってから続けます…');
      await sleep(15000 * (attempt + 1));
      continue;
    }
    if (data._code === 'InvalidToken') throw new Error('API トークンが正しくありません');
    throw new Error(data._msg || data._code || '不明なエラー');
  }
  throw new Error('Dynalist の回数制限が続いたため中断しました');
}

// ---------- 取り込み本体

// Dynalist の項目ツリー → このアプリの行。linkMap: Dynalist の ID → 新しい ID(リンクの付け替え用)
function convertDoc(dyn, docId, idMap) {
  const byId = new Map(dyn.nodes.map((n) => [n.id, n]));
  const rows = [];
  const walk = (parentDynId, parentId) => {
    const kids = (byId.get(parentDynId)?.children || []).map((id) => byId.get(id)).filter(Boolean);
    const keys = generateNKeysBetween(null, null, kids.length);
    kids.forEach((k, i) => {
      const id = idMap.get(k.id) ?? uuid();
      idMap.set(k.id, id);
      rows.push({
        id, document_id: docId, parent_id: parentId, sort_key: keys[i],
        content: k.content || '', note: k.note || '',
        checkbox: !!k.checkbox, checked: !!k.checked, collapsed: !!k.collapsed && !!k.children?.length,
        deleted_at: null, _dyn: k.id,
      });
      walk(k.id, id);
    });
  };
  walk('root', null);
  return rows;
}

// Dynalist 内のリンク(https://dynalist.io/d/文書ID#z=項目ID)を、このアプリ内のリンクに付け替える
function rewriteLinks(rows, docMap, nodeMap, titles) {
  const base = location.href.split('#')[0];
  const DYN_URL = /https:\/\/dynalist\.io\/d\/([A-Za-z0-9_-]+)(?:#z=([A-Za-z0-9_-]+))?/g;
  const target = (fileId, nodeId) => {
    const doc = docMap.get(fileId);
    if (!doc) return null;
    const node = nodeId && nodeMap.get(nodeId);
    return { url: node ? `${base}#/d/${doc}/${node}` : `${base}#/d/${doc}`, title: (node && titles.get(node)) || titles.get(doc) };
  };
  for (const r of rows) {
    for (const field of ['content', 'note']) {
      let text = r[field];
      if (!text.includes('dynalist.io/d/')) continue;
      // [表示名](Dynalistのリンク) は URL だけ差し替え
      text = text.replace(MD_LINK_RE, (all, label, url) => {
        DYN_URL.lastIndex = 0;
        const m = DYN_URL.exec(url);
        const t = m && m.index === 0 && target(m[1], m[2]);
        return t ? `[${label}](${t.url})` : all;
      });
      // 裸の Dynalist の URL は、リンク先の項目名を表示名にする
      text = text.replace(DYN_URL, (all, fileId, nodeId, offset, str) => {
        if (str[offset - 1] === '(') return all; // [..](..) の中は上で処理済み
        const t = target(fileId, nodeId);
        if (!t) return all;
        const label = (t.title || 'リンク').replace(ATT_RE, '').replace(MD_LINK_RE, '$1').replace(/[[\]()\n]/g, ' ').trim().slice(0, 80) || 'リンク';
        return `[${label}](${t.url})`;
      });
      r[field] = text;
    }
  }
}

async function saveRows(rows, log) {
  const clean = rows.map(({ _dyn, ...r }) => r);
  for (let i = 0; i < clean.length; i += 500) {
    await api.upsertNodes(clean.slice(i, i + 500));
    if (clean.length > 500) log(`  ${Math.min(i + 500, clean.length)} / ${clean.length} 項目を保存`);
  }
}

async function makeImportFolder(name) {
  const folder = { id: uuid(), parent_id: null, name, sort_key: library.nextTopFolderKey(), deleted_at: null };
  await api.saveFolder(folder);
  library.expandFolder(folder.id);
  return folder;
}

async function importFromApi(token, log, progress, cancelled) {
  log('Dynalist のファイル一覧を読み込んでいます…');
  const list = await dynalist('file/list', { token }, log);
  const files = new Map(list.files.map((f) => [f.id, f]));
  const docs = list.files.filter((f) => f.type === 'document');
  log(`ドキュメント ${docs.length} 件、フォルダ ${list.files.filter((f) => f.type === 'folder' && f.id !== list.root_file_id).length} 件が見つかりました`);
  if (!docs.length) return 0;

  const root = await makeImportFolder(`Dynalist取り込み_${stamp()}`);
  const docMap = new Map();
  const nodeMap = new Map();
  const titles = new Map();
  const folderRows = [];
  const docRows = [];

  // フォルダ構成を作る(Dynalist の並び順どおり)
  const walk = (fileId, parentFolderId) => {
    const f = files.get(fileId);
    const kids = (f?.children || []).map((id) => files.get(id)).filter(Boolean);
    const keys = generateNKeysBetween(null, null, kids.length);
    kids.forEach((k, i) => {
      if (k.type === 'folder') {
        const id = uuid();
        folderRows.push({ id, parent_id: parentFolderId, name: k.title || '無題', sort_key: keys[i], deleted_at: null });
        walk(k.id, id);
      } else {
        const id = uuid();
        docMap.set(k.id, id);
        titles.set(id, k.title || '無題');
        docRows.push({ id, folder_id: parentFolderId, title: k.title || '無題', sort_key: keys[i], show_checked: true, deleted_at: null, _dyn: k.id });
      }
    });
  };
  walk(list.root_file_id, root.id);
  // 一覧の木に入っていないドキュメントも取りこぼさない
  for (const d of docs) {
    if (docMap.has(d.id)) continue;
    const id = uuid();
    docMap.set(d.id, id);
    titles.set(id, d.title || '無題');
    docRows.push({ id, folder_id: root.id, title: d.title || '無題', sort_key: generateKeyBetween(docRows.at(-1)?.sort_key ?? null, null), show_checked: true, deleted_at: null, _dyn: d.id });
  }

  // 中身をすべて読む(リンクの付け替えのため、保存は読み終えてから)
  const allRows = [];
  for (let i = 0; i < docRows.length; i++) {
    if (cancelled()) throw new Error('中止しました');
    const d = docRows[i];
    progress(i, docRows.length);
    log(`(${i + 1}/${docRows.length}) 「${d.title}」を読み込み中…`);
    const data = await dynalist('doc/read', { token, file_id: d._dyn }, log);
    const rows = convertDoc(data, d.id, nodeMap);
    for (const r of rows) titles.set(r.id, r.content);
    allRows.push(...rows);
    if (i < docRows.length - 1) await sleep(DOC_INTERVAL);
  }
  progress(docRows.length, docRows.length);
  rewriteLinks(allRows, docMap, nodeMap, titles);

  log('このアプリに保存しています…');
  for (const f of folderRows) await api.saveFolder(f);
  for (const { _dyn, ...d } of docRows) await api.saveDocument(d);
  await saveRows(allRows, log);
  log(`完了: ドキュメント ${docRows.length} 件、項目 ${allRows.length} 件を取り込みました`);
  return docRows.length;
}

// ---------- OPML(Dynalist の「書き出し」→ OPML)

function parseOpml(text) {
  const xml = new DOMParser().parseFromString(text, 'text/xml');
  if (xml.querySelector('parsererror')) throw new Error('OPML として読めませんでした');
  const title = xml.querySelector('head > title')?.textContent?.trim();
  const items = [];
  const walk = (el, parentIdx) => {
    for (const o of el.children) {
      if (o.tagName !== 'outline') continue;
      const idx = items.length;
      const bool = (name) => /^(true|1|yes)$/i.test(o.getAttribute(name) || '');
      items.push({
        parentIdx, text: o.getAttribute('text') || '', note: o.getAttribute('_note') || '',
        checked: bool('complete') || bool('_complete') || bool('checked'),
        checkbox: bool('checkbox') || bool('_checkbox'),
        collapsed: /^(true|1)$/i.test(o.getAttribute('_collapsed') || o.getAttribute('collapsed') || ''),
      });
      walk(o, idx);
    }
  };
  walk(xml.querySelector('body') || xml.documentElement, -1);
  return { title, items };
}

async function importFromOpml(fileList, log, progress) {
  const root = await makeImportFolder(`Dynalist取り込み_${stamp()}`);
  const files = [...fileList];
  const keys = generateNKeysBetween(null, null, files.length);
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    progress(i, files.length);
    const file = files[i];
    const { title, items } = parseOpml(await file.text());
    const docTitle = title || file.name.replace(/\.(opml|xml)$/i, '');
    const doc = { id: uuid(), folder_id: root.id, title: docTitle, sort_key: keys[i], show_checked: true, deleted_at: null };
    await api.saveDocument(doc);
    const ids = items.map(() => uuid());
    const kids = new Map();
    items.forEach((it, idx) => { const k = it.parentIdx; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(idx); });
    const rows = [];
    for (const [parentIdx, list] of kids) {
      const sk = generateNKeysBetween(null, null, list.length);
      list.forEach((idx, j) => {
        const it = items[idx];
        rows.push({
          id: ids[idx], document_id: doc.id, parent_id: parentIdx < 0 ? null : ids[parentIdx], sort_key: sk[j],
          content: it.text, note: it.note, checkbox: it.checkbox, checked: it.checked,
          collapsed: it.collapsed && kids.has(idx), deleted_at: null,
        });
      });
    }
    await saveRows(rows, log);
    total += rows.length;
    log(`「${docTitle}」: ${rows.length} 項目`);
  }
  progress(files.length, files.length);
  log(`完了: ドキュメント ${files.length} 件、項目 ${total} 件を取り込みました`);
  return files.length;
}

// ---------- 画面

export function showImporter() {
  if (document.querySelector('.importer')) return;
  let running = false;
  let cancel = false;
  const logBox = h('div', { class: 'import-log' });
  const bar = h('div', { class: 'import-bar' }, h('div', { class: 'import-bar-fill' }));
  const log = (msg) => { logBox.append(h('div', { text: msg })); logBox.scrollTop = logBox.scrollHeight; };
  const progress = (done, all) => { bar.firstChild.style.width = `${all ? (done / all) * 100 : 0}%`; };
  const token = h('input', { type: 'password', class: 'finder-input', placeholder: 'Dynalist の API トークン', autocomplete: 'off' });
  const startBtn = h('button', { class: 'btn primary', type: 'button', text: '取り込み開始' });
  const fileInput = h('input', { type: 'file', accept: '.opml,.xml,text/xml', multiple: true });
  const closeBtn = h('button', { class: 'btn', type: 'button', text: '閉じる' });

  const run = async (fn) => {
    if (running) return;
    running = true;
    cancel = false;
    startBtn.disabled = true;
    fileInput.disabled = true;
    closeBtn.textContent = '中止';
    try {
      const n = await fn();
      if (n) { toast('取り込みが完了しました'); await onDone?.(); }
    } catch (err) {
      console.error(err);
      if (err instanceof TypeError) {
        log('Dynalist に接続できませんでした。ブラウザの制限で API を直接呼べない可能性があります。');
        log('下の「OPML ファイルから取り込む」をお使いください(Dynalist の各ドキュメントで「書き出し」→ OPML)。');
      } else {
        log(`エラー: ${err.message}`);
      }
    } finally {
      running = false;
      startBtn.disabled = false;
      fileInput.disabled = false;
      closeBtn.textContent = '閉じる';
    }
  };

  startBtn.addEventListener('click', () => {
    const t = token.value.trim();
    if (!t) { token.focus(); return; }
    logBox.textContent = '';
    run(() => importFromApi(t, log, progress, () => cancel));
  });
  fileInput.addEventListener('change', () => {
    if (!fileInput.files.length) return;
    logBox.textContent = '';
    run(() => importFromOpml(fileInput.files, log, progress));
  });
  closeBtn.addEventListener('click', () => {
    if (running) { cancel = true; log('中止しています…'); return; }
    overlay.remove();
  });

  const overlay = h('div', { class: 'modal-overlay importer' },
    h('div', { class: 'modal import-modal' },
      h('div', { class: 'modal-title', text: 'Dynalist から取り込み' }),
      h('div', { class: 'import-body' },
        h('p', { class: 'import-help' },
          'Dynalist の設定画面(Settings → Developer)で API トークンを発行して貼り付けてください。',
          'すべてのドキュメントを、フォルダ構成・完了・チェックボックス・メモ・期日ごと「Dynalist取り込み_日付」フォルダに取り込みます。',
          'トークンは取り込みにだけ使い、保存しません。'),
        h('div', { class: 'import-row' }, token, startBtn),
        h('details', { class: 'import-opml' },
          h('summary', { text: 'OPML ファイルから取り込む(API が使えないとき)' }),
          h('p', { class: 'import-help', text: 'Dynalist の各ドキュメントで「書き出し(Export)」→ OPML を選んで保存したファイルを、まとめて選べます。' }),
          fileInput),
        bar, logBox),
      h('div', { class: 'modal-actions' }, closeBtn)));
  document.body.append(overlay);
  token.focus();
}

// テスト用に変換処理だけ公開
export const _test = { convertDoc, rewriteLinks, parseOpml };
