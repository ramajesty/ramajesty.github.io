// 開発用: Supabase の代わりにブラウザ内で動く模擬 API(localhost で ?mock を付けたときだけ使う)
import { indexFields } from '../js/syntax.js';
const KEY = 'todo.mock';
const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'dev@example.com' };

export function createMockApi() {
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch {}
  db ||= { folders: {}, documents: {}, nodes: {}, attachments: {} };
  const files = new Map();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  const now = () => new Date().toISOString();
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 30));
  const listeners = [];
  const emit = (table, row) => setTimeout(() => listeners.forEach((l) => l(table, structuredClone(row), 'UPDATE')), 50);
  const upsert = (table, row) => {
    const prev = db[table][row.id];
    db[table][row.id] = { user_id: USER.id, created_at: prev?.created_at ?? now(), ...prev, ...row, updated_at: now() };
    emit(table, db[table][row.id]);
  };
  window.__mockDb = db;
  // 削除されていない文書の、削除されていない項目(documents の名前つき)
  const liveNodes = () => Object.values(db.nodes)
    .filter((n) => !n.deleted_at && db.documents[n.document_id] && !db.documents[n.document_id].deleted_at)
    .map((n) => ({ ...n, documents: { title: db.documents[n.document_id].title, deleted_at: null } }));
  window.__mockRemote = (table, row) => { upsert(table, row); save(); };

  return {
    getUser: async () => (sessionStorage.getItem('mock.signedOut') ? null : USER),
    onAuthChange() {},
    async signIn() { sessionStorage.removeItem('mock.signedOut'); location.reload(); },
    async sendReset() {},
    async updatePassword() {},
    async signOut() { sessionStorage.setItem('mock.signedOut', '1'); location.reload(); },

    listFolders: () => delay(Object.values(db.folders).filter((r) => !r.deleted_at).map((r) => ({ ...r }))),
    listDocuments: () => delay(Object.values(db.documents).filter((r) => !r.deleted_at).map((r) => ({ ...r }))),
    async saveFolder(row) { upsert('folders', row); save(); await delay(); },
    async saveDocument(row) { upsert('documents', row); save(); await delay(); },
    loadNodes: (docId) => delay(Object.values(db.nodes).filter((r) => r.document_id === docId && !r.deleted_at).map((r) => ({ ...r }))),
    async upsertNodes(rows) {
      if (window.__mockFail) { await delay(); throw new Error('mock failure'); }
      for (const r of rows) upsert('nodes', { ...r, ...indexFields(r) });
      save();
      await delay();
    },
    async searchNodes({ words = [], tag = null, includeChecked = false, limit = 300 }) {
      await delay();
      return liveNodes().filter((n) => (includeChecked || !n.checked)
        && words.every((w) => `${n.content}\n${n.note}`.toLowerCase().includes(w.toLowerCase()))
        && (!tag || (n.tags || []).includes(tag))).slice(0, limit);
    },
    async dueNodes({ includeChecked = false }) {
      await delay();
      return liveNodes().filter((n) => n.due_at && (includeChecked || !n.checked)).sort((a, b) => a.due_at.localeCompare(b.due_at));
    },
    async listTags() {
      await delay();
      const counts = new Map();
      for (const n of liveNodes()) if (!n.checked) for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    },
    loadNodesByIds: (ids) => delay(ids.map((id) => db.nodes[id]).filter(Boolean).map((r) => ({ ...r }))),
    async updateNode(id, fields) {
      const n = db.nodes[id];
      upsert('nodes', { ...n, ...fields, ...('content' in fields ? indexFields({ ...n, ...fields }) : {}) });
      save();
      await delay();
    },
    nodesNeedingIndex: () => delay([]),
    loadAttachments: (ids) => delay(ids.map((id) => db.attachments[id]).filter(Boolean).map((r) => ({ ...r }))),
    async insertAttachment(row) { db.attachments[row.id] = { user_id: USER.id, ...row }; save(); await delay(); },
    async uploadFile(path, blob) { files.set(path, blob); await delay(); },
    async signedUrls(paths) {
      await delay();
      return Object.fromEntries(paths.filter((p) => files.has(p)).map((p) => [p, URL.createObjectURL(files.get(p))]));
    },
    async downloadUrl(path) { return URL.createObjectURL(files.get(path) ?? new Blob(['missing'])); },
    subscribe(onChange, onStatus) {
      listeners.push(onChange);
      setTimeout(() => onStatus?.('SUBSCRIBED'), 10);
      return () => {};
    },
  };
}
