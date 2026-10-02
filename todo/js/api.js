// Supabase とのやりとりをまとめた層。開発用の mock-api.js も同じ関数を持つ。
import { SUPABASE_URL, SUPABASE_KEY, BUCKET } from './config.js';
import { indexFields } from './syntax.js';

const NODE_COLS = ['id', 'document_id', 'parent_id', 'sort_key', 'content', 'note',
  'checkbox', 'checked', 'collapsed', 'deleted_at'];
const PAGE = 1000;

export function createApi() {
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const must = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  async function fetchAll(build) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const page = must(await build().range(from, from + PAGE - 1));
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  return {
    // ---- 認証
    async getUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((event, session) => cb(event, session?.user ?? null));
    },
    async signIn(email, password) {
      must(await sb.auth.signInWithPassword({ email, password }));
    },
    async sendReset(email) {
      must(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] }));
    },
    async updatePassword(password) {
      must(await sb.auth.updateUser({ password }));
    },
    async signOut() {
      await sb.auth.signOut();
    },

    // ---- フォルダ・ドキュメント
    listFolders: () => fetchAll(() => sb.from('folders').select('*').is('deleted_at', null).order('id')),
    listDocuments: () => fetchAll(() => sb.from('documents').select('*').is('deleted_at', null).order('id')),
    async saveFolder(row) { must(await sb.from('folders').upsert(row)); },
    async saveDocument(row) { must(await sb.from('documents').upsert(row)); },

    // ---- 項目
    loadNodes: (docId) => fetchAll(() => sb.from('nodes').select(NODE_COLS.join(','))
      .eq('document_id', docId).is('deleted_at', null).order('id')),
    async upsertNodes(nodes) {
      // 期日・タグは本文から取り出して索引用の列に入れる(期日一覧・タグ検索用)
      const rows = nodes.map((n) => ({ ...Object.fromEntries(NODE_COLS.map((c) => [c, n[c] ?? null])), ...indexFields(n) }));
      for (let i = 0; i < rows.length; i += 500) {
        must(await sb.from('nodes').upsert(rows.slice(i, i + 500)));
      }
    },

    // ---- 検索・期日一覧・タグ
    // words: すべて含む(本文かメモ), tag: タグ(小文字), includeChecked: 完了も含める
    async searchNodes({ words = [], tag = null, includeChecked = false, limit = 300 }) {
      let q = sb.from('nodes').select(`${NODE_COLS.join(',')},due_at,tags,documents!inner(title,deleted_at)`)
        .is('deleted_at', null).is('documents.deleted_at', null);
      for (const w of words) {
        const v = w.replace(/[,()"\\%*]/g, ' ').trim();
        if (v) q = q.or(`content.ilike."%${v}%",note.ilike."%${v}%"`);
      }
      if (tag) q = q.contains('tags', [tag]);
      if (!includeChecked) q = q.eq('checked', false);
      return must(await q.order('updated_at', { ascending: false }).limit(limit));
    },
    async dueNodes({ includeChecked = false }) {
      let q = sb.from('nodes').select(`${NODE_COLS.join(',')},due_at,tags,documents!inner(title,deleted_at)`)
        .is('deleted_at', null).is('documents.deleted_at', null).not('due_at', 'is', null);
      if (!includeChecked) q = q.eq('checked', false);
      return must(await q.order('due_at').limit(1000));
    },
    // タグと件数(未完了のみ)
    async listTags() {
      const rows = await fetchAll(() => sb.from('nodes').select('tags,documents!inner(deleted_at)')
        .is('deleted_at', null).is('documents.deleted_at', null).eq('checked', false).neq('tags', '{}').order('id'));
      const counts = new Map();
      for (const r of rows) for (const t of r.tags) counts.set(t, (counts.get(t) || 0) + 1);
      return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },
    async loadNodesByIds(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 100) {
        out.push(...must(await sb.from('nodes').select('id,parent_id,content,document_id').in('id', ids.slice(i, i + 100))));
      }
      return out;
    },
    async updateNode(id, fields) {
      const row = { ...fields };
      if ('content' in fields) Object.assign(row, indexFields({ content: fields.content, note: fields.note ?? '' }));
      must(await sb.from('nodes').update(row).eq('id', id));
    },
    // 期日・タグの索引がまだ入っていない古い項目を探す
    async nodesNeedingIndex() {
      return fetchAll(() => sb.from('nodes').select(NODE_COLS.join(','))
        .is('deleted_at', null).is('due_at', null).eq('tags', '{}')
        .or('content.like."*!(*",content.like."*#*",content.like."*@*",note.like."*#*",note.like."*@*"').order('id'));
    },

    // ---- 添付
    async loadAttachments(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 100) {
        out.push(...must(await sb.from('attachments').select('*').in('id', ids.slice(i, i + 100))));
      }
      return out;
    },
    async insertAttachment(row) { must(await sb.from('attachments').insert(row)); },
    async uploadFile(path, blob, contentType) {
      must(await sb.storage.from(BUCKET).upload(path, blob, { contentType, upsert: true }));
    },
    // path -> 期限付きURL
    async signedUrls(paths, seconds = 3600) {
      if (!paths.length) return {};
      const data = must(await sb.storage.from(BUCKET).createSignedUrls(paths, seconds));
      return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
    },
    async downloadUrl(path, fileName, seconds = 3600) {
      const data = must(await sb.storage.from(BUCKET).createSignedUrl(path, seconds, { download: fileName }));
      return data.signedUrl;
    },

    // ---- リアルタイム同期
    subscribe(onChange, onStatus) {
      const ch = sb.channel('db-changes');
      for (const table of ['folders', 'documents', 'nodes']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table },
          (p) => onChange(table, p.new && Object.keys(p.new).length ? p.new : null, p.eventType));
      }
      ch.subscribe((status) => onStatus?.(status));
      return () => sb.removeChannel(ch);
    },
  };
}
