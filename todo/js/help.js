// ショートカット一覧
import { h, isMac, isTouch } from './util.js';

const MOD = isMac ? '⌘' : 'Ctrl';
const ALT = isMac ? '⌥' : 'Alt';

const GROUPS = [
  ['よく使う', [
    ['Enter', '下に項目を追加(文の途中なら分割)'],
    ['Tab / Shift+Tab', 'インデント / アウトデント'],
    [`${MOD}+Enter`, '完了 / 未完了'],
    [`${MOD}+Shift+C`, 'チェックボックスを付ける / 消す'],
    ['Shift+Enter', 'メモ欄を開く / 本文に戻る'],
    [`${MOD}+Z / ${MOD}+Shift+Z`, '元に戻す / やり直す'],
  ]],
  ['移動・表示', [
    [`${MOD}+↑ / ${MOD}+↓`, '項目を上 / 下へ移動'],
    [`${MOD}+.`, '折りたたみ / 展開'],
    [`${ALT}+→ / ${ALT}+←`, 'ズームイン / ズームアウト'],
    ['↑ / ↓', '前 / 次の項目へ'],
    ['行頭の点をクリック', 'その項目にズーム'],
    ['行頭の点をドラッグ', '項目を移動'],
    ['行頭の点を右クリック', '項目メニュー'],
  ]],
  ['削除', [
    ['Backspace(行頭で)', '前の項目とつなげる / 空の項目を削除'],
    [`${MOD}+Shift+Backspace`, '項目を子ごと削除'],
  ]],
  ['複数選択', [
    ['項目をまたいでドラッグ', '複数の項目を選択'],
    ['Shift+クリック', 'ここまでを選択'],
    ['行の端で Shift+↑ / ↓', '項目単位の選択に切り替え・範囲を広げる'],
    [`${MOD}+A`, '(選択中に)すべて選択'],
    [`${MOD}+C / ${MOD}+X`, 'コピー / 切り取り(子も含む)'],
    ['Delete', '選択した項目を削除'],
    ['Esc', '選択をやめる'],
  ]],
  ['添付', [
    [`${MOD}+V`, 'スクショやファイルを貼り付け'],
    ['ファイルをドラッグ&ドロップ', 'その位置に添付'],
  ]],
];

const TOUCH = ['スマホ', [
  ['行頭の点をタップ', 'その項目にズーム'],
  ['行頭の点を長押し', '項目メニュー(完了・チェックボックス・複数選択など)'],
  ['画面下のボタン', 'インデント・移動・完了・添付・元に戻す'],
  ['画面の左端から右へスワイプ', 'ドキュメント一覧を開く'],
]];

export function showShortcuts() {
  if (document.querySelector('.shortcuts')) return;
  const groups = isTouch() ? [TOUCH, ...GROUPS] : [...GROUPS, TOUCH];
  // 閉じたら、開く前に編集していた場所へ戻る
  const prev = document.activeElement;
  const sel = getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const close = () => {
    overlay.remove();
    removeEventListener('keydown', onKey, true);
    if (prev && prev !== document.body && prev.isConnected) {
      prev.focus({ preventScroll: true });
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
    }
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal shortcuts', role: 'dialog', 'aria-label': 'ショートカット一覧' },
      h('div', { class: 'shortcuts-head' },
        h('div', { class: 'modal-title', text: 'ショートカット一覧' }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '閉じる', text: '✕', onclick: close })),
      h('div', { class: 'shortcuts-body' },
        groups.map(([title, rows]) => h('section', { class: 'shortcuts-group' },
          h('h3', { text: title }),
          h('dl', {}, rows.flatMap(([keys, desc]) => [h('dt', {}, h('kbd', { text: keys })), h('dd', { text: desc })]))))),
      h('div', { class: 'shortcuts-foot', text: isTouch() ? '右上の「?」でいつでも開けます' : `${MOD}+/ または右上の「?」でいつでも開けます` })));
  addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}
