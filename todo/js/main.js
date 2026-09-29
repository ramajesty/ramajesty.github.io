import { h, isTouch, toast } from './util.js';
import { initAttachments } from './attachments.js';
import * as outline from './outline.js';
import * as library from './library.js';

const $ = (id) => document.getElementById(id);
const LAST_DOC_KEY = 'todo.lastDoc';
// 再設定メールのリンクから開いたか(URL は Supabase が読み取った後に消されるので最初に控える)
const recovering = /type=recovery/.test(location.hash + location.search);
let api;

async function loadApi() {
  const dev = new URLSearchParams(location.search).has('mock')
    && ['localhost', '127.0.0.1'].includes(location.hostname);
  if (dev) return (await import('../dev/mock-api.js')).createMockApi();
  return (await import('./api.js')).createApi();
}

async function start() {
  api = await loadApi();
  let started = false;
  api.onAuthChange((event, user) => {
    if (event === 'PASSWORD_RECOVERY' || (recovering && user)) return showNewPassword();
    if (event === 'SIGNED_OUT') location.reload();
    if (user && !started) { started = true; startApp(user); }
  });
  const user = await api.getUser();
  if (recovering && user) showNewPassword();
  else if (user && !started) { started = true; startApp(user); }
  else if (!user) showLogin();
}

// ============================================================ ログイン

function showLogin() {
  const err = h('div', { class: 'login-error' });
  const email = h('input', { type: 'email', placeholder: 'メールアドレス', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', placeholder: 'パスワード', autocomplete: 'current-password', required: true });
  const form = h('form', {
    class: 'login-box',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try { await api.signIn(email.value.trim(), pass.value); }
      catch { err.textContent = 'ログインできませんでした。メールアドレスとパスワードを確認してください'; }
    },
  },
  h('h1', { text: 'Outline Todo' }), email, pass,
  h('button', { class: 'btn primary', type: 'submit', text: 'ログイン' }), err,
  h('button', {
    class: 'link-btn', type: 'button', text: 'パスワードを設定・再設定する',
    onclick: async () => {
      if (!email.value) { err.textContent = '先にメールアドレスを入力してください'; return; }
      try { await api.sendReset(email.value.trim()); err.textContent = '再設定用のメールを送りました。メール内のリンクを開いてください'; }
      catch { err.textContent = 'メールを送れませんでした。しばらくしてから再度お試しください'; }
    },
  }));
  $('login').replaceChildren(form);
  $('login').hidden = false;
  $('app').hidden = true;
}

function showNewPassword() {
  const err = h('div', { class: 'login-error' });
  const pass = h('input', { type: 'password', placeholder: '新しいパスワード(8文字以上)', autocomplete: 'new-password', minlength: '8', required: true });
  const form = h('form', {
    class: 'login-box',
    onsubmit: async (e) => {
      e.preventDefault();
      try { await api.updatePassword(pass.value); location.replace(location.pathname); }
      catch (ex) { err.textContent = `設定できませんでした: ${ex.message ?? ''}`; }
    },
  }, h('h1', { text: '新しいパスワード' }), pass, h('button', { class: 'btn primary', type: 'submit', text: '設定する' }), err);
  $('login').replaceChildren(form);
  $('login').hidden = false;
  $('app').hidden = true;
}

// ============================================================ アプリ本体

async function startApp(user) {
  $('login').hidden = true;
  $('app').hidden = false;
  initAttachments(api, user.id);

  library.initLibrary(api, {
    tree: $('tree'),
    currentDocId: () => outline.currentDoc()?.id,
    onRenamed: () => outline.refreshTitle(),
    onDeleted: (d) => {
      if (outline.currentDoc()?.id === d.id) {
        const next = library.allDocs().find((x) => x.id !== d.id);
        location.hash = next ? `#/d/${next.id}` : '';
        if (!next) route();
      }
    },
  });

  outline.initOutline({
    api,
    library,
    page: $('page'),
    title: $('title'),
    titleNote: $('title-note'),
    outline: $('outline'),
    crumbs: $('crumbs'),
    onStatus: setStatus,
    onTitleChange: () => library.render(),
  });

  setupChrome(user);
  setupToolbar();

  try {
    await library.loadLibrary();
  } catch (err) {
    console.error(err);
    toast('データを読み込めませんでした。Supabase の設定を確認してください', 8000);
    return;
  }
  api.subscribe((table, row) => {
    if (table === 'nodes') outline.applyRemoteNode(row);
    else library.applyRemote(table, row);
  }, (status) => {
    if (status === 'SUBSCRIBED') outline.reloadIfIdle();
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    try { await library.loadLibrary(); } catch {}
    outline.reloadIfIdle();
  });

  addEventListener('hashchange', route);
  await route();
}

let routing = Promise.resolve();
function route() {
  routing = routing.then(doRoute).catch((err) => { console.error(err); toast('読み込みに失敗しました'); });
  return routing;
}

async function doRoute() {
  const m = /^#\/d\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?/.exec(location.hash);
  let docId = m?.[1];
  const zoom = m?.[2] ?? null;
  if (!docId || !library.getDoc(docId)) {
    let last = null;
    try { last = localStorage.getItem(LAST_DOC_KEY); } catch {}
    const d = library.getDoc(last) ?? library.allDocs()[0] ?? await library.createDoc('はじめてのドキュメント');
    location.replace(`#/d/${d.id}`);
    return;
  }
  try { localStorage.setItem(LAST_DOC_KEY, docId); } catch {}
  closeSidebar();
  if (outline.currentDoc()?.id !== docId) await outline.openDoc(library.getDoc(docId), zoom);
  else if (outline.currentZoom() !== zoom) outline.setZoom(zoom);
  $('toggle-checked').textContent = outline.currentDoc().show_checked ? '完了を隠す' : '完了を表示';
  library.render();
  document.title = `${outline.currentDoc().title || '無題'} - Outline Todo`;
}

function setStatus(s) {
  const el = $('status');
  el.dataset.state = s;
  el.textContent = { saving: '保存中…', saved: '保存済み', error: '保存できていません(再試行中)' }[s];
}

function openSidebar() { document.body.classList.add('sidebar-open'); }
function closeSidebar() { document.body.classList.remove('sidebar-open'); }

function setupChrome(user) {
  $('menu-btn').onclick = () => document.body.classList.toggle('sidebar-open');
  $('scrim').onclick = closeSidebar;
  $('new-doc').onclick = async () => {
    const d = await library.createDoc('');
    location.hash = `#/d/${d.id}`;
    setTimeout(() => $('title').focus(), 300);
  };
  $('new-folder').onclick = () => library.newFolder();
  $('toggle-checked').onclick = () => {
    const d = outline.currentDoc();
    if (!d) return;
    outline.setShowChecked(!d.show_checked);
    $('toggle-checked').textContent = d.show_checked ? '完了を隠す' : '完了を表示';
  };
  $('user-email').textContent = user.email ?? '';
  $('logout').onclick = async () => { await outline.flush(); await api.signOut(); };

  // 画面左端からのスワイプでサイドバーを開く
  let sx = null;
  addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX < 24 ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (!sx) return;
    const t = e.touches[0];
    if (t.clientX - sx.x > 60 && Math.abs(t.clientY - sx.y) < 40) { openSidebar(); sx = null; }
  }, { passive: true });
}

// ============================================================ スマホ用ツールバー

function setupToolbar() {
  const bar = $('toolbar');
  const act = (fn) => () => {
    const f = outline.focusForAttach();
    if (!f?.id) return;
    fn(f);
  };
  const buttons = [
    ['⇤', 'アウトデント', act((f) => outline.outdent(f.id))],
    ['⇥', 'インデント', act((f) => outline.indent(f.id))],
    ['↑', '上へ移動', act((f) => outline.moveUp(f.id))],
    ['↓', '下へ移動', act((f) => outline.moveDown(f.id))],
    ['☐', 'チェックボックス', act((f) => outline.toggleCheckbox(f.id))],
    ['✓', '完了', act((f) => outline.toggleChecked(f.id))],
    ['📎', '添付', act((f) => outline.pickFiles({ ...f, field: f.field === 'note' ? 'note' : 'content' }))],
    ['✎', 'メモ', act((f) => outline.toggleNote(f.id, f.field))],
    ['↶', '元に戻す', () => outline.undo()],
    ['↷', 'やり直す', () => outline.redo()],
    ['⌄', '入力を閉じる', () => document.activeElement?.blur()],
  ];
  for (const [label, title, fn] of buttons) {
    const b = h('button', { type: 'button', class: 'tb-btn', title, 'aria-label': title, text: label });
    // ボタンを押してもキーボードが閉じないようにフォーカスを奪わせない
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', fn);
    bar.append(b);
  }
  const editing = () => {
    const a = document.activeElement;
    return !!a && (a.closest?.('#outline') || a.id === 'title-note' || (a.id === 'title' && outline.currentZoom()));
  };
  const update = () => {
    const show = isTouch() && editing();
    bar.hidden = !show;
    document.body.classList.toggle('toolbar-shown', show);
    if (!show || !window.visualViewport) return;
    const vv = window.visualViewport;
    const bottom = window.innerHeight - vv.height - vv.offsetTop;
    bar.style.transform = `translateY(${-Math.max(0, bottom)}px)`;
  };
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => setTimeout(update, 50));
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
}

start();
