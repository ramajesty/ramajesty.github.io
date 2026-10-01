// 貼り付けられた内容を、階層つきの項目の並び [{ level, text }] に変換する。
// Dynalist などは HTML の入れ子リスト(ul/li)とテキストの字下げの両方で階層を持つので、
// HTML にリストがあればそれを使い、なければテキストの字下げを読む。

const linkText = (label, href) => {
  label = label.replace(/\s+/g, ' ').trim();
  if (!/^https?:\/\//.test(href || '')) return label;
  if (!label || label === href) return href;
  return `[${label.replace(/[[\]]/g, '')}](${href})`;
};

// li の中身(入れ子リストを除く)を1行の本文にする
function inlineText(node) {
  let s = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) s += c.data;
    else if (c.nodeType !== 1) continue;
    else if (c.tagName === 'UL' || c.tagName === 'OL') continue;
    else if (c.tagName === 'A') s += linkText(c.textContent, c.getAttribute('href'));
    else if (c.tagName === 'BR') s += ' ';
    else s += inlineText(c);
  }
  return s;
}

function fromHtml(html) {
  if (!html || !/<li[\s>]/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items = [];
  const walkList = (list, level) => {
    for (const c of list.children) {
      if (c.tagName === 'LI') {
        const box = [...c.querySelectorAll('input[type=checkbox]')].find((i) => i.closest('li') === c);
        items.push({
          level, text: inlineText(c).replace(/\s+/g, ' ').trim(),
          ...(box && { checkbox: true, checked: box.hasAttribute('checked') }),
        });
        for (const sub of c.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') walkList(sub, level + 1);
      } else if (c.tagName === 'UL' || c.tagName === 'OL') {
        walkList(c, level + 1);
      }
    }
  };
  for (const list of doc.body.querySelectorAll('ul, ol')) {
    if (!list.parentElement.closest('ul, ol')) walkList(list, 0);
  }
  const out = items.filter((it) => it.text !== '');
  return out.length ? normalize(out) : null;
}

function fromText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  const items = lines.map((l) => {
    const m = /^([^\S\n]*)(?:[-*+•・]\s+|\d+[.)]\s+)?(.*)$/.exec(l);
    const indent = [...m[1]].reduce((w, ch) => w + (ch === '\t' ? 4 : ch === '　' ? 2 : 1), 0);
    const cb = /^\[([ xX])\]\s+(.*)$/.exec(m[2]);
    if (cb) return { indent, text: cb[2].trimEnd(), checkbox: true, checked: cb[1] !== ' ' };
    return { indent, text: m[2].trimEnd() };
  });
  // 字下げの幅を階層の深さに直す(幅が不揃いでも、深くなった・浅くなったで判断する)
  const widths = [];
  return normalize(items.map((it) => {
    while (widths.length && it.indent < widths.at(-1)) widths.pop();
    if (!widths.length || it.indent > widths.at(-1)) widths.push(it.indent);
    return { ...it, level: widths.length - 1 };
  }));
}

// 1つ前より2段以上深くならないようにし、最も浅い段を0にそろえる
function normalize(items) {
  const min = Math.min(...items.map((it) => it.level));
  let prev = -1;
  return items.map((it) => {
    const level = Math.min(it.level - min, prev + 1);
    prev = level;
    return { ...it, level };
  });
}

// 1つのリンクだけをコピーしたときは [表示名](URL) にする
function singleLink(html, text) {
  if (!html || !/<a[\s>]/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links = doc.body.querySelectorAll('a[href]');
  if (links.length !== 1) return null;
  const a = links[0];
  if (a.textContent.replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim()) return null;
  return linkText(a.textContent, a.getAttribute('href'));
}

export const CLIP_MIME = 'application/x-outline-todo';

export function parseClipboard(dt) {
  // このアプリ内でコピーしたものは、メモ・チェック状態も含めてそのまま使う
  try {
    const own = JSON.parse(dt.getData(CLIP_MIME) || 'null');
    if (Array.isArray(own) && own.length) return own;
  } catch {}
  const html = dt.getData('text/html');
  const text = dt.getData('text/plain') || '';
  const fromList = fromHtml(html);
  if (fromList && fromList.length > 1) return fromList;
  const items = fromText(text);
  if (items.length === 1) {
    const link = singleLink(html, text);
    if (link) return [{ level: 0, text: link }];
  }
  if (!items.length && fromList) return fromList;
  return items;
}
