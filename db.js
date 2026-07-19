const { Pool } = require('pg');

const dbUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;

const pool = dbUrl ? new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
}) : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client', err);
  });
}

async function initDatabase() {
  if (!pool) {
    console.log('⚠️ لا يوجد رابط قاعدة بيانات - التخزين سيكون مؤقتاً');
    return false;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spy_config (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS spy_auth_state (
        id SERIAL PRIMARY KEY,
        step TEXT,
        phone_code_hash TEXT,
        phone_number TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS spy_processed_links (
        id SERIAL PRIMARY KEY,
        link TEXT UNIQUE NOT NULL,
        time BIGINT
      );
      CREATE TABLE IF NOT EXISTS spy_log (
        id SERIAL PRIMARY KEY,
        source TEXT,
        original_link TEXT,
        affiliate_link TEXT,
        title TEXT,
        price TEXT,
        status TEXT,
        error TEXT,
        timestamp TIMESTAMP DEFAULT NOW(),
        data JSONB
      );
      CREATE TABLE IF NOT EXISTS telegram_session (
        id SERIAL PRIMARY KEY,
        session_key TEXT UNIQUE NOT NULL,
        session_data TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS gemini_keys (
        id SERIAL PRIMARY KEY,
        key_index INTEGER,
        api_key TEXT
      );
      CREATE TABLE IF NOT EXISTS saved_posts (
        id SERIAL PRIMARY KEY,
        post_id TEXT UNIQUE,
        channel_id TEXT,
        title TEXT,
        price TEXT,
        link TEXT,
        affiliate_link TEXT,
        image_url TEXT,
        coupon TEXT,
        message TEXT,
        hook TEXT,
        saved_at TIMESTAMP DEFAULT NOW(),
        data JSONB
      );
      CREATE TABLE IF NOT EXISTS app_storage (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS republish_campaigns (
        id SERIAL PRIMARY KEY,
        name TEXT,
        channel_choice TEXT DEFAULT 'both',
        min_minutes INTEGER DEFAULT 30,
        max_minutes INTEGER DEFAULT 90,
        active_hours_start INTEGER,
        active_hours_end INTEGER,
        max_count INTEGER,
        regenerate_ai BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'active',
        total_published INTEGER DEFAULT 0,
        queue JSONB DEFAULT '[]'::jsonb,
        position INTEGER DEFAULT 0,
        next_run_at TIMESTAMP,
        last_run_at TIMESTAMP,
        credentials JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS republish_log (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES republish_campaigns(id) ON DELETE CASCADE,
        saved_post_id TEXT,
        status TEXT,
        error TEXT,
        published_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_posts' AND column_name='post_id') THEN
          ALTER TABLE saved_posts ADD COLUMN post_id TEXT UNIQUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_posts' AND column_name='message') THEN
          ALTER TABLE saved_posts ADD COLUMN message TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_posts' AND column_name='hook') THEN
          ALTER TABLE saved_posts ADD COLUMN hook TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_posts' AND column_name='created_at') THEN
          ALTER TABLE saved_posts ADD COLUMN created_at TIMESTAMP DEFAULT NOW();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_posts' AND column_name='image_data') THEN
          ALTER TABLE saved_posts ADD COLUMN image_data BYTEA;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_posts' AND column_name='image_mime') THEN
          ALTER TABLE saved_posts ADD COLUMN image_mime TEXT;
        END IF;
      END $$;
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_spy_processed_links_time ON spy_processed_links(time DESC);
      CREATE INDEX IF NOT EXISTS idx_spy_log_timestamp ON spy_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_saved_posts_saved_at ON saved_posts(saved_at DESC);
    `);
    console.log('✅ تم إنشاء/التحقق من جداول قاعدة البيانات بنجاح');
    return true;
  } catch (e) {
    console.error('❌ فشل إنشاء الجداول:', e.message);
    return false;
  }
}

async function query(text, params) {
  if (!pool) throw new Error('No database connection');
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.log(`⏱️  Slow query (${duration}ms): ${text.substring(0, 50)}...`);
    }
    return result;
  } catch (error) {
    console.error('❌ Database query error:', error.message);
    throw error;
  }
}

async function getConfig() {
  try {
    const result = await query('SELECT key, value FROM spy_config');
    const config = {};
    result.rows.forEach(row => {
      try {
        config[row.key] = JSON.parse(row.value);
      } catch {
        config[row.key] = row.value;
      }
    });
    return config;
  } catch (e) {
    console.log('⚠️ Failed to load config from database:', e.message);
    return {};
  }
}

async function saveConfig(config) {
  try {
    let savedCount = 0;
    for (const [key, value] of Object.entries(config)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      const result = await query(
        'INSERT INTO spy_config (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
        [key, valueStr]
      );
      savedCount++;
    }
    console.log(`✅ Saved ${savedCount} config entries to database`);
    return true;
  } catch (e) {
    console.log('❌ Failed to save config to database:', e.message);
    console.log('Error details:', e);
    return false;
  }
}

async function getAuthState() {
  try {
    const result = await query('SELECT * FROM spy_auth_state ORDER BY id DESC LIMIT 1');
    if (result.rows.length === 0) {
      return { step: 'idle', phoneCodeHash: null };
    }
    const row = result.rows[0];
    return {
      step: row.step,
      phoneCodeHash: row.phone_code_hash,
      phoneNumber: row.phone_number,
    };
  } catch (e) {
    console.log('⚠️ Failed to load auth state:', e.message);
    return { step: 'idle', phoneCodeHash: null };
  }
}

async function saveAuthState(state) {
  try {
    await query(
      'INSERT INTO spy_auth_state (step, phone_code_hash, phone_number, updated_at) VALUES ($1, $2, $3, NOW())',
      [state.step, state.phoneCodeHash, state.phoneNumber]
    );
    return true;
  } catch (e) {
    console.log('⚠️ Failed to save auth state:', e.message);
    return false;
  }
}

async function getProcessedLinks() {
  try {
    const now = Date.now();
    const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
    
    // Delete old entries
    await query('DELETE FROM spy_processed_links WHERE time < $1', [twentyFourHoursAgo]);
    
    // Get remaining
    const result = await query('SELECT link, time FROM spy_processed_links ORDER BY time DESC LIMIT 10000');
    return result.rows.map(row => ({ link: row.link, time: row.time }));
  } catch (e) {
    console.log('⚠️ Failed to load processed links:', e.message);
    return [];
  }
}

async function addProcessedLink(link) {
  try {
    await query(
      'INSERT INTO spy_processed_links (link, time) VALUES ($1, $2) ON CONFLICT (link) DO NOTHING',
      [link, Date.now()]
    );
    return true;
  } catch (e) {
    console.log('⚠️ Failed to add processed link:', e.message);
    return false;
  }
}

async function isLinkProcessed(link) {
  try {
    const result = await query('SELECT id FROM spy_processed_links WHERE link = $1 LIMIT 1', [link]);
    return result.rows.length > 0;
  } catch (e) {
    console.log('⚠️ Failed to check processed link:', e.message);
    return false;
  }
}

async function addLogEntry(entry) {
  try {
    await query(
      `INSERT INTO spy_log (source, original_link, affiliate_link, title, price, status, error, timestamp, data) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
      [
        entry.source,
        entry.originalLink,
        entry.affiliateLink,
        entry.title,
        entry.price,
        entry.status,
        entry.error,
        JSON.stringify(entry)
      ]
    );
    return true;
  } catch (e) {
    console.log('⚠️ Failed to add log entry:', e.message);
    return false;
  }
}

async function deleteLogEntry(id) {
  try {
    await query('DELETE FROM spy_log WHERE id = $1', [id]);
    return true;
  } catch (e) {
    console.log('⚠️ Failed to delete log entry:', e.message);
    return false;
  }
}

async function clearLog() {
  try {
    await query('DELETE FROM spy_log', []);
    return true;
  } catch (e) {
    console.log('⚠️ Failed to clear log:', e.message);
    return false;
  }
}

async function getLog(limit = 200) {
  try {
    const result = await query(
      'SELECT * FROM spy_log ORDER BY timestamp DESC LIMIT $1',
      [limit]
    );
    return result.rows.map(row => {
      let extraData = {};
      try {
        if (row.data) {
          extraData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        }
      } catch {}
      return {
        id: row.id,
        source: row.source,
        originalLink: row.original_link,
        affiliateLink: row.affiliate_link,
        title: row.title,
        price: row.price,
        status: row.status,
        error: row.error,
        timestamp: row.timestamp,
        image: extraData.image || null,
        targets: extraData.targets || [],
        message: extraData.message || null,
      };
    });
  } catch (e) {
    console.log('⚠️ Failed to load log:', e.message);
    return [];
  }
}

async function getTelegramSession(key = 'default') {
  try {
    const result = await query('SELECT session_data FROM telegram_session WHERE session_key = $1', [key]);
    if (result.rows.length === 0) return '';
    return result.rows[0].session_data;
  } catch (e) {
    console.log('⚠️ Failed to load telegram session:', e.message);
    return '';
  }
}

async function saveTelegramSession(sessionData, key = 'default') {
  try {
    await query(
      'INSERT INTO telegram_session (session_key, session_data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (session_key) DO UPDATE SET session_data = $2, updated_at = NOW()',
      [key, sessionData]
    );
    return true;
  } catch (e) {
    console.log('⚠️ Failed to save telegram session:', e.message);
    return false;
  }
}

async function saveGeminiKeys(keys) {
  try {
    await query('BEGIN');
    await query('DELETE FROM gemini_keys');
    for (let i = 0; i < keys.length; i++) {
      await query(
        'INSERT INTO gemini_keys (key_index, api_key) VALUES ($1, $2)',
        [i, keys[i]]
      );
    }
    await query('COMMIT');
    return true;
  } catch (e) {
    try { await query('ROLLBACK'); } catch (re) {}
    console.log('⚠️ Failed to save gemini keys:', e.message);
    return false;
  }
}

async function getGeminiKeys() {
  try {
    const result = await query('SELECT api_key FROM gemini_keys ORDER BY key_index ASC');
    return result.rows.map(row => row.api_key);
  } catch (e) {
    console.log('⚠️ Failed to load gemini keys:', e.message);
    return [];
  }
}

function stripIntroBlockquote(text) {
  if (!text || typeof text !== 'string') return text;
  // Remove the leading <blockquote>...</blockquote> intro (and its trailing blank lines)
  return text.replace(/^\s*<blockquote>[\s\S]*?<\/blockquote>\s*\n*/i, '').trimStart();
}

async function addSavedPost(post) {
  try {
    const postId = post.id || post.post_id || Date.now().toString();
    const savedAt = post.savedAt || post.createdAt || new Date().toISOString();
    if (post.message) post.message = stripIntroBlockquote(post.message);
    let imageBuffer = null;
    let imageMime = post.imageMime || post.image_mime || null;
    if (post.imageBuffer && Buffer.isBuffer(post.imageBuffer)) {
      imageBuffer = post.imageBuffer;
    } else if (typeof post.imageBase64 === 'string' && post.imageBase64.length > 0) {
      try { imageBuffer = Buffer.from(post.imageBase64, 'base64'); } catch (e) {}
    }
    if (imageBuffer && !imageMime) imageMime = 'image/jpeg';
    const persistedRef = post.image || post.imageUrl || post.image_url || null;
    const dataPayload = { ...post };
    delete dataPayload.imageBuffer;
    delete dataPayload.imageBase64;
    await query(
      `INSERT INTO saved_posts (post_id, channel_id, title, price, link, affiliate_link, image_url, coupon, message, hook, saved_at, created_at, data, image_data, image_mime) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14)
       ON CONFLICT (post_id) DO NOTHING`,
      [
        postId,
        post.channelId || post.channel_id || null,
        post.title,
        post.price,
        post.link,
        post.affiliateLink || post.affiliate_link || null,
        persistedRef,
        post.coupon || null,
        post.message || null,
        post.hook || null,
        savedAt,
        JSON.stringify(dataPayload),
        imageBuffer,
        imageMime
      ]
    );
    return true;
  } catch (e) {
    console.log('⚠️ Failed to save post:', e.message);
    return false;
  }
}

async function getSavedPosts(limit = null) {
  try {
    const sql = limit ? 'SELECT * FROM saved_posts ORDER BY saved_at DESC LIMIT $1' : 'SELECT * FROM saved_posts ORDER BY saved_at DESC';
    const params = limit ? [limit] : [];
    const result = await query(sql, params);
    return result.rows.map(row => {
      const postId = row.post_id || String(row.id);
      const hasBlob = row.image_data && row.image_data.length > 0;
      const image = hasBlob
        ? `/api/saved-posts/${encodeURIComponent(postId)}/image`
        : row.image_url;
      return {
        id: postId,
        title: row.title,
        price: row.price,
        link: row.link,
        image,
        imageOriginal: row.image_url,
        hasImageBlob: !!hasBlob,
        coupon: row.coupon,
        message: row.message,
        hook: row.hook,
        createdAt: row.created_at || row.saved_at,
        savedAt: row.saved_at,
      };
    });
  } catch (e) {
    console.log('⚠️ Failed to load saved posts:', e.message);
    return [];
  }
}

async function updateSavedPost(postId, updates) {
  try {
    if (updates && updates.message) updates.message = stripIntroBlockquote(updates.message);
    const fields = [];
    const values = [];
    let i = 1;
    const map = {
      title: 'title', price: 'price', link: 'link',
      affiliateLink: 'affiliate_link', affiliate_link: 'affiliate_link',
      image: 'image_url', imageUrl: 'image_url', image_url: 'image_url',
      coupon: 'coupon', message: 'message', hook: 'hook'
    };
    const imageKeys = ['image', 'imageUrl', 'image_url'];
    const imageBeingUpdated = imageKeys.some(k => updates[k] !== undefined);
    for (const [k, col] of Object.entries(map)) {
      if (updates[k] !== undefined) {
        if (fields.find(f => f.startsWith(col + ' ='))) continue;
        fields.push(`${col} = $${i++}`);
        values.push(updates[k]);
      }
    }
    if (imageBeingUpdated) {
      fields.push(`image_data = NULL`);
      fields.push(`image_mime = NULL`);
    }
    if (fields.length === 0) return true;
    values.push(postId);
    await query(`UPDATE saved_posts SET ${fields.join(', ')} WHERE post_id = $${i}`, values);
    return true;
  } catch (e) {
    console.log('⚠️ Failed to update saved post:', e.message);
    return false;
  }
}

async function deleteSavedPostsBefore(date) {
  try {
    await query('DELETE FROM saved_posts WHERE COALESCE(created_at, saved_at) < $1', [date]);
    return true;
  } catch (e) {
    console.log('⚠️ Failed to delete saved posts before date:', e.message);
    return false;
  }
}

async function deleteSavedPost(postId) {
  try {
    await query('DELETE FROM saved_posts WHERE post_id = $1', [postId]);
    return true;
  } catch (e) {
    console.log('⚠️ Failed to delete saved post:', e.message);
    return false;
  }
}

async function clearSavedPosts() {
  try {
    await query('DELETE FROM saved_posts');
    return true;
  } catch (e) {
    console.log('⚠️ Failed to clear saved posts:', e.message);
    return false;
  }
}

async function setAppStorage(key, value) {
  try {
    await query(
      'INSERT INTO app_storage (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
      [key, value]
    );
    return true;
  } catch (e) {
    console.log('⚠️ Failed to set app storage:', e.message);
    return false;
  }
}

async function getAppStorage(key) {
  try {
    const result = await query('SELECT value FROM app_storage WHERE key = $1', [key]);
    if (result.rows.length === 0) return null;
    return result.rows[0].value;
  } catch (e) {
    console.log('⚠️ Failed to get app storage:', e.message);
    return null;
  }
}

// ===== Republish Campaigns =====
async function createRepublishCampaign(c) {
  const r = await query(
    `INSERT INTO republish_campaigns
       (name, channel_choice, min_minutes, max_minutes, active_hours_start, active_hours_end,
        max_count, regenerate_ai, status, queue, position, next_run_at, credentials)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9::jsonb,0,$10,$11::jsonb)
     RETURNING *`,
    [
      c.name || `حملة ${new Date().toLocaleString('ar')}`,
      c.channelChoice || 'both',
      c.minMinutes || 30,
      c.maxMinutes || 90,
      c.activeHoursStart ?? null,
      c.activeHoursEnd ?? null,
      c.maxCount || null,
      !!c.regenerateAi,
      JSON.stringify(c.queue || []),
      c.nextRunAt || new Date(),
      c.credentials ? JSON.stringify(c.credentials) : null,
    ]
  );
  return r.rows[0];
}

async function listRepublishCampaigns() {
  const r = await query('SELECT * FROM republish_campaigns ORDER BY created_at DESC');
  return r.rows;
}

async function getRepublishCampaign(id) {
  const r = await query('SELECT * FROM republish_campaigns WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function updateRepublishCampaign(id, updates) {
  const map = {
    status: 'status', position: 'position', total_published: 'total_published',
    next_run_at: 'next_run_at', last_run_at: 'last_run_at', queue: 'queue',
  };
  const fields = []; const values = []; let i = 1;
  for (const [k, col] of Object.entries(map)) {
    if (updates[k] !== undefined) {
      const isJson = col === 'queue';
      fields.push(`${col} = $${i++}${isJson ? '::jsonb' : ''}`);
      values.push(isJson ? JSON.stringify(updates[k]) : updates[k]);
    }
  }
  if (!fields.length) return true;
  values.push(id);
  await query(`UPDATE republish_campaigns SET ${fields.join(', ')} WHERE id=$${i}`, values);
  return true;
}

async function deleteRepublishCampaign(id) {
  await query('DELETE FROM republish_campaigns WHERE id=$1', [id]);
  return true;
}

async function getSavedPostImage(postId) {
  try {
    const r = await query(
      'SELECT image_data, image_mime FROM saved_posts WHERE post_id = $1 LIMIT 1',
      [postId]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    if (!row.image_data || row.image_data.length === 0) return null;
    return { buffer: row.image_data, mime: row.image_mime || 'image/jpeg' };
  } catch (e) {
    console.log('⚠️ Failed to load saved post image:', e.message);
    return null;
  }
}

async function setSavedPostImage(postId, buffer, mime) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
    await query(
      'UPDATE saved_posts SET image_data = $1, image_mime = $2 WHERE post_id = $3',
      [buffer, mime || 'image/jpeg', postId]
    );
    return true;
  } catch (e) {
    console.log('⚠️ Failed to update saved post image:', e.message);
    return false;
  }
}

async function logRepublish(campaignId, savedPostId, status, error) {
  try {
    await query(
      'INSERT INTO republish_log (campaign_id, saved_post_id, status, error) VALUES ($1,$2,$3,$4)',
      [campaignId, savedPostId, status, error || null]
    );
  } catch (e) { /* ignore */ }
}

async function getRepublishLog(campaignId, limit = 100) {
  const r = await query(
    'SELECT * FROM republish_log WHERE campaign_id=$1 ORDER BY published_at DESC LIMIT $2',
    [campaignId, limit]
  );
  return r.rows;
}

module.exports = {
  initDatabase,
  query,
  getConfig,
  saveConfig,
  getAuthState,
  saveAuthState,
  getProcessedLinks,
  addProcessedLink,
  isLinkProcessed,
  addLogEntry,
  deleteLogEntry,
  clearLog,
  getLog,
  getTelegramSession,
  saveTelegramSession,
  saveGeminiKeys,
  getGeminiKeys,
  addSavedPost,
  getSavedPosts,
  getSavedPostImage,
  setSavedPostImage,
  updateSavedPost,
  deleteSavedPost,
  deleteSavedPostsBefore,
  clearSavedPosts,
  createRepublishCampaign,
  listRepublishCampaigns,
  getRepublishCampaign,
  updateRepublishCampaign,
  deleteRepublishCampaign,
  logRepublish,
  getRepublishLog,
  setAppStorage,
  getAppStorage,
  closePool: async () => { if (pool) { await pool.end(); console.log('🔌 Database pool closed'); } },
};
