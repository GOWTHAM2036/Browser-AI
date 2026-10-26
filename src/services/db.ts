import Database from '@tauri-apps/plugin-sql';
import { Tab, HistoryItem, Bookmark, Message, ReadingListItem } from '../types';

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    dbInstance = await Database.load('sqlite:aria.db');
  }
  return dbInstance;
}

// === TABS SESSION ===
export async function dbLoadTabs(): Promise<Tab[]> {
  try {
    const db = await getDb();
    const rows = await db.select<any[]>('SELECT * FROM tabs ORDER BY position ASC');
    return rows.map(r => ({
      id: r.id,
      url: r.url,
      title: r.title,
      favicon: r.favicon || undefined,
      position: r.position,
      pinned: r.pinned === 1,
      loading: false
    }));
  } catch (e) {
    console.error('Failed to load tabs from DB', e);
    return [];
  }
}

export async function dbSaveTab(tab: Tab): Promise<void> {
  try {
    const db = await getDb();
    await db.execute(
      `INSERT INTO tabs (id, url, title, favicon, position, pinned, last_active) 
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET 
         url = excluded.url,
         title = excluded.title,
         favicon = excluded.favicon,
         position = excluded.position,
         pinned = excluded.pinned,
         last_active = excluded.last_active`,
      [tab.id, tab.url, tab.title, tab.favicon || null, tab.position, tab.pinned ? 1 : 0, Date.now()]
    );
  } catch (e) {
    console.error('Failed to save tab to DB', e);
  }
}

export async function dbDeleteTab(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.execute('DELETE FROM tabs WHERE id = ?', [id]);
  } catch (e) {
    console.error('Failed to delete tab from DB', e);
  }
}

export async function dbClearTabs(): Promise<void> {
  try {
    const db = await getDb();
    await db.execute('DELETE FROM tabs');
  } catch (e) {
    console.error('Failed to clear tabs from DB', e);
  }
}

// === HISTORY ===
export async function dbAddHistory(url: string, title: string): Promise<void> {
  if (url === 'about:blank' || url.startsWith('aria://')) return;
  try {
    const db = await getDb();
    const id = btoa(url).replace(/=/g, '');
    const now = Date.now();
    await db.execute(
      `INSERT INTO history (id, url, title, visited_at, visit_count) 
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET 
         title = excluded.title,
         visited_at = excluded.visited_at,
         visit_count = visit_count + 1`,
      [id, url, title || url, now]
    );
  } catch (e) {
    console.error('Failed to add history', e);
  }
}

export async function dbGetHistory(): Promise<HistoryItem[]> {
  try {
    const db = await getDb();
    return await db.select<HistoryItem[]>('SELECT * FROM history ORDER BY visited_at DESC LIMIT 500');
  } catch (e) {
    console.error('Failed to get history', e);
    return [];
  }
}

export async function dbClearHistory(): Promise<void> {
  try {
    const db = await getDb();
    await db.execute('DELETE FROM history');
  } catch (e) {
    console.error('Failed to clear history', e);
  }
}

// === BOOKMARKS ===
export async function dbGetBookmarks(): Promise<Bookmark[]> {
  try {
    const db = await getDb();
    return await db.select<Bookmark[]>('SELECT * FROM bookmarks ORDER BY created_at DESC');
  } catch (e) {
    console.error('Failed to get bookmarks', e);
    return [];
  }
}

export async function dbAddBookmark(url: string, title: string, favicon?: string): Promise<Bookmark> {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    const db = await getDb();
    await db.execute(
      `INSERT INTO bookmarks (id, url, title, favicon, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, url, title || url, favicon || null, now]
    );
  } catch (e) {
    console.error('Failed to add bookmark to DB', e);
  }
  return { id, url, title, favicon, created_at: now };
}

export async function dbDeleteBookmark(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.execute('DELETE FROM bookmarks WHERE id = ?', [id]);
  } catch (e) {
    console.error('Failed to delete bookmark', e);
  }
}

// === AI CHATS ===
export async function dbGetChatHistory(tabId: string): Promise<Message[]> {
  try {
    const db = await getDb();
    const rows = await db.select<any[]>('SELECT * FROM ai_chats WHERE tab_id = ? ORDER BY created_at ASC', [tabId]);
    return rows.map(r => ({
      id: r.id,
      tab_id: r.tab_id,
      role: r.role as 'user' | 'assistant' | 'system',
      content: r.content,
      provider: r.provider,
      model: r.model,
      created_at: r.created_at
    }));
  } catch (e) {
    console.error('Failed to load chat history', e);
    return [];
  }
}

export async function dbAddChatMessage(msg: Omit<Message, 'id' | 'created_at'>): Promise<Message> {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    const db = await getDb();
    await db.execute(
      `INSERT INTO ai_chats (id, tab_id, role, content, provider, model, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, msg.tab_id, msg.role, msg.content, msg.provider, msg.model, now]
    );
  } catch (e) {
    console.error('Failed to add chat message to DB', e);
  }
  return { id, ...msg, created_at: now };
}

export async function dbClearChatHistory(tabId: string): Promise<void> {
  try {
    const db = await getDb();
    await db.execute('DELETE FROM ai_chats WHERE tab_id = ?', [tabId]);
  } catch (e) {
    console.error('Failed to clear chat history', e);
  }
}

// === READING LIST ===
export async function dbGetReadingList(): Promise<ReadingListItem[]> {
  try {
    const db = await getDb();
    const rows = await db.select<any[]>('SELECT * FROM reading_list ORDER BY saved_at DESC');
    return rows.map(r => ({
      id: r.id,
      url: r.url,
      title: r.title,
      excerpt: r.excerpt || undefined,
      saved_at: r.saved_at,
      read: r.read === 1
    }));
  } catch (e) {
    console.error('Failed to get reading list', e);
    return [];
  }
}

export async function dbAddReadingListItem(url: string, title: string, excerpt?: string): Promise<ReadingListItem> {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    const db = await getDb();
    await db.execute(
      `INSERT INTO reading_list (id, url, title, excerpt, saved_at, read) 
       VALUES (?, ?, ?, ?, ?, 0)`,
      [id, url, title || url, excerpt || null, now]
    );
  } catch (e) {
    console.error('Failed to add reading list item to DB', e);
  }
  return { id, url, title, excerpt, saved_at: now, read: false };
}

export async function dbMarkReadingListRead(id: string, read: boolean): Promise<void> {
  try {
    const db = await getDb();
    await db.execute('UPDATE reading_list SET read = ? WHERE id = ?', [read ? 1 : 0, id]);
  } catch (e) {
    console.error('Failed to mark read', e);
  }
}

export async function dbDeleteReadingListItem(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.execute('DELETE FROM reading_list WHERE id = ?', [id]);
  } catch (e) {
    console.error('Failed to delete reading list item', e);
  }
}
