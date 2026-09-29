// 添付ファイル: 圧縮・アップロード・チップ表示・拡大表示
import { h, uuid, toast, formatBytes } from './util.js';

const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX = 1600;
const THUMB_MAX = 200;
const URL_TTL = 3600;

let api;
let userId;
// id -> { row, thumbUrl, url, expires, status: 'loading'|'uploading'|'ready'|'error'|'missing', localUrl, retry }
const cache = new Map();

export function initAttachments(apiRef, uid) {
  api = apiRef;
  userId = uid;
}

// ---------- 表示

export function makeChip(id) {
  const el = h('span', { class: 'att', contenteditable: 'false', 'data-att': id });
  paintChip(el, id);
  return el;
}

function paintChip(el, id) {
  const e = cache.get(id);
  el.textContent = '';
  el.className = 'att';
  el.title = '';
  if (!e || e.status === 'loading') {
    el.classList.add('att-loading');
    el.append(h('span', { class: 'att-spin' }));
    return;
  }
  if (e.status === 'missing') {
    el.classList.add('att-file', 'att-error');
    el.append('⚠ 添付が見つかりません');
    return;
  }
  const isImage = e.row?.mime_type?.startsWith('image/');
  if (isImage && (e.thumbUrl || e.localUrl)) {
    el.classList.add('att-image');
    el.append(h('img', { src: e.localUrl || e.thumbUrl, alt: e.row.file_name, draggable: 'false' }));
  } else {
    el.classList.add('att-file');
    el.append(h('span', { class: 'att-icon', text: '📎' }), h('span', { class: 'att-name', text: e.row?.file_name || 'ファイル' }));
  }
  el.title = e.row ? `${e.row.file_name} (${formatBytes(e.row.size)})` : '';
  if (e.status === 'uploading') {
    el.classList.add('att-uploading');
    el.append(h('span', { class: 'att-spin' }));
  } else if (e.status === 'error') {
    el.classList.add('att-error');
    el.append(h('button', { class: 'att-retry', type: 'button', text: '再試行' }));
  }
}

function repaint(id) {
  for (const el of document.querySelectorAll(`.att[data-att="${id}"]`)) paintChip(el, id);
}

// 画面内のチップに必要な情報(行データ・期限付きURL)を取得する
export async function ensureLoaded(ids) {
  const now = Date.now();
  const need = [...new Set(ids)].filter((id) => {
    const e = cache.get(id);
    if (!e) return true;
    return e.status === 'ready' && !e.localUrl && e.expires < now + 60_000;
  });
  if (!need.length) return;
  for (const id of need) if (!cache.has(id)) cache.set(id, { status: 'loading' });
  try {
    const rows = await api.loadAttachments(need);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const paths = [];
    for (const r of rows) {
      if (r.thumb_path) paths.push(r.thumb_path);
      if (r.mime_type.startsWith('image/') || r.mime_type === 'application/pdf') paths.push(r.storage_path);
    }
    const urls = await api.signedUrls(paths, URL_TTL);
    for (const id of need) {
      const r = byId.get(id);
      const prev = cache.get(id);
      if (prev?.status === 'uploading' || prev?.status === 'error') continue;
      if (!r) { cache.set(id, { status: 'missing' }); repaint(id); continue; }
      cache.set(id, {
        row: r,
        status: 'ready',
        thumbUrl: urls[r.thumb_path] || urls[r.storage_path],
        url: urls[r.storage_path],
        expires: Date.now() + URL_TTL * 1000,
      });
      repaint(id);
    }
  } catch (err) {
    console.error(err);
    for (const id of need) if (cache.get(id)?.status === 'loading') cache.delete(id);
  }
}

// ---------- 開く

export async function openAttachment(id) {
  const e = cache.get(id);
  if (!e?.row) return;
  const isImage = e.row.mime_type.startsWith('image/');
  if (isImage) return showLightbox(e.localUrl || e.url, e.row.file_name);
  if (e.row.mime_type === 'application/pdf' && e.url) return void window.open(e.url, '_blank', 'noopener');
  // ポップアップブロック対策に、先に窓を開けてから URL を入れる
  const w = window.open('', '_blank');
  try {
    const url = await api.downloadUrl(e.row.storage_path, e.row.file_name);
    if (w) w.location.href = url; else location.href = url;
  } catch (err) {
    w?.close();
    toast('ファイルを開けませんでした');
  }
}

function showLightbox(src, name) {
  if (!src) return;
  const box = h('div', { class: 'lightbox', onclick: () => box.remove() },
    h('img', { src, alt: name }),
    h('div', { class: 'lightbox-name', text: name }));
  const onKey = (e) => { if (e.key === 'Escape') { box.remove(); removeEventListener('keydown', onKey, true); } };
  addEventListener('keydown', onKey, true);
  document.body.append(box);
}

export function handleChipClick(chip) {
  const id = chip.dataset.att;
  const e = cache.get(id);
  if (e?.status === 'error' && e.retry) return e.retry();
  openAttachment(id);
}

// ---------- アップロード

// ファイルを受け付け、すぐに本文へ入れるマーカーの ID を返す(アップロードは裏で続く)
export function startUpload(file, nodeId) {
  if (file.size > MAX_BYTES && !file.type.startsWith('image/')) {
    toast(`${file.name} は20MBを超えるため添付できません`);
    return null;
  }
  const id = uuid();
  const localUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
  const entry = {
    status: 'uploading',
    localUrl,
    row: { id, file_name: file.name || 'image', mime_type: file.type || 'application/octet-stream', size: file.size },
  };
  cache.set(id, entry);
  const run = async () => {
    entry.status = 'uploading';
    repaint(id);
    try {
      await upload(id, file, nodeId, entry);
      entry.status = 'ready';
      entry.expires = Infinity;
    } catch (err) {
      console.error(err);
      entry.status = 'error';
      toast('添付のアップロードに失敗しました。チップの「再試行」を押してください');
    }
    repaint(id);
  };
  entry.retry = run;
  run();
  return id;
}

async function upload(id, file, nodeId, entry) {
  let blob = file;
  let thumb = null;
  let width = null;
  let height = null;
  let mime = file.type || 'application/octet-stream';
  if (isCompressible(mime)) {
    try {
      ({ blob, thumb, width, height } = await compressImage(file));
      mime = blob.type || mime;
    } catch (err) {
      // 読めない形式(ブラウザが HEIC 非対応など)は元のまま保存する
      console.warn('compress failed', err);
    }
  }
  if (blob.size > MAX_BYTES) throw new Error('too large');
  const base = `${userId}/${id}`;
  const ext = extFor(mime, file.name);
  const storagePath = `${base}/original.${ext}`;
  await api.uploadFile(storagePath, blob, mime);
  let thumbPath = null;
  if (thumb) {
    thumbPath = `${base}/thumb.${extFor(thumb.type)}`;
    await api.uploadFile(thumbPath, thumb, thumb.type);
  }
  const row = {
    id, node_id: nodeId, file_name: renameForType(file.name || 'image', ext), mime_type: mime,
    size: blob.size, storage_path: storagePath, thumb_path: thumbPath, width, height,
  };
  await api.insertAttachment(row);
  entry.row = row;
}

const isCompressible = (mime) => /^image\/(png|jpeg|webp|bmp|heic|heif)$/.test(mime);

async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const width = bmp.width;
  const height = bmp.height;
  const blob = await encode(bmp, IMAGE_MAX, 0.8);
  const thumb = await encode(bmp, THUMB_MAX, 0.7);
  bmp.close?.();
  // 元のほうが小さければ元を使う(JPEG写真を再圧縮で太らせない)
  const useOriginal = file.size <= blob.size && Math.max(width, height) <= IMAGE_MAX && /jpeg|webp/.test(file.type);
  return { blob: useOriginal ? file : blob, thumb, width, height };
}

async function encode(bmp, max, quality) {
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let out = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality));
  if (!out || out.type !== 'image/webp') {
    // WebP 非対応(古い Safari)なら白背景の JPEG
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality + 0.05));
  }
  return out;
}

function extFor(mime, name = '') {
  const map = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'application/pdf': 'pdf' };
  if (map[mime]) return map[mime];
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : 'bin';
}

function renameForType(name, ext) {
  if (!/^(webp|jpg)$/.test(ext)) return name;
  const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return `${base}.${ext}`;
}
