const { Telegraf } = require('telegraf');
const db = require('./db');

function sanitizeAliImg(url) {
  if (!url || typeof url !== 'string' || url.startsWith('data:')) return url;
  try {
    let u = url.trim();
    u = u.replace(/(\.(jpe?g|png))_[^/]*?\.(avif|webp)$/i, '$1');
    u = u.replace(/(\.(jpe?g|png))_[^/]*?\.\2_?$/i, '$1');
    u = u.replace(/_+$/, '');
    return u;
  } catch { return url; }
}

function formatChannelId(id) {
  if (!id) return null;
  id = String(id).trim();
  if (id.includes('t.me/')) id = '@' + id.split('t.me/').pop().split('/')[0].split('?')[0];
  if (!id.startsWith('@') && !id.startsWith('-')) id = '@' + id;
  return id;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isWithinActiveHours(camp) {
  const s = camp.active_hours_start, e = camp.active_hours_end;
  if (s == null || e == null) return true;
  const h = new Date().getHours();
  if (s <= e) return h >= s && h < e;
  return h >= s || h < e; // overnight window
}

function pickDelayMs(camp) {
  const min = Math.max(1, camp.min_minutes || 30);
  const max = Math.max(min, camp.max_minutes || 90);
  const mins = min + Math.random() * (max - min);
  return Math.round(mins * 60 * 1000);
}

class RepublishManager {
  constructor() {
    this.timer = null;
    this.aiRegenerator = null; // optional: function(post) => Promise<{title?, hook?, message?}>
    this.tickInFlight = false;
    this.processingCampaigns = new Set();
  }

  setAiRegenerator(fn) { this.aiRegenerator = fn; }

  async start() {
    console.log('🔁 Republish manager started');
    this.timer = setInterval(() => this.tick().catch(e => console.error('Republish tick error:', e.message)), 30000);
    setTimeout(() => this.tick().catch(() => {}), 3000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this._tick();
    } finally {
      this.tickInFlight = false;
    }
  }

  async _tick() {
    const campaigns = await db.listRepublishCampaigns();
    const now = new Date();
    for (const camp of campaigns) {
      if (camp.status !== 'active') continue;
      if (this.processingCampaigns.has(camp.id)) continue;
      if (camp.max_count && camp.total_published >= camp.max_count) {
        await db.updateRepublishCampaign(camp.id, { status: 'completed' });
        continue;
      }
      const next = camp.next_run_at ? new Date(camp.next_run_at) : now;
      if (next > now) continue;
      if (!isWithinActiveHours(camp)) {
        await db.updateRepublishCampaign(camp.id, { next_run_at: new Date(Date.now() + 15 * 60 * 1000) });
        continue;
      }
      this.processingCampaigns.add(camp.id);
      try {
        // re-fetch latest state in case it changed between list and process
        const fresh = await db.getRepublishCampaign(camp.id);
        if (fresh && fresh.status === 'active') {
          await this.publishNext(fresh);
        }
      } finally {
        this.processingCampaigns.delete(camp.id);
      }
    }
  }

  async refreshQueue(camp) {
    const all = await db.getSavedPosts();
    if (!all.length) return [];
    return shuffle(all.map(p => p.id));
  }

  async publishNext(camp) {
    let queue = camp.queue || [];
    let position = camp.position || 0;
    if (!Array.isArray(queue)) queue = [];

    if (position >= queue.length) {
      queue = await this.refreshQueue(camp);
      position = 0;
      if (!queue.length) {
        await db.updateRepublishCampaign(camp.id, { next_run_at: new Date(Date.now() + 5 * 60 * 1000) });
        return;
      }
    }

    const allPosts = await db.getSavedPosts();
    const postId = queue[position];
    const post = allPosts.find(p => p.id === postId);

    // schedule next regardless of success
    const nextAt = new Date(Date.now() + pickDelayMs(camp));

    if (!post) {
      // saved post deleted; skip
      await db.updateRepublishCampaign(camp.id, {
        queue, position: position + 1, next_run_at: new Date(),
      });
      await db.logRepublish(camp.id, postId, 'skipped', 'Post not found');
      return;
    }

    try {
      let postToSend = post;
      if (camp.regenerate_ai && this.aiRegenerator) {
        try {
          const updated = await this.aiRegenerator(post);
          postToSend = { ...post, ...updated };
        } catch (e) { console.warn('AI regenerate failed, using original:', e.message); }
      }
      await this.sendToTelegram(camp, postToSend);
      await db.logRepublish(camp.id, postId, 'success');
      await db.updateRepublishCampaign(camp.id, {
        queue,
        position: position + 1,
        total_published: (camp.total_published || 0) + 1,
        last_run_at: new Date(),
        next_run_at: nextAt,
      });
      console.log(`🔁 Republished post ${postId} for campaign ${camp.id}; next at ${nextAt.toISOString()}`);
    } catch (e) {
      console.error(`❌ Republish failed (campaign ${camp.id}, post ${postId}):`, e.message);
      await db.logRepublish(camp.id, postId, 'failed', e.message);
      await db.updateRepublishCampaign(camp.id, {
        queue, position: position + 1, last_run_at: new Date(), next_run_at: nextAt,
      });
    }
  }

  stripIntro(text) {
    if (!text || typeof text !== 'string') return text;
    // 1) Remove a leading <blockquote>...</blockquote> intro (Algerian hook)
    let out = text.replace(/^\s*<blockquote>[\s\S]*?<\/blockquote>\s*\n*/i, '');
    // 2) Remove any leftover blockquote tags anywhere (defensive)
    out = out.replace(/<\/?blockquote>/gi, '');
    return out.trimStart();
  }

  buildMessage(post) {
    if (post.message && post.message.trim()) return this.stripIntro(post.message);
    // Build from scratch WITHOUT the Algerian hook (republish should be clean)
    const lines = [];
    if (post.title) lines.push(`🛍️ ${post.title}`);
    if (post.price) lines.push(`💰 ${post.price}`);
    if (post.coupon) lines.push(`🎟️ كوبون: ${post.coupon}`);
    if (post.link) lines.push('', `🔗 ${post.link}`);
    return lines.join('\n');
  }

  async sendToTelegram(camp, post) {
    const creds = camp.credentials || {};
    const token = creds.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('No Telegram bot token');
    const bot = new Telegraf(token);

    const choice = camp.channel_choice || creds.channelChoice || 'both';
    const channels = [];
    if ((choice === '1' || choice === 'both') && creds.channelId) channels.push(formatChannelId(creds.channelId));
    if ((choice === '2' || choice === 'both') && creds.channelId2) channels.push(formatChannelId(creds.channelId2));
    if (!channels.length && process.env.TELEGRAM_CHANNEL_ID) channels.push(formatChannelId(process.env.TELEGRAM_CHANNEL_ID));
    if (!channels.length) throw new Error('No destination channel configured');

    const message = this.buildMessage(post);
    let image = post.image;
    let preBuffer = null;

    if (image && image.startsWith('data:image')) {
      try { preBuffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64'); } catch (e) {}
      image = null;
    } else if (image && image.startsWith('/api/saved-posts/')) {
      const m = image.match(/^\/api\/saved-posts\/([^/]+)\/image/);
      if (m) {
        try {
          const img = await db.getSavedPostImage(decodeURIComponent(m[1]));
          if (img && img.buffer) preBuffer = img.buffer;
        } catch (e) {}
      }
      image = null;
    } else if (image && image.startsWith('/spy-cache/')) {
      try {
        const path = require('path');
        const fs = require('fs');
        const safeName = path.basename(image);
        const filePath = path.join(__dirname, 'public', 'spy-cache', safeName);
        if (fs.existsSync(filePath)) preBuffer = fs.readFileSync(filePath);
      } catch (e) {}
      image = null;
    } else if (image && image.startsWith('/')) {
      // أي رابط نسبي آخر — تجاهله
      image = null;
    }

    for (const ch of channels) {
      if (preBuffer) {
        try {
          await bot.telegram.sendPhoto(ch, { source: preBuffer }, { caption: message });
        } catch (e) {
          await bot.telegram.sendMessage(ch, message);
        }
      } else if (image) {
        try {
          await bot.telegram.sendPhoto(ch, sanitizeAliImg(image), { caption: message });
        } catch (e) {
          await bot.telegram.sendMessage(ch, message);
        }
      } else {
        await bot.telegram.sendMessage(ch, message);
      }
    }
  }
}

module.exports = { RepublishManager };
