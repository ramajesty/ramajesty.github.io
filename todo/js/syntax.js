// 本文中の期日 !(2026-10-15) / !(2026-10-15 14:00) とタグ #仕事 @人名 の読み取り(Dynalist と同じ書き方)

// !(日付[ 時刻][ - 終了][ | 繰り返し]) の形。中身は1行で ")" を含まない
export const DATE_RE = /!\((\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?[^)\n]*\)/g;
// 直前が文字でない位置から始まる #xxx / @xxx
export const TAG_RE = /(^|[\s(（「『、。,])([#@][^\s#@!()（）「」『』、。,.:;"'<>[\]{}]+)/g;

export function parseDue(text) {
  DATE_RE.lastIndex = 0;
  const m = DATE_RE.exec(text);
  DATE_RE.lastIndex = 0;
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(+y, +mo - 1, +d, hh ? +hh : 0, mm ? +mm : 0);
  if (Number.isNaN(date.getTime())) return null;
  return { date, hasTime: !!hh, raw: m[0], index: m.index };
}

export function extractTags(text) {
  const out = new Set();
  for (const m of text.matchAll(TAG_RE)) out.add(m[2].toLowerCase());
  return [...out];
}

// 保存時に本文から期日・タグを取り出して索引用の列にする
export function indexFields(n) {
  const due = parseDue(n.content || '');
  return { due_at: due ? due.date.toISOString() : null, tags: extractTags(`${n.content || ''} ${n.note || ''}`) };
}

const pad = (n) => String(n).padStart(2, '0');
export const toDateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// 今日との差(日数)
export function dayDiff(date, now = new Date()) {
  return Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

// 期日バッジの表示文字と色分け
export function formatDue(due, now = new Date()) {
  const diff = dayDiff(due.date, now);
  const d = due.date;
  let label = d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
  if (diff === 0) label = '今日';
  else if (diff === 1) label = '明日';
  else if (diff === -1) label = '昨日';
  if (due.hasTime) label += ` ${d.getHours()}:${pad(d.getMinutes())}`;
  const state = diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 7 ? 'soon' : 'later';
  return { label, state, diff };
}

// 期日一覧のグループ分け
export function dueGroup(date, now = new Date()) {
  const diff = dayDiff(date, now);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff <= 7) return 'week';
  return 'later';
}

// 本文の期日を差し替える(なければ末尾に足す)。value は 'YYYY-MM-DD' または null(削除)
export function setDueInText(text, value) {
  const due = parseDue(text);
  if (!value) {
    if (!due) return text;
    return (text.slice(0, due.index) + text.slice(due.index + due.raw.length)).replace(/\s{2,}/g, ' ').trim();
  }
  if (due) {
    const time = due.hasTime ? ` ${due.date.getHours()}:${pad(due.date.getMinutes())}` : '';
    return text.slice(0, due.index) + `!(${value}${time})` + text.slice(due.index + due.raw.length);
  }
  return `${text.replace(/\s+$/, '')}${text.trim() ? ' ' : ''}!(${value})`;
}
