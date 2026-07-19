const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { portaffFunction, directAffLink, fetchLinkPreview } = require('./afflink');
const { getProductDetails, searchProducts } = require('./aliexpress-api');
const http = require('http');
const db = require('./db');
const { postToFacebookPage } = require('./facebook');

const https = require('https');
const crypto = require('crypto');
const got = require('got');
const cheerio = require('cheerio');

const SPY_CACHE_DIR = path.join(__dirname, 'public', 'spy-cache');
try { if (!fs.existsSync(SPY_CACHE_DIR)) fs.mkdirSync(SPY_CACHE_DIR, { recursive: true }); } catch (e) {}

function detectImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'jpg';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp';
  return 'jpg';
}

// يفحص ما إذا كان الرابط على الأرجح فيديو وليس صورة (لتفادي حالة أن يكون أول عنصر منتج فيديو)
function isLikelyVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  if (/\.(mp4|webm|mov|avi|m3u8|mkv|flv|m4v|3gp|ts)(\?|$|#)/.test(u)) return true;
  if (/(cloud\.video\.taobao\.com|video\.aliexpress|play\.aliexpress|alicdn-video|aliyun-video)/.test(u)) return true;
  if (/[?&](videoid|video_id|playurl)=/.test(u)) return true;
  return false;
}

function cacheImageBufferAsUrl(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
    const ext = detectImageExt(buffer);
    const filename = `${hash}.${ext}`;
    const filePath = path.join(SPY_CACHE_DIR, filename);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer);
    return `/spy-cache/${filename}`;
  } catch (e) {
    console.log('⚠️ فشل حفظ صورة محلية:', e.message);
    return null;
  }
}

const SPY_CONFIG_FILE = path.join(__dirname, 'spy_config.json');
const SPY_LOG_FILE = path.join(__dirname, 'spy_log.json');
const SESSION_FILE = path.join(__dirname, 'spy_session.json');
const PROCESSED_LINKS_FILE = path.join(__dirname, 'spy_processed.json');
const AUTH_STATE_FILE = path.join(__dirname, 'spy_auth_state.json');

const inFlightLinks = new Map(); // change to Map to track timeout
const processedMessageIds = new Set();
const MAX_PROCESSED_MESSAGES = 500;
const MAX_INFLIGHT_LINKS = 1000;
const INFLIGHT_TIMEOUT = 30 * 60 * 1000; // 30 minutes timeout

let processedLinksCache = null;
let processedLinksCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// تتبّع تكرار الصور عبر منتجات/روابط مختلفة (لكشف الصور الافتراضية/الخاطئة)
const imageUsageTracker = new Map(); // fp -> Set of identifiers
const blacklistedImageHashes = new Map(); // fp -> { ts, count, source }
const MAX_TRACKER_ENTRIES = 500;
const MAX_BLACKLIST_ENTRIES = 300;
const BLACKLIST_TTL_MS = 72 * 60 * 60 * 1000; // 72 ساعة
const REPEAT_THRESHOLD = 3; // ثلاث منتجات مختلفة لتجنب false positives (variants/relist)

function getImageFingerprint(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1000) return null;
  const chunk = Buffer.concat([
    buffer.slice(0, Math.min(8192, buffer.length)),
    buffer.slice(Math.floor(buffer.length / 2), Math.floor(buffer.length / 2) + Math.min(4096, buffer.length)),
    buffer.slice(Math.max(0, buffer.length - 4096)),
  ]);
  return crypto.createHash('sha1').update(chunk).digest('hex').slice(0, 16);
}

function pruneBlacklist() {
  const now = Date.now();
  // إزالة المنتهية صلاحيتها
  for (const [fp, info] of blacklistedImageHashes) {
    if (now - info.ts > BLACKLIST_TTL_MS) blacklistedImageHashes.delete(fp);
  }
  // حد أقصى للحجم (أقدم أولاً)
  while (blacklistedImageHashes.size > MAX_BLACKLIST_ENTRIES) {
    const firstKey = blacklistedImageHashes.keys().next().value;
    blacklistedImageHashes.delete(firstKey);
  }
}

function isImageBlacklisted(buffer) {
  pruneBlacklist();
  const fp = getImageFingerprint(buffer);
  return fp && blacklistedImageHashes.has(fp);
}

function trackImageUsage(buffer, productId, originalLink, sourceName) {
  const fp = getImageFingerprint(buffer);
  // معرّف بديل عند غياب productId: hash من الرابط الأصلي
  const identifier = productId
    ? `pid:${productId}`
    : (originalLink ? `lnk:${crypto.createHash('sha1').update(String(originalLink)).digest('hex').slice(0, 12)}` : null);
  if (!fp || !identifier) return { duplicated: false };

  let set = imageUsageTracker.get(fp);
  if (!set) {
    set = new Set();
    imageUsageTracker.set(fp, set);
  }
  set.add(identifier);
  // تنظيف الذاكرة (FIFO)
  if (imageUsageTracker.size > MAX_TRACKER_ENTRIES) {
    const firstKey = imageUsageTracker.keys().next().value;
    imageUsageTracker.delete(firstKey);
  }
  if (set.size >= REPEAT_THRESHOLD) {
    if (!blacklistedImageHashes.has(fp)) {
      blacklistedImageHashes.set(fp, { ts: Date.now(), count: set.size, source: sourceName });
      console.log(`🚫 صورة افتراضية مكتشفة! نفس الصورة استُخدمت لـ ${set.size} منتجات/روابط مختلفة → blacklist (المصدر: ${sourceName})`);
      console.log(`   ↳ Identifiers: ${[...set].join(', ')}`);
      pruneBlacklist();
    }
    return { duplicated: true, count: set.size };
  }
  return { duplicated: false };
}

function isMessageProcessed(chatId, msgId) {
  const key = `${chatId}:${msgId}`;
  return processedMessageIds.has(key);
}

function markMessageProcessed(chatId, msgId) {
  const key = `${chatId}:${msgId}`;
  processedMessageIds.add(key);
  if (processedMessageIds.size > MAX_PROCESSED_MESSAGES) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
}

async function loadProcessedLinks() {
  const now = Date.now();
  if (processedLinksCache && (now - processedLinksCacheTime) < CACHE_DURATION) {
    return processedLinksCache;
  }
  
  try {
    const links = await db.getProcessedLinks();
    processedLinksCache = links;
    processedLinksCacheTime = now;
    return links;
  } catch (e) {
    console.log('⚠️ Error loading processed links:', e.message);
    processedLinksCache = [];
    processedLinksCacheTime = now;
    return [];
  }
}

async function isLinkProcessed(link) {
  const normalized = normalizeAliLink(link);
  const now = Date.now();
  
  if (inFlightLinks.has(normalized)) {
    const timestamp = inFlightLinks.get(normalized);
    if (now - timestamp < INFLIGHT_TIMEOUT) {
      return true;
    } else {
      console.log(`⚠️ تطهير رابط معلق متجاوز المهلة: ${normalized}`);
      inFlightLinks.delete(normalized);
    }
  }
  
  try {
    return await db.isLinkProcessed(normalized);
  } catch (e) {
    console.log('⚠️ Error checking link:', e.message);
    return false;
  }
}

function reserveLink(link) {
  const normalized = normalizeAliLink(link);
  inFlightLinks.set(normalized, Date.now());
  
  if (inFlightLinks.size > MAX_INFLIGHT_LINKS) {
    const now = Date.now();
    for (const [key, timestamp] of inFlightLinks.entries()) {
      if (now - timestamp > INFLIGHT_TIMEOUT) {
        inFlightLinks.delete(key);
      }
    }
    if (inFlightLinks.size > MAX_INFLIGHT_LINKS) {
      const firstKey = inFlightLinks.keys().next().value;
      inFlightLinks.delete(firstKey);
    }
  }
}

async function markLinkProcessed(link) {
  const normalized = normalizeAliLink(link);
  inFlightLinks.delete(normalized);
  try {
    await db.addProcessedLink(normalized);
  } catch (e) {
    console.log('⚠️ Error marking link as processed:', e.message);
  }
}

function normalizeAliLink(link) {
  try {
    const url = new URL(link);
    const productMatch = link.match(/\/item\/(\d+)/);
    if (productMatch) return 'product:' + productMatch[1];
    const pidParam = url.searchParams.get('productIds') || url.searchParams.get('productId') || url.searchParams.get('itemId');
    if (pidParam) return 'product:' + pidParam;
    return url.hostname + url.pathname + (url.search || '');
  } catch {
    return link;
  }
}

function randomDelay(minMinutes, maxMinutes) {
  const ms = (minMinutes + Math.random() * (maxMinutes - minMinutes)) * 60 * 1000;
  return Math.round(ms);
}

let dailyPublishCount = 0;
let dailyPublishDate = '';

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getDailyCount() {
  const today = getTodayStr();
  if (dailyPublishDate !== today) {
    dailyPublishDate = today;
    dailyPublishCount = 0;
  }
  return dailyPublishCount;
}

function incrementDailyCount() {
  const today = getTodayStr();
  if (dailyPublishDate !== today) {
    dailyPublishDate = today;
    dailyPublishCount = 0;
  }
  dailyPublishCount++;
  return dailyPublishCount;
}

function isDailyLimitReached(config) {
  if (!config.dailyLimit || config.dailyLimit <= 0) return false;
  return getDailyCount() >= config.dailyLimit;
}

async function sendOwnerNotification(botToken, ownerId, entry) {
  if (!botToken || !ownerId) return;
  try {
    const bot = new Telegraf(botToken);
    let msg = `🔔 *منتج جديد مرصود*\n\n`;
    msg += `📡 المصدر: ${entry.source || 'غير معروف'}\n`;
    if (entry.title) msg += `📦 ${entry.title}\n`;
    if (entry.price) msg += `💰 السعر: ${entry.price}\n`;
    if (entry.affiliateLink) msg += `🔗 الرابط: ${entry.affiliateLink}\n`;
    msg += `\n⏱ سيتم النشر بعد ${entry.delayMinutes || 0} دقيقة`;
    await bot.telegram.sendMessage(ownerId, msg);
  } catch (e) {
    console.log('⚠️ فشل إرسال الإشعار:', e.message);
  }
}

async function loadConfig() {
  try {
    // Try to load from database first
    const config = await db.getConfig();
    if (Object.keys(config).length > 0) {
      console.log('✅ Loaded spy config from database');
      return config;
    }
  } catch (e) {
    console.log('⚠️ Error loading spy config from database:', e.message);
  }
  
  // Fallback to file
  try {
    if (fs.existsSync(SPY_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(SPY_CONFIG_FILE, 'utf8'));
      console.log('✅ Loaded spy config from file, syncing to database...');
      // Sync to database
      await db.saveConfig(config).catch(err => console.log('⚠️ Failed to sync config to DB:', err.message));
      return config;
    }
  } catch (e) {
    console.log('⚠️ Error loading spy config from file:', e.message);
  }
  
  console.log('📝 Using default spy config');
  return getDefaultConfig();
}

function getDefaultConfig() {
  return {
    enabled: false,
    sourceChannels: [],
    targetChannels: [],
    apiId: '',
    apiHash: '',
    phoneNumber: '',
    autoPublish: true,
    linkType: 'coin',
    messageTemplate: {
      headerText: '',
      prefix: '🔥 عرض حصري',
      priceLabel: '💰 السعر:',
      linkLabel: '🛒 رابط الشراء:',
      couponLabel: 'كوبون',
      fixedCoupons: '',
      couponFilter: '',
      sellerCoupon: '',
      sellerCouponCode: '',
      footer: '⚠️ لا تنس استخدام البوت الرسمي لـ AffiliDz',
      botLink: '@AffiliDz_bot',
      hashtags: '#Aliexpress #تخفيضات',
      hookEnabled: true,
      seasonOffer: '',
      seasonOfferEnabled: false
    }
  };
}

async function saveConfig(config) {
  let savedToDb = false;
  let savedToFile = false;
  
  // Save to database
  try {
    await db.saveConfig(config);
    console.log('✅ Saved spy config to database');
    savedToDb = true;
  } catch (e) {
    console.log('⚠️ Error saving spy config to database:', e.message);
  }
  
  // Save to file as backup
  try {
    fs.writeFileSync(SPY_CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('✅ Saved spy config to file');
    savedToFile = true;
  } catch (e) {
    console.log('⚠️ Error saving spy config to file:', e.message);
  }
  
  return savedToDb || savedToFile;
}

async function loadLog() {
  try {
    return await db.getLog(200);
  } catch (e) {
    console.log('Error loading spy log:', e.message);
    return [];
  }
}

async function addLogEntry(entry) {
  try {
    await db.addLogEntry(entry);
  } catch (e) {
    console.log('⚠️ Failed to add log entry:', e.message);
  }
}

function extractCouponFromPost(text) {
  if (!text) return null;
  const coupons = new Set();

  const excludeWords = new Set([
    'CODE', 'HTTP', 'HTTPS', 'HTML', 'AMOLED', 'BLUETOOTH', 'GPS',
    'HONOR', 'SAMSUNG', 'XIAOMI', 'REDMI', 'POCO', 'REALME', 'OPPO',
    'VIVO', 'HUAWEI', 'NOKIA', 'IPHONE', 'PIXEL', 'NOTHING', 'GLOBAL',
    'VERSION', 'SPRING', 'SALE', 'TIME', 'STORE', 'FLASH', 'FREE',
    'TYPE', 'USB', 'HDMI', 'WIFI', 'OLED', 'MINI', 'PLUS', 'ULTRA',
    'LITE', 'NOTE', 'BAND', 'WATCH', 'BUDS', 'PODS', 'CASE', 'SUPER',
    'FAST', 'CHARGING', 'CABLE', 'ADAPTER'
  ]);

  function isValidCoupon(code) {
    if (!code || code.length < 4 || code.length > 20) return false;
    if (!/[A-Z]/.test(code)) return false;
    if (/^[a-z]/.test(code)) return false;
    if (excludeWords.has(code.toUpperCase())) return false;
    const upper = code.replace(/[^A-Z0-9]/g, '');
    if (upper !== code) return false;
    return true;
  }

  const patterns = [
    /(?:كوبون|coupon|كود|رمز)[:\s]*(?:\$?\d+[/]\d+\s*[:\s]*)?([A-Z][A-Z0-9]{3,19})/gi,
    /(?:استخدم|use|ادخل|enter)[:\s]*([A-Z][A-Z0-9]{3,19})/gi,
    /\b(?:CODE)\s+([A-Z0-9]{4,20})/gi,
  ];

  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(text)) !== null) {
      const raw = (match[2] || match[1]).trim();
      const code = raw.toUpperCase();
      if (isValidCoupon(code)) coupons.add(code);
    }
  }

  const codePattern = /\b([A-Z]{2,8}[0-9]{1,6})\b/g;
  let m;
  while ((m = codePattern.exec(text)) !== null) {
    const code = m[1];
    if (isValidCoupon(code)) coupons.add(code);
  }

  if (coupons.size === 0) return null;
  return Array.from(coupons).join(' | ');
}

function extractCouponFromTextLine(line) {
  if (!line) return null;
  const cleaned = line.trim();
  const match = cleaned.match(/(?:كوبون|قسيمة|coupon|code|كود|رمز|store coupon)[:\s]*([A-Z0-9]{3,20})/i);
  if (match && match[1]) return match[1].toUpperCase();
  const fallback = cleaned.match(/\b([A-Z]{2,8}[0-9]{1,6})\b/);
  return fallback ? fallback[1].toUpperCase() : null;
}

function extractSellerCouponFromPost(text) {
  if (!text) return null;
  const coupons = new Set();
  const patterns = [
    /(?:قسيمة\s*البائع|إحجز\s*قسيمة\s*البائع|حصل\s*قسيمة\s*البائع|خصم\s*البائع|عرض\s*المتجر|قسيمة\s*المتجر|seller\s*coupon|store\s*coupon)[:\s]*([A-Z0-9$/.\-\s]{3,30})/gi,
  ];
  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(text)) !== null) {
      const code = (match[1] || '').trim();
      if (code.length >= 2) coupons.add(code);
    }
  }
  const pricePatterns = [
    /(?:قسيمة\s*البائع|إحجز\s*قسيمة|seller\s*coupon|store\s*coupon)[:\s]*(\$\d+(?:[./]\d+)?)/gi,
  ];
  for (const pat of pricePatterns) {
    let match;
    while ((match = pat.exec(text)) !== null) {
      const val = (match[1] || '').trim();
      if (val) coupons.add(val);
    }
  }
  if (coupons.size === 0) return null;
  return Array.from(coupons).join(' | ');
}

function extractSellerCouponFromTextLine(line) {
  if (!line) return null;
  const cleaned = line.trim();
  const match = cleaned.match(/(?:قسيمة\s*البائع|seller\s*coupon|seller\s*code|coupon\s*code|code)[:\s]*([A-Z0-9$\/.-]{3,30})/i);
  if (match && match[1]) return match[1].trim();
  return null;
}

function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) return false;
    return true;
  } catch { return false; }
}

function downloadImageAsBuffer(url, timeoutMs = 15000, maxRedirects = 3) {
  return new Promise((resolve) => {
    if (!isSafeUrl(url)) return resolve(null);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        downloadImageAsBuffer(res.headers.location, timeoutMs, maxRedirects - 1).then(resolve);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const contentType = res.headers['content-type'] || '';
      if (!contentType.includes('image')) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length > 1000 ? buf : null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

// تطبيق الإطار + إزالة الخلفية + سعر يدوي ديناميكي
async function applyFrameToImage(productImage, imageUrl, watermark, opts = {}) {
  let buffer = null;
  try {
    if (productImage && typeof productImage === 'object' && Buffer.isBuffer(productImage.source)) {
      buffer = productImage.source;
    } else if (typeof productImage === 'string' && /^https?:\/\//i.test(productImage)) {
      buffer = await downloadImageAsBuffer(productImage);
    } else if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
      buffer = await downloadImageAsBuffer(imageUrl);
    }
    if (!buffer) return null;

    const customFramePath = path.join(__dirname, 'public', 'custom_frame.jpg');
    const framePath = path.join(__dirname, 'public', 'frame.jpg');
    const useFramePath = fs.existsSync(customFramePath) ? customFramePath : framePath;
    if (!fs.existsSync(useFramePath)) return null;

    const meta = await sharp(useFramePath).metadata();
    const fW = meta.width, fH = meta.height;
    // Geometry: المنتج داخل المساحة البيضاء، تحت تبويبة الشعار وفوق شريط الشراء
    // إطار 1024px: حدود 36 جانبي + 28 علوي + شريط سفلي 150، تبويبة شعار حتى y=130
    const innerLeft = Math.round(fW * (106 / 1024));   // 36 + 70 padding
    const innerTop = Math.round(fH * (158 / 1024));    // 28 + 130 (تحت اللوقو)
    const innerW = Math.round(fW * (812 / 1024));      // 1024 - 2*106
    const innerH = Math.round(fH * (676 / 1024));      // (1024-150) - 158 - 20

    // إزالة خلفية المنتج إذا مفعّلة
    let productBuf = buffer;
    let hasTransparency = false;
    if (opts.removeBg) {
      try {
        const { removeBackground } = require('./imageProcessor');
        const transparent = await removeBackground(buffer);
        if (transparent) {
          productBuf = transparent;
          hasTransparency = true;
          console.log('🎨 تمت إزالة خلفية المنتج');
        }
      } catch (e) {
        console.log('⚠️ إزالة الخلفية فشلت — سنستعمل الصورة الأصلية:', e.message);
      }
    }

    // تركيب المنتج: شفّاف بدون خلفية، أو ضمن مسرح أبيض
    const resizedProduct = hasTransparency
      ? await sharp(productBuf).resize(innerW, innerH, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
      : await sharp(productBuf).resize(innerW, innerH, { fit: 'inside', background: { r: 255, g: 255, b: 255, alpha: 1 } }).toBuffer();

    // توسيط داخل المسرح
    const pMeta = await sharp(resizedProduct).metadata();
    const offX = innerLeft + Math.round((innerW - (pMeta.width || innerW)) / 2);
    const offY = innerTop + Math.round((innerH - (pMeta.height || innerH)) / 2);

    const composites = [{ input: resizedProduct, left: offX, top: offY, blend: 'over' }];

    const logoPath = path.join(__dirname, 'public', 'watermark_logo.png');
    if (fs.existsSync(logoPath) && watermark) {
      try {
        const logoSize = watermark.size === 'small' ? 80 : watermark.size === 'large' ? 160 : 120;
        const padding = 20;
        const resizedLogo = await sharp(logoPath).resize(logoSize, logoSize, { fit: 'inside' }).png().toBuffer();
        const logoMeta = await sharp(resizedLogo).metadata();
        const lW = logoMeta.width, lH = logoMeta.height;
        let left, top;
        switch (watermark.position) {
          case 'top-left': left = padding; top = padding; break;
          case 'top-right': left = fW - lW - padding; top = padding; break;
          case 'bottom-left': left = padding; top = fH - lH - padding; break;
          case 'center': left = Math.round((fW - lW) / 2); top = Math.round((fH - lH) / 2); break;
          case 'bottom-right':
          default: left = fW - lW - padding; top = fH - lH - padding;
        }
        composites.push({ input: resizedLogo, left, top, blend: 'over' });
      } catch (logoErr) {
        console.log('⚠️ تطبيق اللوقو فشل:', logoErr.message);
      }
    }

    let result = await sharp(useFramePath).composite(composites).jpeg({ quality: 92 }).toBuffer();

    // طبقة السعر اليدوي الديناميكي
    try {
      const { extractPrice, overlayPrice } = require('./imageProcessor');
      let price = opts.price || null;
      if (!price && opts.postText) price = extractPrice(opts.postText);
      if (price) {
        // السعر بخط يدوي مركّز داخل الزر البنفسجي (380x110 في 50,SIZE-130)
        const priceFontSize = Math.round(fH * (76 / 1024));
        const priceX = Math.round(fW * (110 / 1024));
        const priceY = fH - Math.round(fH * (145 / 1024));
        result = await overlayPrice(result, String(price).replace(',', '.'), {
          x: priceX, y: priceY, fontSize: priceFontSize,
          color: '#FFFFFF', accent: '#FFC424',
        });
        console.log(`💰 السعر اليدوي: ${price}$`);
      }
    } catch (priceErr) {
      console.log('⚠️ تركيب السعر فشل:', priceErr.message);
    }

    return result;
  } catch (e) {
    console.log('⚠️ applyFrameToImage فشل:', e.message);
    return null;
  }
}

// تنظيف رابط صور AliExpress من لاحقات .avif/.webp غير المدعومة في تيليغرام
function sanitizeAliImageUrlSpy(url) {
  if (!url || typeof url !== 'string' || url.startsWith('data:')) return url;
  try {
    let u = url.trim();
    u = u.replace(/(\.(jpe?g|png))_[^/]*?\.(avif|webp)$/i, '$1');
    u = u.replace(/(\.(jpe?g|png))_[^/]*?\.\2_?$/i, '$1');
    u = u.replace(/_+$/, '');
    return u;
  } catch (e) { return url; }
}

// إرسال منشور إلى قناة مع ضمان ظهور الصورة (Buffer → URL → preview → URL retry → link_preview → نص فقط)
async function smartSendPostSpy(bot, target, captionMessage, textMessage, productImage, imageUrl, opts = {}) {
  const sendOpts = { parse_mode: 'HTML', ...opts };
  // تنظيف الرابط من لاحقات avif/webp
  imageUrl = sanitizeAliImageUrlSpy(imageUrl);
  if (typeof productImage === 'string') productImage = sanitizeAliImageUrlSpy(productImage);
  // المحاولة 1: استخدم productImage الجاهز (Buffer أو URL)
  if (productImage) {
    try {
      await bot.telegram.sendPhoto(target, productImage, { caption: captionMessage, ...sendOpts });
      return { ok: true, via: 'primary' };
    } catch (e) {
      console.log(`⚠️ [smartSend] sendPhoto primary فشل (${target}): ${e.message}`);
    }
  }
  // المحاولة 2: تحميل URL كـ Buffer إن لم تكن المحاولة الأولى Buffer
  if (imageUrl && /^https?:\/\//i.test(imageUrl) && !(productImage && typeof productImage === 'object' && productImage.source)) {
    const buf = await downloadImageAsBuffer(imageUrl);
    if (buf) {
      try {
        await bot.telegram.sendPhoto(target, { source: buf }, { caption: captionMessage, ...sendOpts });
        return { ok: true, via: 'buffer' };
      } catch (e) { console.log(`⚠️ [smartSend] sendPhoto buffer فشل: ${e.message}`); }
    }
  }
  // المحاولة 3: إرسال URL مباشرة (إعادة محاولة)
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    try {
      await bot.telegram.sendPhoto(target, imageUrl, { caption: captionMessage, ...sendOpts });
      return { ok: true, via: 'url_retry' };
    } catch (e) { console.log(`⚠️ [smartSend] sendPhoto URL retry فشل: ${e.message}`); }
    // المحاولة 4: ضع رابط الصورة في النص ليُعرض كمعاينة كبيرة
    try {
      const msgWithImage = imageUrl + '\n\n' + textMessage.substring(0, 4000);
      await bot.telegram.sendMessage(target, msgWithImage, {
        ...sendOpts,
        link_preview_options: { is_disabled: false, url: imageUrl, prefer_large_media: true }
      });
      return { ok: true, via: 'link_preview' };
    } catch (e) { console.log(`⚠️ [smartSend] link_preview فشل: ${e.message}`); }
  }
  // الأخير: نص فقط
  await bot.telegram.sendMessage(target, textMessage, sendOpts);
  return { ok: true, via: 'text_only' };
}

function extractOgImageFromHtml(html) {
  if (!html) return null;
  const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (ogMatch && ogMatch[1]) return ogMatch[1];
  const imgMatch = html.match(/<img[^>]*class=["'][^"']*(?:product|main|gallery)[^"']*["'][^>]*src=["']([^"']+)["']/i);
  return imgMatch ? imgMatch[1] : null;
}

function fetchOgImage(url, timeoutMs = 12000, maxRedirects = 5) {
  return new Promise((resolve) => {
    if (!isSafeUrl(url)) return resolve(null);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        fetchOgImage(res.headers.location, timeoutMs, maxRedirects - 1).then(resolve);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        body += c;
        if (body.length > 100000) { res.destroy(); const img = extractOgImageFromHtml(body); resolve(img); }
      });
      res.on('end', () => resolve(extractOgImageFromHtml(body)));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

async function fetchImageFromAliExpressPageCheerio(productId, timeoutMs = 12000) {
  if (!productId) return null;
  // نُجرّب صفحة الجوال أولاً ثم نطاق فيتنام (SSR أنظف) ثم سطح المكتب
  const urls = [
    `https://m.aliexpress.com/item/${productId}.html`,
    `https://vi.aliexpress.com/item/${productId}.html`,
    `https://www.aliexpress.com/item/${productId}.html`,
  ];

  const normalizeImg = (u) => {
    if (!u) return null;
    let s = String(u).replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/\\/g, '');
    if (s.startsWith('//')) s = 'https:' + s;
    return s;
  };

  // أنماط JSON المضمّنة داخل <script> — صور المصنع الأصلية بدقة عالية
  const extractFromScripts = (body) => {
    const patterns = [
      /"imagePathList"\s*:\s*\[\s*"([^"]+)"/,
      /"imageBigViewURL"\s*:\s*\[\s*"([^"]+)"/,
      /"mainImageUrl"\s*:\s*"(https?:[^"]+)"/,
      /"imageUrl"\s*:\s*"(https?:\/\/[^"]*alicdn[^"]+)"/,
      /window\.runParams[\s\S]{0,500}?"image[Pp]ath[Ll]ist"\s*:\s*\[\s*"([^"]+)"/,
      /"images"\s*:\s*\[\s*"(https?:\/\/[^"]*alicdn[^"]+)"/,
    ];
    for (const p of patterns) {
      const m = body.match(p);
      if (m && m[1]) {
        const url = normalizeImg(m[1]);
        if (url && /alicdn\.com|aliexpress-media/i.test(url) && !isLikelyVideoUrl(url)) {
          return url;
        }
      }
    }
    return null;
  };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const userAgent = i === 0
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    try {
      const response = await got(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: { request: timeoutMs },
        followRedirect: true
      });

      const body = response.body || '';

      // 1) أولاً: استخراج من JSON المضمّن في <script> (دقة عالية + من المصنع)
      const jsonImage = extractFromScripts(body);
      if (jsonImage) {
        console.log(`✅ Cheerio (JSON) وجد صورة عالية الدقة: ${jsonImage.substring(0, 80)}...`);
        return { image: jsonImage };
      }

      // 2) ثانياً: og:image / twitter:image / CSS selectors
      const $ = cheerio.load(body);
      let imageUrl = normalizeImg(
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        $('.gallery-panel__preview-image').attr('src') ||
        $('.magnifier-image').attr('src') ||
        $('img.specZoom').attr('src') ||
        $('img[class*="product-image"]').first().attr('src') ||
        $('img[class*="main-image"]').first().attr('src')
      );

      if (!imageUrl) {
        const fallbackMatch = body.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
          || body.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        if (fallbackMatch && fallbackMatch[1]) imageUrl = normalizeImg(fallbackMatch[1]);
      }

      if (imageUrl && !isLikelyVideoUrl(imageUrl)) {
        console.log(`✅ Cheerio (HTML) وجد صورة: ${imageUrl.substring(0, 80)}...`);
        return { image: imageUrl };
      }
    } catch (e) {
      console.log(`⚠️ Cheerio فشل على ${url.includes('m.') ? 'mobile' : 'desktop'}: ${e.message}`);
    }
  }
  return null;
}

// ⭐ الكود البسيط المُجرَّب في بوتات أخرى — linkpreview.xyz + vi.aliexpress.com
async function fetchImageViaSimplePreview(productId, timeoutMs = 15000) {
  if (!productId) return null;
  try {
    const res = await got("https://linkpreview.xyz/api/get-meta-tags", {
      searchParams: {
        url: `https://vi.aliexpress.com/item/${productId}.html`
      },
      responseType: "json",
      timeout: { request: timeoutMs }
    });
    const image = res.body?.image || null;
    const title = res.body?.title || null;
    if (image) {
      console.log(`✅ Simple Preview وجد صورة: ${String(image).substring(0, 80)}...`);
      return { image, title };
    }
    return null;
  } catch (err) {
    console.log(`⚠️ Simple Preview فشل: ${err.message}`);
    return null;
  }
}

function fetchImageViaMicrolink(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const apiUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}`;
    const req = https.get(apiUrl, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.status === 'success' && data.data) {
            const imageUrl = data.data.image?.url || null;
            let title = data.data.title || null;
            if (title) {
              title = title.replace(/ - AliExpress.*$/i, '').replace(/\s*-\s*AliExpress\s*\d*$/i, '').trim();
              const isValid = title.length > 10 && !title.includes('AliExpress') && !title.includes('Smarter Shopping');
              if (!isValid) title = null;
            }
            if (imageUrl) {
              console.log(`✅ Microlink.io وجد صورة: ${imageUrl.substring(0, 80)}...`);
              resolve({ image: imageUrl, title: title });
            } else {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function fetchImageViaLinkPreview(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const apiUrl = `https://linkpreview.xyz/api/get-meta-tags?url=${encodeURIComponent(url)}`;
    const req = https.get(apiUrl, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const imageUrl = data.image || data['og:image'] || data.ogImage || null;
          const title = data.title || data['og:title'] || data.ogTitle || null;
          if (imageUrl) {
            console.log(`✅ LinkPreview.xyz وجد صورة: ${imageUrl.substring(0, 80)}...`);
            resolve({ image: imageUrl, title: title });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

// ===== آلية جديدة #1: كشط JSON المضمّن من صفحة AliExpress للجوال =====
// تحتوي الصفحة على window.runParams.data.imageModule.imagePathList أو أنماط مشابهة
function fetchImageFromMobilePageJson(productId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!productId) return resolve(null);
    const urls = [
      `https://m.aliexpress.com/item/${productId}.html`,
      `https://www.aliexpress.com/item/${productId}.html`,
      `https://ar.aliexpress.com/item/${productId}.html`,
    ];
    let attemptIdx = 0;
    const tryNext = () => {
      if (attemptIdx >= urls.length) return resolve(null);
      const url = urls[attemptIdx++];
      if (!isSafeUrl(url)) return tryNext();
      const userAgent = attemptIdx === 1
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
      const req = https.get(url, {
        headers: { 'User-Agent': userAgent, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return tryNext();
        }
        if (res.statusCode !== 200) { res.resume(); return tryNext(); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => {
          body += c;
          if (body.length > 800000) res.destroy();
        });
        res.on('end', () => {
          // محاولة استخراج من أنماط JSON المتعددة في الصفحة
          const patterns = [
            /"imagePathList"\s*:\s*\[\s*"([^"]+)"/,
            /"imageUrl"\s*:\s*"(https?:[^"]+)"/,
            /"mainImageUrl"\s*:\s*"(https?:[^"]+)"/,
            /"imageBigViewURL"\s*:\s*\[\s*"([^"]+)"/,
            /"images"\s*:\s*\[\s*"(https?:[^"]+)"/,
            /image[Uu]rl["']?\s*[:=]\s*["'](https?:\/\/[^"']*alicdn[^"']+)["']/,
          ];
          let imageUrl = null;
          let title = null;
          for (const p of patterns) {
            const m = body.match(p);
            if (m && m[1]) {
              imageUrl = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
              if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
              break;
            }
          }
          const titleMatch = body.match(/"subject"\s*:\s*"([^"]+)"/) || body.match(/"title"\s*:\s*"([^"]+)"/);
          if (titleMatch && titleMatch[1]) {
            title = titleMatch[1].replace(/\\u[\dA-Fa-f]{4}/g, (m) => String.fromCharCode(parseInt(m.slice(2), 16)));
          }
          if (imageUrl && isLikelyVideoUrl(imageUrl)) {
            console.log(`⛔ Mobile JSON: تم تجاهل رابط فيديو (${imageUrl.substring(0, 80)}...)`);
            imageUrl = null;
          }
          if (imageUrl && /alicdn|aliexpress-media/.test(imageUrl)) {
            console.log(`✅ Mobile JSON وجد صورة: ${imageUrl.substring(0, 80)}...`);
            return resolve({ image: imageUrl, title });
          }
          tryNext();
        });
        res.on('error', () => tryNext());
      });
      req.on('error', () => tryNext());
      req.setTimeout(timeoutMs, () => { req.destroy(); tryNext(); });
    };
    tryNext();
  });
}

// ===== آلية جديدة A: Open Graph من رابط الأفليت (يتبع التحويلات) =====
async function fetchImageViaAffOgImage(affLink, timeoutMs = 15000) {
  if (!affLink || !/^https?:\/\//i.test(affLink)) return null;
  try {
    const img = await fetchOgImage(affLink, timeoutMs, 6);
    if (img && /^https?:\/\//i.test(img) && /alicdn|aliexpress-media/i.test(img) && !isLikelyVideoUrl(img)) {
      console.log(`✅ Aff OG وجد صورة: ${img.substring(0, 80)}...`);
      return { image: img };
    }
  } catch (e) {}
  return null;
}

// ===== آلية جديدة B: بحث AliExpress بالعنوان (Affiliate Product Query API) =====
async function fetchImageViaTitleSearch(title, timeoutMs = 20000) {
  if (!title || title.length < 3) return null;
  try {
    const clean = title.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    if (!clean) return null;
    const result = await Promise.race([
      searchProducts({ keywords: clean.substring(0, 100), limit: 5 }),
      new Promise(r => setTimeout(() => r({ success: false }), timeoutMs)),
    ]);
    if (result && result.success && Array.isArray(result.products) && result.products.length > 0) {
      const withImage = result.products.find(p => p.image_url && /alicdn|aliexpress-media/i.test(p.image_url) && !isLikelyVideoUrl(p.image_url));
      if (withImage) {
        console.log(`✅ بحث بالعنوان وجد صورة: ${withImage.image_url.substring(0, 80)}... (منتج: ${withImage.title?.substring(0, 50)})`);
        return { image: withImage.image_url, title: withImage.title, productId: withImage.id };
      }
    }
  } catch (e) { console.log(`⚠️ بحث بالعنوان: ${e.message}`); }
  return null;
}

// ===== آلية جديدة C: JSON-LD من صفحة المنتج (Mobile/Structured Data API) =====
function fetchImageViaJsonLd(productId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!productId) return resolve(null);
    const urls = [
      `https://www.aliexpress.com/item/${productId}.html`,
      `https://m.aliexpress.com/item/${productId}.html`,
      `https://ar.aliexpress.com/item/${productId}.html`,
    ];
    let idx = 0;
    const tryNext = () => {
      if (idx >= urls.length) return resolve(null);
      const url = urls[idx++];
      if (!isSafeUrl(url)) return tryNext();
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
          'Accept': 'text/html,application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return tryNext();
        }
        if (res.statusCode !== 200) { res.resume(); return tryNext(); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; if (body.length > 600000) res.destroy(); });
        res.on('end', () => {
          // ابحث عن كل سكربتات JSON-LD
          const ldMatches = body.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
          if (ldMatches) {
            for (const block of ldMatches) {
              const jsonText = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
              try {
                const data = JSON.parse(jsonText);
                const candidates = Array.isArray(data) ? data : [data];
                for (const item of candidates) {
                  let img = null;
                  if (typeof item.image === 'string') img = item.image;
                  else if (Array.isArray(item.image) && item.image.length > 0) img = item.image[0];
                  else if (item.image && item.image.url) img = item.image.url;
                  if (img && /^https?:\/\//.test(img) && /alicdn|aliexpress-media/i.test(img) && !isLikelyVideoUrl(img)) {
                    console.log(`✅ JSON-LD وجد صورة: ${img.substring(0, 80)}...`);
                    return resolve({ image: img, title: item.name || null });
                  }
                }
              } catch {}
            }
          }
          tryNext();
        });
        res.on('error', () => tryNext());
      });
      req.on('error', () => tryNext());
      req.setTimeout(timeoutMs, () => { req.destroy(); tryNext(); });
    };
    tryNext();
  });
}

// ===== آلية جديدة #2: بحث صور Bing كملاذ أخير =====
function fetchImageViaBingSearch(query, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!query || query.length < 3) return resolve(null);
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query + ' aliexpress')}&form=HDRSC2&first=1`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        body += c;
        if (body.length > 500000) res.destroy();
      });
      res.on('end', () => {
        // Bing يخزّن بيانات الصور في سمة m="{...}" على كل عنصر
        const mMatch = body.match(/m="\{[^}]*?&quot;murl&quot;:&quot;([^&]+)&quot;/);
        let imageUrl = mMatch ? mMatch[1] : null;
        if (!imageUrl) {
          const altMatch = body.match(/"murl":"(https?:[^"]+)"/);
          imageUrl = altMatch ? altMatch[1] : null;
        }
        if (imageUrl) {
          imageUrl = imageUrl.replace(/&amp;/g, '&');
          console.log(`✅ Bing Images وجد صورة: ${imageUrl.substring(0, 80)}...`);
          return resolve({ image: imageUrl });
        }
        resolve(null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function normalizeAliExpressLinks(text) {
  if (!text) return '';
  const links = [];
  const seen = new Set();
  const pattern = /(?:https?:\/\/)?(?:s\.click\.)?aliexpress\.com\/[^\s<>()\]]+/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const clean = match[0].replace(/[)\].,;!?]+$/g, '');
    if (!seen.has(clean)) {
      seen.add(clean);
      links.push(clean);
    }
  }
  return links.join(' ');
}

function extractAliExpressLinksByLine(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => /(?:s\.click\.)?aliexpress\.com/i.test(line))
    .map(line => line.replace(/^[-•*]\s*/, '').replace(/[)\].,;!?]+$/g, ''));
}

function isPhoneProduct(title, text) {
  const combined = ((title || '') + ' ' + (text || '')).toLowerCase();
  const phoneKeywords = [
    'smartphone', 'phone', 'iphone', 'samsung', 'galaxy', 'xiaomi', 'redmi',
    'poco', 'realme', 'oppo', 'vivo', 'oneplus', 'huawei', 'honor', 'nokia',
    'motorola', 'pixel', 'nothing phone', 'zte', 'infinix', 'tecno', 'itel',
    'meizu', 'lenovo', 'asus', 'rog phone', 'sony xperia', 'google pixel',
    'nubia', 'cubot', 'doogee', 'ulefone', 'umidigi', 'oukitel', 'blackview',
    'oscal', 'fossibot', 'hotwav', 'agm', 'unihertz', 'cat phone',
    'tcl', 'alcatel', 'wiko', 'fairphone', 'sharp aquos', 'hisense',
    'coolpad', 'micromax', 'lava', 'karbonn', 'gionee', 'leagoo',
    'vernee', 'elephone', 'bluboo', 'homtom', 'leeco', 'letv',
    'snapdragon', 'dimensity', 'mediatek', 'helio', 'exynos', 'kirin',
    'amoled', 'هاتف', 'موبايل', 'جوال', 'تلفون', 'سمارتفون',
    '5g phone', '4g phone', 'cellphone', 'cell phone', 'mobile phone',
    'dual sim', 'sim card', 'nfc phone'
  ];
  if (phoneKeywords.some(kw => combined.includes(kw))) return true;

  const phonePatterns = [
    /\b\d+mp\s*\+\s*\d+mp/i,
    /\b\d+mp\s+(camera|rear|front|main)/i,
    /\b\d+\s*gb\s*[\/+]\s*\d+\s*(gb|tb)\b/i,
    /\b\d{4,5}\s*mah\b/i,
    /\b[a-z]+\s+\d{1,3}\s*(pro|ultra|plus|max|lite|mini|se|gt|neo|note|prime|star|play|power|turbo|edge|fold|flip|zoom|fe)\b/i,
  ];
  return phonePatterns.some(p => p.test(combined));
}

function detectLinkType(url, text) {
  if (url) {
    const u = url.toLowerCase();
    if (u.includes('coin-index') || u.includes('syicon') || u.includes('sourcetype=555') || u.includes('/p/coin')) return 'coin';
    if (u.includes('sourcetype=620') || u.includes('channel=coin') || u.includes('point')) return 'point';
    if (u.includes('sourcetype=562') || u.includes('super')) return 'super';
    if (u.includes('sourcetype=570') || u.includes('limited') || u.includes('limit')) return 'limit';
    if (u.includes('bundledeals') || u.includes('sourcetype=561') || u.includes('bundle')) return 'ther3';
  }
  if (text) {
    const t = text.toLowerCase();
    if (t.includes('🪙') || t.includes('coin') || t.includes('كوين')) return 'coin';
    if (t.includes('⭐') || t.includes('point') || t.includes('بوينت') || t.includes('نقاط')) return 'point';
    if (t.includes('🔥') || t.includes('super') || t.includes('سوبر')) return 'super';
    if (t.includes('⚡') || t.includes('limited') || t.includes('محدود')) return 'limit';
    if (t.includes('bundle') || t.includes('باندل') || t.includes('حزمة')) return 'ther3';
  }
  return null;
}

function extractAliExpressLinks(text) {
  if (!text) return [];
  const patterns = [
    // مع https/http
    /https?:\/\/[^\s<>"'،,؛;]*aliexpress\.com[^\s<>"'،,؛;]*/gi,
    // بدون بروتوكول — يدعم أي عدد من النطاقات الفرعية (s.click., a., star., www., الخ)
    /(?:^|[\s\(\[\<،,؛;!?\n])((?:[\w-]+\.)*aliexpress\.com\/[^\s<>"'،,؛;\)\]]+)/gim,
    // ملاذ أخير: التقاط المعرف فقط من s.click.aliexpress.com/e/_xxx حتى لو كان ملتصقاً بنص
    /((?:[\w-]+\.)*aliexpress\.com\/(?:e|item|deep_link)\/[\w\-_.]+)/gi
  ];
  const links = new Set();
  for (const pattern of patterns) {
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text)) !== null) {
      let clean = (m[1] || m[0]).trim().replace(/[)}\]>،,؛;!?\.]+$/, '');
      if (!/^https?:\/\//i.test(clean)) clean = 'https://' + clean;
      // فلترة الروابط القصيرة جداً غير الصالحة
      if (clean.length > 25 && /aliexpress\.com\/.+/i.test(clean)) {
        links.add(clean);
      }
    }
  }
  return [...links];
}

function extractPrice(text) {
  if (!text) return null;
  const patterns = [
    /(\d+[\.,]?\d*)\s*(?:د\.ج|DA|DZD|دج)/i,
    /(\d+[\.,]?\d*)\s*(?:\$|USD|€|EUR)/i,
    /(?:السعر|Price|سعر|الثمن|prix)[:\s]*(\d+[\.,]?\d*)/i,
    /(\d+[\.,]?\d*)\s*(?:ج|جنيه|ريال|درهم)/i,
    /💰[:\s]*(\d+[\.,]?\d*)/,
    /(\d+[\.,]?\d*)\s*\$/,
    /\$\s*(\d+[\.,]?\d*)/,
    /(\d{1,6}[\.,]?\d{0,2})\s*(?:dollar|دولار)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const priceStr = match[2] || match[1];
      if (priceStr && parseFloat(priceStr.replace(',', '.')) > 0.5) {
        return priceStr;
      }
    }
  }
  return null;
}

const SHARED_CREDS_FILE = path.join(__dirname, 'app_credentials.json');

function loadSharedCredentials() {
  try {
    if (fs.existsSync(SHARED_CREDS_FILE)) {
      return JSON.parse(fs.readFileSync(SHARED_CREDS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

let cachedConfig = null;
let cachedConfigTime = 0;
const SPY_CONFIG_CACHE_DURATION = 60 * 1000;

async function getCachedConfig() {
  const now = Date.now();
  if (cachedConfig && (now - cachedConfigTime) < SPY_CONFIG_CACHE_DURATION) {
    return cachedConfig;
  }
  try {
    cachedConfig = await loadConfig();
    cachedConfigTime = now;
    return cachedConfig;
  } catch (e) {
    return cachedConfig || {};
  }
}

function invalidateConfigCache() {
  cachedConfig = null;
  cachedConfigTime = 0;
}

async function getBotToken() {
  // Environment variables (Render) take priority
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const shared = loadSharedCredentials();
  if (shared.botToken) return shared.botToken;
  const config = await getCachedConfig();
  return config.botToken || '';
}

async function getCookie() {
  // Environment variables (Render) take priority
  if (process.env.cook) return process.env.cook;
  const shared = loadSharedCredentials();
  if (shared.cook) return shared.cook;
  const config = await getCachedConfig();
  const cookie = config.cook || '';
  if (!cookie) {
    console.log('⚠️ الكوكي غير موجود — تأكد من إدخاله في صفحة الإعدادات الرئيسية');
  }
  return cookie;
}

let spyClient = null;
let spyRunning = false;
let authState = { step: 'idle', phoneCodeHash: null };
let reviewBot = null;
const pendingReviews = new Map();
const editingState = new Map(); // userId -> { reviewId }

const PENDING_REVIEWS_FILE = path.join(__dirname, 'spy_pending_reviews.json');

function savePendingReviews() {
  try {
    const obj = {};
    for (const [id, review] of pendingReviews.entries()) obj[id] = review;
    fs.writeFileSync(PENDING_REVIEWS_FILE, JSON.stringify(obj));
  } catch (e) {
    console.log('⚠️ فشل حفظ المراجعات المعلقة:', e.message);
  }
}

function loadPendingReviews() {
  try {
    if (fs.existsSync(PENDING_REVIEWS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_REVIEWS_FILE, 'utf8'));
      for (const [id, review] of Object.entries(data)) pendingReviews.set(id, review);
      if (pendingReviews.size > 0) console.log(`📋 تم استعادة ${pendingReviews.size} مراجعة معلقة من الملف`);
    }
  } catch (e) {
    console.log('⚠️ فشل تحميل المراجعات المعلقة:', e.message);
  }
}

loadPendingReviews();

async function loadAuthState() {
  try {
    const dbState = await db.getAuthState();
    if (dbState && Object.keys(dbState).length > 0) {
      authState = dbState;
      console.log(`✅ تم استعادة حالة المصادقة من قاعدة البيانات: ${authState.step}`);
      return authState;
    }
  } catch (e) {
    console.log(`⚠️ فشل تحميل حالة المصادقة من DB: ${e.message}`);
  }
  try {
    if (fs.existsSync(AUTH_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, 'utf8'));
      authState = data;
      console.log(`✅ تم استعادة حالة المصادقة من الملف: ${authState.step}`);
      return authState;
    }
  } catch (e) {
    console.log(`⚠️ فشل استعادة حالة المصادقة: ${e.message}`);
  }
  authState = { step: 'idle', phoneCodeHash: null };
  return authState;
}

async function saveAuthState() {
  try {
    await db.saveAuthState(authState);
  } catch (e) {
    console.log(`⚠️ فشل حفظ حالة المصادقة في DB: ${e.message}`);
  }
  try {
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(authState));
  } catch (e) {
    console.log(`⚠️ فشل حفظ حالة المصادقة في الملف: ${e.message}`);
  }
}

function startReviewBot(botToken) {
  if (reviewBot) return;
  try {
    reviewBot = new Telegraf(botToken);

    reviewBot.action('noop', (ctx) => ctx.answerCbQuery());

    reviewBot.command('store', async (ctx) => {
      try {
        const config = await getCachedConfig();
        const appUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '';
        if (!appUrl) {
          await ctx.reply('⚠️ لم يتم تعيين رابط التطبيق. أضف APP_URL في متغيرات البيئة.');
          return;
        }
        const storeUrl = appUrl.replace(/\/$/, '') + '/store';
        await ctx.reply('🛍 *متجر AliOffers DZ*\n\nتصفح أحدث العروض والمنتجات مباشرة من هنا 👇', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🛍 فتح المتجر', web_app: { url: storeUrl } }
            ]]
          }
        });
      } catch (e) {
        console.log('Store command error:', e.message);
      }
    });

    reviewBot.action('spy_approve_all', async (ctx) => {
      const config = await getCachedConfig();
      if (config.ownerId && String(ctx.from.id) !== String(config.ownerId)) {
        await ctx.answerCbQuery('غير مصرح لك');
        return;
      }
      const count = pendingReviews.size;
      if (count === 0) {
        await ctx.answerCbQuery('لا توجد منشورات معلقة');
        return;
      }
      await ctx.answerCbQuery(`جاري نشر ${count} منشور...`);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: `✅ تم نشر الكل (${count})`, callback_data: 'noop' }]] });
      const allReviews = Array.from(pendingReviews.entries());
      pendingReviews.clear();
      savePendingReviews();
      for (const [rid, review] of allReviews) {
        try {
          await executePublish(review);
          console.log(`✅ نشر (الكل): ${rid}`);
        } catch (e) {
          console.log(`❌ فشل نشر (الكل) ${rid}: ${e.message}`);
        }
      }
    });

    reviewBot.action('spy_skip_all', async (ctx) => {
      const config = await getCachedConfig();
      if (config.ownerId && String(ctx.from.id) !== String(config.ownerId)) {
        await ctx.answerCbQuery('غير مصرح لك');
        return;
      }
      const count = pendingReviews.size;
      if (count === 0) {
        await ctx.answerCbQuery('لا توجد منشورات معلقة');
        return;
      }
      await ctx.answerCbQuery(`تم تخطي ${count} منشور`);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: `⏭ تم تخطي الكل (${count})`, callback_data: 'noop' }]] });
      for (const [rid, review] of pendingReviews.entries()) {
        addLogEntry({ status: 'skipped', title: review.productTitle || 'تم التخطي', source: review.sourceName });
      }
      pendingReviews.clear();
      savePendingReviews();
      console.log(`⏭ تم تخطي الكل (${count})`);
    });

    reviewBot.action('spy_edit_cancel', async (ctx) => {
      editingState.delete(String(ctx.from.id));
      await ctx.answerCbQuery('تم إلغاء التعديل');
      try { await ctx.deleteMessage(); } catch (e) {}
    });

    reviewBot.action(/^spy_approve_(.+)$/, async (ctx) => {
      const config = await getCachedConfig();
      if (config.ownerId && String(ctx.from.id) !== String(config.ownerId)) {
        await ctx.answerCbQuery('غير مصرح لك');
        return;
      }
      const reviewId = ctx.match[1];
      const review = pendingReviews.get(reviewId);
      if (!review) {
        await ctx.answerCbQuery('انتهت صلاحية هذا المنتج');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '⏰ منتهي الصلاحية', callback_data: 'noop' }]] });
        return;
      }
      pendingReviews.delete(reviewId);
      savePendingReviews();
      await ctx.answerCbQuery('جاري النشر...');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '⏳ جاري النشر...', callback_data: 'noop' }]] });
      try {
        await executePublish(review);
        console.log(`✅ تمت الموافقة والنشر: ${reviewId}`);
        await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ تم النشر بنجاح', callback_data: 'noop' }]] });
        try {
          const targets = (review.targetIds || []).join(', ');
          await ctx.reply(`✅ تم النشر بنجاح في: ${targets}`);
        } catch (e) {}
      } catch (e) {
        console.log(`❌ فشل النشر بعد الموافقة: ${e.message}`);
        await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '❌ فشل النشر', callback_data: 'noop' }]] });
        try { await ctx.reply(`❌ فشل النشر: ${e.message}`); } catch (e2) {}
      }
    });

    reviewBot.action(/^spy_skip_(.+)$/, async (ctx) => {
      const config = await getCachedConfig();
      if (config.ownerId && String(ctx.from.id) !== String(config.ownerId)) {
        await ctx.answerCbQuery('غير مصرح لك');
        return;
      }
      const reviewId = ctx.match[1];
      const review = pendingReviews.get(reviewId);
      pendingReviews.delete(reviewId);
      savePendingReviews();
      await ctx.answerCbQuery('تم التخطي');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '⏭ تم التخطي', callback_data: 'noop' }]] });
      addLogEntry({ status: 'skipped', title: (review && review.productTitle) || 'تم التخطي يدوياً', reviewId });
      console.log(`⏭ تم تخطي المنتج: ${reviewId}`);
    });

    reviewBot.action(/^spy_edit_(.+)$/, async (ctx) => {
      const config = await getCachedConfig();
      if (config.ownerId && String(ctx.from.id) !== String(config.ownerId)) {
        await ctx.answerCbQuery('غير مصرح لك');
        return;
      }
      const reviewId = ctx.match[1];
      const review = pendingReviews.get(reviewId);
      if (!review) {
        await ctx.answerCbQuery('انتهت صلاحية هذا المنتج');
        return;
      }
      editingState.set(String(ctx.from.id), { reviewId });
      await ctx.answerCbQuery('أرسل النص الجديد');
      await ctx.reply(
        `✏️ *وضع التعديل*\n\nأرسل النص الجديد للمنشور الآن.\n\n_النص الحالي:_\n\`\`\`\n${review.message.substring(0, 600)}${review.message.length > 600 ? '...' : ''}\n\`\`\``,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء التعديل', callback_data: 'spy_edit_cancel' }]] }
        }
      );
    });

    reviewBot.on('text', async (ctx) => {
      const userId = String(ctx.from.id);
      const state = editingState.get(userId);
      if (!state) return;

      const { reviewId } = state;
      const review = pendingReviews.get(reviewId);
      if (!review) {
        editingState.delete(userId);
        await ctx.reply('⚠️ انتهت صلاحية هذا المنشور.');
        return;
      }

      const newText = ctx.message.text.trim();
      if (!newText) {
        await ctx.reply('⚠️ النص فارغ، حاول مرة أخرى.');
        return;
      }

      review.message = newText;
      pendingReviews.set(reviewId, review);
      savePendingReviews();
      editingState.delete(userId);

      await ctx.reply('✅ تم تحديث النص بنجاح! اضغط *نشر* في الرسالة الأصلية للنشر.', { parse_mode: 'Markdown' });
      console.log(`✏️ تم تعديل المنشور: ${reviewId}`);
    });

    reviewBot.launch({ dropPendingUpdates: false });
    console.log('🤖 بوت المراجعة يعمل');
  } catch (e) {
    console.log('⚠️ فشل تشغيل بوت المراجعة:', e.message);
    reviewBot = null;
  }
}

function stopReviewBot() {
  if (reviewBot) {
    try { reviewBot.stop(); } catch (e) {}
    reviewBot = null;
    editingState.clear();
    console.log('🤖 تم إيقاف بوت المراجعة');
  }
}

async function executePublish(review) {
  const { message, targetIds, sourceName, originalLink, affiliateLink, productTitle, productPrice, imageUrlForLog } = review;
  let productImage = review.productImage;
  const botToken = await getBotToken();
  if (!botToken) {
    console.log('❌ فشل النشر: لا يوجد توكن بوت');
    return;
  }

  let logImage = imageUrlForLog || (typeof productImage === 'string' && !isLikelyVideoUrl(productImage) ? productImage : null);

  // شبكة أمان: إذا لا يوجد URL لكن لدينا Buffer، احفظه محلياً للحصول على URL قابل للحفظ
  if (!logImage && productImage && typeof productImage === 'object' && Buffer.isBuffer(productImage.source)) {
    try {
      const cachedUrl = cacheImageBufferAsUrl(productImage.source);
      if (cachedUrl) {
        logImage = cachedUrl;
        console.log(`💾 [executePublish] حُفظت الصورة محلياً للمنشورات المحفوظة: ${cachedUrl}`);
      }
    } catch (e) { console.log(`⚠️ فشل حفظ الصورة محلياً: ${e.message}`); }
  }

  const config = await getCachedConfig();
  if (isDailyLimitReached(config)) {
    console.log(`🚫 تم بلوغ الحد اليومي عند النشر (${config.dailyLimit}) — إلغاء`);
    addLogEntry({
      source: sourceName, originalLink, affiliateLink,
      title: productTitle, price: productPrice, image: logImage,
      status: 'daily_limit', targets: targetIds, message
    });
    return;
  }

  if (!message || typeof message !== 'string') {
    console.log('❌ فشل النشر: الرسالة فارغة أو غير صحيحة');
    addLogEntry({ source: sourceName, originalLink, status: 'publish_failed', error: 'رسالة فارغة' });
    return;
  }

  if (message.length > 4096) {
    console.log(`⚠️ الرسالة طويلة جداً (${message.length} حرف) — تقصير...`);
  }

  const publishBot = new Telegraf(botToken);
  let publishedCount = 0;
  const textMessage = message.length > 4096 ? message.substring(0, 4090) + '...' : message;
  const captionMessage = message.length > 1000 ? message.substring(0, 997) + '...' : message;

  // تطبيق الإطار + اللوقو إذا كان مفعّلاً
  if (config.applyFrame) {
    try {
      const framedBuf = await applyFrameToImage(productImage, logImage, {
        position: config.watermarkPosition || 'bottom-right',
        size: config.watermarkSize || 'medium'
      }, {
        removeBg: !!config.removeBackground,
        postText: message,
        price: productPrice || null
      });
      if (framedBuf) {
        productImage = { source: framedBuf };
        console.log('🖼️ تم تطبيق الإطار على صورة المنشور');
      } else {
        console.log('⚠️ تعذّر تطبيق الإطار — سيُنشر بالصورة الأصلية');
      }
    } catch (frameErr) {
      console.log('⚠️ خطأ في تطبيق الإطار:', frameErr.message);
    }
  }

  for (const target of targetIds) {
    try {
      if (!target) {
        console.log('❌ معرف القناة فارغ');
        continue;
      }
      // النظام الذكي: 5 محاولات قبل اللجوء للنص فقط
      const result = await smartSendPostSpy(publishBot, target, captionMessage, textMessage, productImage, logImage);
      console.log(`✅ تم النشر في ${target} (via=${result.via})`);
      // إن كانت الرسالة طويلة جداً وأُرسلت كصورة (caption < 1000)، أرسل النص الكامل في رسالة منفصلة
      if (message.length > 1000 && ['primary', 'buffer', 'url_retry'].includes(result.via)) {
        try { await publishBot.telegram.sendMessage(target, textMessage, { parse_mode: 'HTML' }); } catch (e) {}
      }
      publishedCount++;
    } catch (pubErr) {
      console.log(`❌ فشل النشر في ${target}: ${pubErr.message}`);
      addLogEntry({ source: sourceName, target, originalLink, affiliateLink, status: 'publish_failed', error: pubErr.message });
    }
  }

  let finalStatus = publishedCount > 0 ? 'published' : 'publish_failed';
  if (publishedCount > 0) {
    incrementDailyCount();
    console.log(`📊 النشر اليومي: ${getDailyCount()}`);

    const fbToken = process.env.FACEBOOK_PAGE_TOKEN || config.facebookPageToken;
    const fbPageId = process.env.FACEBOOK_PAGE_ID || config.facebookPageId;
    if (config.facebookEnabled && fbToken && fbPageId) {
      try {
        const fbMessage = message.replace(/<[^>]*>/g, '');
        const fbResult = await postToFacebookPage(
          fbToken,
          fbPageId,
          fbMessage,
          logImage,
          affiliateLink || originalLink
        );
        console.log(`✅ تم النشر على فيسبوك (Post ID: ${fbResult.postId})`);
      } catch (fbErr) {
        console.log(`⚠️ فشل النشر على فيسبوك: ${fbErr.message}`);
      }
    }

    try {
      let imageBase64 = '';
      let imageMime = '';
      if (productImage && typeof productImage === 'object' && Buffer.isBuffer(productImage.source)) {
        imageBase64 = productImage.source.toString('base64');
        imageMime = 'image/jpeg';
      }
      const postData = JSON.stringify({
        id: `spy_${Date.now()}`,
        title: productTitle || '',
        price: productPrice || '',
        link: affiliateLink || originalLink || '',
        image: logImage || '',
        message: message || '',
        createdAt: new Date().toISOString(),
        imageBase64,
        imageMime
      });
      const options = {
        hostname: '127.0.0.1',
        port: parseInt(process.env.PORT) || 5000,
        path: '/api/saved-posts',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };
      const req2 = http.request(options);
      req2.on('error', () => {});
      req2.write(postData);
      req2.end();
    } catch (e) {}
  }
  addLogEntry({
    source: sourceName, originalLink, affiliateLink,
    title: productTitle, price: productPrice, image: logImage,
    status: finalStatus, targets: targetIds, message
  });
}

async function sendForReview(botToken, ownerId, review) {
  const reviewId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  pendingReviews.set(reviewId, review);

  const pendingCount = pendingReviews.size;
  const bot = new Telegraf(botToken);

  const rows = [
    [
      { text: '✅ نشر', callback_data: `spy_approve_${reviewId}` },
      { text: '⏭ تخطي', callback_data: `spy_skip_${reviewId}` }
    ],
    [
      { text: '✏️ تعديل النص', callback_data: `spy_edit_${reviewId}` }
    ]
  ];
  if (pendingCount > 1) {
    rows.push([
      { text: `📢 نشر الكل (${pendingCount})`, callback_data: 'spy_approve_all' },
      { text: `🗑 تخطي الكل`, callback_data: 'spy_skip_all' }
    ]);
  }
  const keyboard = { inline_keyboard: rows };

  const metaLines = [
    `📋 منتج جديد للمراجعة (${pendingCount} في الانتظار)`,
    `📡 المصدر: ${review.sourceName || 'غير معروف'}`,
    review.productTitle ? `📦 ${review.productTitle}` : '',
    review.productPrice ? `💰 ${review.productPrice}` : '',
    `📢 القنوات: ${(review.targetIds || []).join(', ')}`
  ].filter(Boolean).join('\n');

  const postPreview = review.message ? review.message.substring(0, 300) + (review.message.length > 300 ? '...' : '') : '';
  const fullMsg = `${metaLines}\n\n──────────────\n${postPreview}`;

  const sendMsg = async (caption) => {
    if (review.productImage) {
      const safeCaption = caption.substring(0, 950);
      await bot.telegram.sendPhoto(ownerId, review.productImage, { caption: safeCaption, reply_markup: keyboard });
    } else {
      await bot.telegram.sendMessage(ownerId, caption.substring(0, 4000), { reply_markup: keyboard });
    }
  };

  try {
    await sendMsg(fullMsg);
    savePendingReviews();
    console.log(`📋 تم إرسال طلب المراجعة: ${reviewId}`);
  } catch (e) {
    console.log(`⚠️ فشل إرسال طلب المراجعة (${e.message}) — محاولة بنص مختصر`);
    try {
      const shortMsg = `📋 منتج جديد للمراجعة (${pendingCount} في الانتظار)\n📡 ${review.sourceName || 'غير معروف'}\n📦 ${review.productTitle || ''}`;
      await sendMsg(shortMsg);
      savePendingReviews();
    } catch (e2) {
      console.log(`❌ فشل إرسال طلب المراجعة نهائياً: ${e2.message}`);
      pendingReviews.delete(reviewId);
      savePendingReviews();
    }
  }
}

async function extractPriceWithAI(text) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ text });
    const options = {
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT) || 5000,
      path: '/api/ai-extract-price',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.success && parsed.price ? parsed.price : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

async function extractCouponWithAI(text) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ text });
    const options = {
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT) || 5000,
      path: '/api/ai-extract-coupon',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const c = parsed.success && parsed.coupon ? parsed.coupon : null;
          resolve(c && !/^(null|undefined|none|coupon:?\s*null)$/i.test(String(c).trim()) ? c : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

function cleanTitle(t) {
  if (!t) return t;
  return t
    .replace(/`{1,3}[\w]*\s*/g, '')
    .replace(/`/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('{') && !l.startsWith('}') && !/^(json|```)$/i.test(l))
    .join(' ')
    .replace(/^(json|result|العنوان|النتيجة)[\s:]+/i, '')
    .replace(/[*#"'{}[\]`]/g, '')
    .trim();
}

function callAiRefine(title, isHook) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ title, isHook });
    const options = {
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT) || 5000,
      path: '/api/ai-refine-title',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const result = parsed.success ? parsed.refinedTitle : null;
          console.log(`📨 AI refine response: method=${parsed.method}, result="${(result || '').substring(0, 80)}"`);
          resolve(result || (isHook ? '' : title));
        } catch (e) {
          console.log(`⚠️ AI refine parse error: ${e.message}`);
          resolve(isHook ? '' : title);
        }
      });
    });
    req.on('error', (e) => {
      console.log(`⚠️ AI refine request error: ${e.message}`);
      resolve(isHook ? '' : title);
    });
    req.setTimeout(15000, () => {
      console.log(`⚠️ AI refine timeout (15s)`);
      req.destroy();
      resolve(isHook ? '' : title);
    });
    req.write(postData);
    req.end();
  });
}

function shortenTitleFallback(title) {
  if (!title || title.length <= 80) return title;
  // لا نقطع أسماء الهواتف أبداً
  const looksLikePhone = /\b(poco|xiaomi|redmi|samsung|galaxy|iphone|apple|oppo|realme|oneplus|motorola|nokia|huawei|honor|vivo|tecno|infinix)\b/i.test(title)
    || /\d+\s*\/\s*\d+\s*GB/i.test(title);
  if (looksLikePhone) return title;
  const junk = /\b(for|with|and|the|a|an|in|on|at|to|of|by|from|Global Version|Free Shipping|Original|New Arrival|Hot Sale|2024|2025|2026|High Quality)\b/gi;
  let short = title.replace(junk, ' ').replace(/\s{2,}/g, ' ').trim();
  const words = short.split(/\s+/);
  if (words.length > 10) short = words.slice(0, 10).join(' ');
  return short;
}

async function extractPhoneNameWithAI(text) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ text });
    const options = {
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT) || 5000,
      path: '/api/ai-extract-phone-name',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.success && parsed.phoneName ? parsed.phoneName : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

async function extractProductInfoWithAI(text, apiTitle) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ text, apiTitle });
    const options = {
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT) || 5000,
      path: '/api/ai-extract-product-info',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.success && parsed.productInfo ? parsed.productInfo : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

async function refineTitle(title) {
  return callAiRefine(title, false);
}

async function extractSellerCouponWithAI(text) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ text });
    const options = {
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT) || 5000,
      path: '/api/ai-extract-seller-coupon',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.success && parsed.sellerCoupon ? parsed.sellerCoupon : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

async function generateHook(title) {
  return callAiRefine(title, true);
}

async function analyzePostFull(text) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ text });
    const options = {
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT) || 5000,
      path: '/api/ai-analyze-post',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.success && parsed.result ? parsed.result : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

// التحقق البصري من الصورة عبر Gemini — يتصل بـ /api/ai-validate-image
// strict=true → عند فشل/timeout/no_ai نرفض الصورة (للمصادر غير الموثوقة)
// strict=false → نقبل افتراضياً عند الفشل (للمصدر الاحتياطي فقط)
async function validateImageMatchesPost(buffer, postText, productTitle, strict = true) {
  return new Promise((resolve) => {
    let settled = false;
    const safeResolve = (val) => { if (!settled) { settled = true; resolve(val); } };

    if (!Buffer.isBuffer(buffer) || buffer.length < 1000) {
      console.log(`⚠️ [validate-image] صورة صغيرة جداً (${buffer?.length || 0}b) — ${strict ? 'رفض' : 'قبول'}`);
      return safeResolve(!strict);
    }
    // الصور الكبيرة جداً: في الوضع الصارم نرفض (لا bypass)
    if (buffer.length > 5 * 1024 * 1024) {
      console.log(`⚠️ [validate-image] صورة كبيرة جداً (${Math.round(buffer.length/1024)}KB) — ${strict ? 'رفض (وضع صارم)' : 'قبول'}`);
      return safeResolve(!strict);
    }
    const imageBase64 = buffer.toString('base64');
    const ext = detectImageExt(buffer);
    const mimeType = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : (ext === 'gif' ? 'image/gif' : 'image/jpeg'));
    const postData = JSON.stringify({ imageBase64, mimeType, postText: (postText || '').substring(0, 800), productTitle: productTitle || '' });
    const options = {
      hostname: '127.0.0.1',
      port: parseInt(process.env.PORT) || 5000,
      path: '/api/ai-validate-image',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // إذا الـ AI فحص فعلاً وأجاب بـ yes → تطابق
          if (parsed && parsed.matches === true && !parsed.reason) {
            return safeResolve(true);
          }
          // إذا الـ AI أجاب بـ no صريحاً → رفض
          if (parsed && parsed.matches === false) {
            return safeResolve(false);
          }
          // غير ذلك: الـ AI لم يفحص (no_ai, no_text, ai_error, no_image, exception)
          const reason = (parsed && parsed.reason) || 'unknown';
          console.log(`⚠️ [validate-image] الفحص لم يُجرَ — السبب: ${reason} → ${strict ? '❌ رفض (وضع صارم)' : '✅ قبول (وضع متساهل)'}`);
          safeResolve(!strict);
        } catch {
          console.log(`⚠️ [validate-image] فشل JSON parse → ${strict ? 'رفض' : 'قبول'}`);
          safeResolve(!strict);
        }
      });
    });
    req.on('error', () => {
      console.log(`⚠️ [validate-image] خطأ شبكة → ${strict ? 'رفض' : 'قبول'}`);
      safeResolve(!strict);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      console.log(`⏱ [validate-image] timeout بعد 15s → ${strict ? 'رفض' : 'قبول'}`);
      safeResolve(!strict);
    });
    req.write(postData);
    req.end();
  });
}

async function processPost(config, text, sourceImage, sourceName) {
  const aliLinks = extractAliExpressLinks(text);
  if (aliLinks.length === 0) return;

  let aiResult = null;
  try {
    aiResult = await analyzePostFull(text);
    if (aiResult) {
      console.log(`🧠 تحليل جيميني الشامل:`);
      console.log(`   📦 المنتج: ${aiResult.productName || '—'}`);
      console.log(`   💰 السعر: ${aiResult.price || '—'}`);
      console.log(`   🎟 كوبونات: ${(aiResult.coupons || []).join(', ') || '—'}`);
      console.log(`   🎁 قسيمة البائع: ${aiResult.sellerCoupon || '—'} ${aiResult.sellerCouponCode ? '(كود: ' + aiResult.sellerCouponCode + ')' : ''}`);
      console.log(`   🔗 روابط: ${(aiResult.links || []).length}`);
      console.log(`   📱 هاتف: ${aiResult.isPhone ? 'نعم' : 'لا'}`);
    } else {
      console.log(`⚠️ فشل تحليل جيميني الشامل — سيتم استخدام الطرق البديلة`);
    }
  } catch (e) {
    console.log(`⚠️ خطأ في تحليل جيميني: ${e.message}`);
  }

  let priceFromPost = (aiResult && aiResult.price) ? aiResult.price : null;
  if (!priceFromPost) {
    try {
      priceFromPost = await extractPriceWithAI(text);
      if (priceFromPost) {
        console.log(`🤖 سعر مستخرج بالذكاء الاصطناعي: ${priceFromPost}`);
      }
    } catch (e) {
      console.log('⚠️ فشل استخراج السعر بالذكاء الاصطناعي:', e.message);
    }
  }
  if (!priceFromPost) {
    priceFromPost = extractPrice(text);
    if (priceFromPost) console.log(`📋 سعر مستخرج بالنمط: ${priceFromPost}`);
  }
  const targetIds = (config.targetChannels || []).map(ch => {
    if (ch.startsWith('-')) return ch;
    if (ch.startsWith('@')) return ch;
    if (ch.includes('t.me/')) {
      const match = ch.match(/t\.me\/([^\/\?]+)/);
      if (match) return '@' + match[1];
    }
    return '@' + ch;
  });

  console.log(`🕵️ رصد منشور من ${sourceName} يحتوي على ${aliLinks.length} رابط`);

  // === المرحلة 1: تحويل كل الروابط إلى أفليت وجمعها ===
  const convertedLinks = [];
  const seenAffLinks = new Set();
  const seenProductIdsInPost = new Set();
  let firstProductId = null, firstApiTitle = '', firstProductImage = '', firstProductPrice = priceFromPost || '';
  const cookie = await getCookie();
  if (!cookie) {
    addLogEntry({ source: sourceName, originalLink: aliLinks[0], status: 'cookie_expired', error: 'الكوكي غير موجود — أدخله في الإعدادات الرئيسية' });
    return;
  }

  for (const originalLink of aliLinks) {
    if (await isLinkProcessed(originalLink)) {
      console.log(`🔁 تم تخطي رابط مكرر: ${originalLink.substring(0, 50)}...`);
      continue;
    }

    reserveLink(originalLink);

    try {
      let affLink = null, resolvedProductId = null;
      let result, directResult;

      if (config.useTypedLinks) {
        try {
          result = await portaffFunction(cookie, originalLink);
        } catch (typedErr) {
          console.log(`⚠️ فشل التحويل بالنوع: ${typedErr.message} — محاولة التحويل المباشر...`);
          result = null;
        }
        if (result && result.aff) {
          const linkType = config.linkType || 'coin';
          const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());
          const pickValid = (...vals) => vals.find(v => isUrl(v)) || null;
          affLink = pickValid(result.aff[linkType], result.aff.coin, result.aff.super, result.aff.point)
            || Object.values(result.aff).find(v => isUrl(v))
            || null;
          resolvedProductId = result.productId || null;
          if (affLink) console.log(`🔗 تحويل بالنوع (${linkType}): ${affLink.substring(0, 60)}...`);
          else console.log(`⚠️ لا يوجد رابط أفليت صالح في رد AliExpress (الرد ليس URL)`);
        }
        if (!affLink) {
          console.log(`⚠️ لم ينجح التحويل بالنوع — تجربة التحويل المباشر كاحتياط...`);
          try {
            directResult = await directAffLink(cookie, originalLink);
            if (directResult && directResult.affLink) {
              affLink = directResult.affLink;
              resolvedProductId = directResult.productId || resolvedProductId;
              console.log(`🔗 تحويل مباشر (احتياط): ${affLink.substring(0, 60)}...`);
            }
          } catch (directErr) {
            console.log(`❌ فشل التحويل المباشر أيضاً: ${directErr.message}`);
          }
        }
      } else {
        try {
          directResult = await directAffLink(cookie, originalLink);
          if (directResult && directResult.affLink) {
            affLink = directResult.affLink;
            resolvedProductId = directResult.productId || null;
            console.log(`🔗 تحويل مباشر: ${affLink.substring(0, 60)}...`);
          }
        } catch (directErr) {
          console.log(`❌ فشل التحويل المباشر: ${directErr.message}`);
        }
      }

      if (!affLink) {
        addLogEntry({ source: sourceName, originalLink, status: 'failed', error: 'فشل تحويل الرابط' });
        inFlightLinks.delete(normalizeAliLink(originalLink));
        continue;
      }

      markLinkProcessed(originalLink);

      // منع تكرار الرابط داخل نفس المنشور فقط
      if (seenAffLinks.has(affLink)) {
        console.log(`🔁 تخطي رابط أفليت مكرر داخل نفس المنشور`);
        continue;
      }
      seenAffLinks.add(affLink);

      // مستوى واحد فقط: نفس الرابط لا يعاد نشره خلال 24 ساعة
      if (resolvedProductId && !seenProductIdsInPost.has(resolvedProductId)) {
        seenProductIdsInPost.add(resolvedProductId);
      }

      convertedLinks.push({ affLink, originalLink, resolvedProductId });

      if (!firstProductId && resolvedProductId) {
        firstProductId = resolvedProductId;
        const preview = await fetchLinkPreview(resolvedProductId);
        if (preview) {
          console.log(`✅ بيانات المنتج (الطريقة: ${preview.method})`);
          firstApiTitle = preview.title || '';
          firstProductImage = preview.image_url || '';
          firstProductPrice = priceFromPost || preview.price || '';
        }
      }
    } catch (linkErr) {
      inFlightLinks.delete(normalizeAliLink(originalLink));
      const isCookieError = linkErr.message && (linkErr.message.includes('الكوكي منتهي') || linkErr.message.includes('login') || linkErr.message.includes('DOCTYPE'));
      const errorMsg = isCookieError ? '⚠️ الكوكي منتهي الصلاحية — جدّد الكوكي' : linkErr.message;
      console.log(`❌ خطأ في معالجة الرابط: ${errorMsg}`);
      addLogEntry({ source: sourceName, originalLink, status: isCookieError ? 'cookie_expired' : 'error', error: errorMsg });
    }
  }

  // === لا توجد روابط محوّلة بنجاح ===
  if (convertedLinks.length === 0) {
    console.log(`⚠️ لم يتم تحويل أي رابط بنجاح من المنشور`);
    return;
  }

  console.log(`✅ تم تحويل ${convertedLinks.length} رابط من أصل ${aliLinks.length} — بناء منشور واحد`);

  // === المرحلة 2: بناء منشور واحد - جلب الصورة بالترتيب الجديد ===
  let productImage = null;
  let productImageUrl = null;
  const previewLink = convertedLinks[0]?.affLink || (firstProductId ? `https://www.aliexpress.com/item/${firstProductId}.html` : null);
  const mobileProductUrl = firstProductId ? `https://m.aliexpress.com/item/${firstProductId}.html` : null;

  // دالة مساعدة: هل رابط الصورة من CDN الرسمي لـ AliExpress؟
  const isAliCdnImage = (url) => url && typeof url === 'string' && /alicdn\.com|aliexpress-media/i.test(url);

  // عنوان المنتج للتحقق البصري (إن وُجد من AI أو سيُحدَّث لاحقاً)
  const titleHintForValidation = (aiResult && aiResult.productName) ? aiResult.productName : '';

  // تتبّع المصدر النهائي للصورة (لكشف المصدر المسؤول عن صور خاطئة)
  let finalImageSource = null;

  // محاولة وضع صورة كمرشح + فحص blacklist + تحقق Gemini. ترجع true إن قُبلت.
  const tryAcceptImage = async (stepName, candidateBuffer, candidateUrl) => {
    if (!candidateBuffer || !Buffer.isBuffer(candidateBuffer)) return false;

    // 🚫 1) فحص القائمة السوداء (الصور المتكررة عبر منتجات مختلفة)
    if (isImageBlacklisted(candidateBuffer)) {
      console.log(`🚫 [${stepName}] الصورة في القائمة السوداء (افتراضية مكتشفة سابقاً) — رفض`);
      return false;
    }

    // 🤖 2) تحقق Gemini البصري
    const matches = await validateImageMatchesPost(candidateBuffer, text, titleHintForValidation);
    if (!matches) {
      console.log(`❌ [${stepName}] Gemini رفض الصورة (لا تتطابق مع المنتج)`);
      return false;
    }

    // 📊 3) تتبّع التكرار (لكشف الصور الافتراضية مستقبلاً)
    const firstOriginalLink = convertedLinks && convertedLinks[0] ? convertedLinks[0].originalLink : null;
    const tracking = trackImageUsage(candidateBuffer, firstProductId, firstOriginalLink, stepName);
    if (tracking.duplicated) {
      console.log(`⚠️ [${stepName}] صورة استُخدمت من قبل لمنتج مختلف — رفض احتياطي`);
      return false;
    }

    productImage = { source: candidateBuffer };
    productImageUrl = candidateUrl || productImageUrl;
    finalImageSource = stepName;
    console.log(`✅ [${stepName}] صورة مقبولة (مرّت كل الفحوصات)`);
    return true;
  };

  // ⭐ Simple Preview — الآن مع تحقق Gemini + blacklist (كان بدون تحقق سابقاً)
  if (!productImage && firstProductId) {
    console.log(`🖼 [⭐] محاولة Simple Preview...`);
    try {
      const sp = await fetchImageViaSimplePreview(firstProductId);
      if (sp && sp.image && !isLikelyVideoUrl(sp.image)) {
        const spBuf = await downloadImageAsBuffer(sp.image);
        if (spBuf && await tryAcceptImage('Simple Preview', spBuf, sp.image)) {
          if (!firstApiTitle && sp.title) firstApiTitle = sp.title;
        }
      }
    } catch (e) { console.log(`⚠️ Simple Preview فشل: ${e.message}`); }
  }

  // 🆕 [0bis/5] Mobile JSON Page — يقرأ imagePathList من صفحة المنتج
  if (!productImage && firstProductId) {
    console.log(`🖼 [0bis/5] محاولة Mobile JSON Page (imagePathList)...`);
    try {
      const mjResult = await fetchImageFromMobilePageJson(firstProductId);
      if (mjResult && mjResult.image && isAliCdnImage(mjResult.image) && !isLikelyVideoUrl(mjResult.image)) {
        const mjBuffer = await downloadImageAsBuffer(mjResult.image);
        if (mjBuffer && await tryAcceptImage('Mobile JSON', mjBuffer, mjResult.image)) {
          if (!firstApiTitle && mjResult.title) firstApiTitle = mjResult.title;
        }
      }
    } catch (e) { console.log(`⚠️ Mobile JSON فشل: ${e.message}`); }
  }

  // 🆕 [A] JSON-LD من صفحة المنتج (Structured Data — موثوق جداً)
  if (!productImage && firstProductId) {
    console.log(`🖼 [A] محاولة JSON-LD Structured Data...`);
    try {
      const jlResult = await fetchImageViaJsonLd(firstProductId);
      if (jlResult && jlResult.image && isAliCdnImage(jlResult.image) && !isLikelyVideoUrl(jlResult.image)) {
        const jlBuffer = await downloadImageAsBuffer(jlResult.image);
        if (jlBuffer && await tryAcceptImage('JSON-LD', jlBuffer, jlResult.image)) {
          if (!firstApiTitle && jlResult.title) firstApiTitle = jlResult.title;
        }
      }
    } catch (e) { console.log(`⚠️ JSON-LD فشل: ${e.message}`); }
  }

  // 🆕 [B] Open Graph من رابط الأفليت مباشرة (يتبع التحويلات حتى الصفحة النهائية)
  if (!productImage && previewLink) {
    console.log(`🖼 [B] محاولة OG Image من رابط الأفليت...`);
    try {
      const ogResult = await fetchImageViaAffOgImage(previewLink);
      if (ogResult && ogResult.image && isAliCdnImage(ogResult.image) && !isLikelyVideoUrl(ogResult.image)) {
        const ogBuffer = await downloadImageAsBuffer(ogResult.image);
        if (ogBuffer) await tryAcceptImage('Aff OG', ogBuffer, ogResult.image);
      }
    } catch (e) { console.log(`⚠️ Aff OG فشل: ${e.message}`); }
  }

  // 0) صورة من fetchLinkPreview
  if (!productImage && firstProductImage) {
    console.log(`🖼 [0/5] محاولة صورة fetchLinkPreview...`);
    try {
      if (!isLikelyVideoUrl(firstProductImage)) {
        const lpBuf = await downloadImageAsBuffer(firstProductImage);
        if (lpBuf) await tryAcceptImage('fetchLinkPreview', lpBuf, firstProductImage);
      }
    } catch (e) { console.log(`⚠️ فشل تحميل صورة fetchLinkPreview: ${e.message}`); }
  }

  // 1) AliExpress API
  if (!productImage && firstProductId) {
    console.log(`🖼 [1/5] محاولة AliExpress API...`);
    try {
      const apiResult = await getProductDetails(firstProductId);
      if (apiResult && apiResult.image_url && !isLikelyVideoUrl(apiResult.image_url) && isAliCdnImage(apiResult.image_url)) {
        const apiBuffer = await downloadImageAsBuffer(apiResult.image_url);
        if (apiBuffer && await tryAcceptImage('AliExpress API', apiBuffer, apiResult.image_url)) {
          if (!firstApiTitle && apiResult.title) firstApiTitle = apiResult.title;
          if (!firstProductPrice && (apiResult.sale_price || apiResult.price)) {
            firstProductPrice = priceFromPost || apiResult.sale_price || apiResult.price;
          }
        }
      } else if (apiResult && apiResult.image_url && !isAliCdnImage(apiResult.image_url)) {
        console.log(`⚠️ AliExpress API أعاد صورة خارج CDN — تجاهل`);
      }
    } catch (e) { console.log(`⚠️ فشل AliExpress API: ${e.message}`); }
  }

  // 2) Cheerio scraper
  if (!productImage && firstProductId) {
    console.log(`🖼 [2/5] محاولة Cheerio scraper...`);
    try {
      const chResult = await fetchImageFromAliExpressPageCheerio(firstProductId);
      if (chResult && chResult.image && isAliCdnImage(chResult.image) && !isLikelyVideoUrl(chResult.image)) {
        const chBuffer = await downloadImageAsBuffer(chResult.image);
        if (chBuffer) await tryAcceptImage('Cheerio', chBuffer, chResult.image);
      } else if (chResult && chResult.image && !isAliCdnImage(chResult.image)) {
        console.log(`⚠️ Cheerio أعاد صورة خارج alicdn.com — تجاهل`);
      }
    } catch (e) { console.log(`⚠️ فشل Cheerio scraper: ${e.message}`); }
  }

  // 3) Microlink.io
  if (!productImage && previewLink) {
    console.log(`🖼 [3/5] محاولة Microlink.io...`);
    try {
      const mlResult = await fetchImageViaMicrolink(previewLink);
      if (mlResult && mlResult.image && !isLikelyVideoUrl(mlResult.image)) {
        const mlBuffer = await downloadImageAsBuffer(mlResult.image);
        if (mlBuffer && await tryAcceptImage('Microlink', mlBuffer, mlResult.image)) {
          if (!firstApiTitle && mlResult.title) firstApiTitle = mlResult.title;
        }
      }
    } catch (e) { console.log(`⚠️ فشل Microlink.io: ${e.message}`); }
  }

  // 🆕 [C] بحث AliExpress بالعنوان (مفيد عند فشل كل طرق Product ID)
  if (!productImage) {
    const searchTitle = (aiResult && aiResult.productName) || firstApiTitle || '';
    if (searchTitle && searchTitle.length >= 3) {
      console.log(`🖼 [C] محاولة بحث AliExpress بالعنوان: "${searchTitle.substring(0, 60)}"...`);
      try {
        const tsResult = await fetchImageViaTitleSearch(searchTitle);
        if (tsResult && tsResult.image && isAliCdnImage(tsResult.image) && !isLikelyVideoUrl(tsResult.image)) {
          const tsBuffer = await downloadImageAsBuffer(tsResult.image);
          if (tsBuffer && await tryAcceptImage('Title Search', tsBuffer, tsResult.image)) {
            if (!firstApiTitle && tsResult.title) firstApiTitle = tsResult.title;
          }
        }
      } catch (e) { console.log(`⚠️ Title Search فشل: ${e.message}`); }
    }
  }

  // 5) صورة المنشور الأصلي من تيليجرام — الآن بفحص كامل (كانت تتجاوز كل شيء سابقاً!)
  if (!productImage && sourceImage && Buffer.isBuffer(sourceImage)) {
    console.log(`🖼 [5/5] محاولة صورة المنشور الأصلي من تيليغرام...`);
    // فحص blacklist
    if (isImageBlacklisted(sourceImage)) {
      console.log(`🚫 صورة المنشور الأصلي في القائمة السوداء — رفض`);
    } else {
      // فحص Gemini البصري بوضع متساهل (لا نرفض عند فشل AI)
      const matches = await validateImageMatchesPost(sourceImage, text, titleHintForValidation, false);
      if (!matches) {
        console.log(`❌ [Telegram Source] Gemini رفض صورة المصدر صراحةً — لن تُنشر صورة`);
      } else {
        // تتبّع التكرار (إذا كانت قناة التجسس تستخدم نفس الصورة لمنتجات مختلفة)
        const firstOriginalLink = convertedLinks && convertedLinks[0] ? convertedLinks[0].originalLink : null;
        const tracking = trackImageUsage(sourceImage, firstProductId, firstOriginalLink, 'Telegram Source');
        if (tracking.duplicated) {
          console.log(`⚠️ [Telegram Source] صورة استُخدمت لمنتجات أخرى — رفض احتياطي`);
        } else {
          productImage = { source: sourceImage };
          finalImageSource = 'Telegram Source';
          console.log(`✅ [Telegram Source] صورة مقبولة (آخر احتياط)`);
        }
      }
    }
  }

  // 📊 سجل نهائي يكشف مصدر الصورة المختار
  if (productImage && finalImageSource) {
    console.log(`📌 المصدر النهائي للصورة: [${finalImageSource}] لمنتج ${firstProductId || 'بدون ID'}`);
  } else if (!productImage) {
    console.log(`❌ لم يتم العثور على أي صورة صالحة لهذا المنشور — سيُنشر بدون صورة`);
  }

  // تحميل كـ Buffer إن وُجدت صورة كرابط نصي
  if (productImage && typeof productImage === 'string') {
    if (isLikelyVideoUrl(productImage)) {
      console.log(`⛔ تم اكتشاف رابط فيديو في productImage — إلغاء`);
      productImage = null;
    } else {
      if (!productImageUrl) productImageUrl = productImage;
      const buf = await downloadImageAsBuffer(productImage);
      if (buf) {
        productImage = { source: buf };
        console.log(`✅ تم التحميل كـ Buffer (${Math.round(buf.length/1024)}KB)`);
      }
    }
  }

  // إذا انتهى بنا الأمر بـ Buffer فقط بدون URL (مثل صورة قناة المصدر)،
  // نحفظ الـ Buffer محلياً كملف ونحصل على URL قابل للحفظ في قاعدة البيانات
  if (!productImageUrl && productImage && typeof productImage === 'object' && Buffer.isBuffer(productImage.source)) {
    const cachedUrl = cacheImageBufferAsUrl(productImage.source);
    if (cachedUrl) {
      productImageUrl = cachedUrl;
      console.log(`💾 تم حفظ الصورة محلياً: ${cachedUrl}`);
    }
  }

  // حارس نهائي: لا تسمح أبداً بحفظ رابط فيديو في image_url
  if (productImageUrl && isLikelyVideoUrl(productImageUrl)) {
    console.log(`⛔ تم اكتشاف رابط فيديو في productImageUrl — تجاهل`);
    productImageUrl = null;
  }

  let imageUrlForLog = (typeof productImage === 'string' && !isLikelyVideoUrl(productImage) ? productImage : null)
    || productImageUrl
    || (firstProductImage && !isLikelyVideoUrl(firstProductImage) ? firstProductImage : null)
    || null;

  let productTitle = (aiResult && aiResult.productName) ? aiResult.productName : firstApiTitle;
  if (!productTitle) {
    const postLines = (text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('http') && !l.startsWith('👇') && !l.includes('aliexpress.com') && !l.includes('s.click'));
    if (postLines.length > 0) {
      productTitle = postLines[0];
      console.log(`📝 استخدام عنوان المنشور كاحتياط: ${productTitle}`);
    }
  }
  if (!productTitle || productTitle === firstApiTitle) {
    try {
      const aiInfo = await extractProductInfoWithAI(text, firstApiTitle);
      if (aiInfo && aiInfo.productName) {
        productTitle = aiInfo.productName;
        console.log(`🤖 AI استخرج المنتج: "${productTitle}"`);
      } else if (firstApiTitle) {
        try { productTitle = (await refineTitle(firstApiTitle)) || firstApiTitle; } catch (aiErr) {}
      }
    } catch (e) {
      if (firstApiTitle) {
        try { productTitle = (await refineTitle(firstApiTitle)) || firstApiTitle; } catch (aiErr) {}
      }
    }
  }

  // لا نقطع أسماء الهواتف التي تحتوي على مواصفات RAM/Storage (مثل POCO F6 12/512GB)
  const isPhoneName = /\b(poco|xiaomi|samsung|iphone|oppo|realme|oneplus|motorola|nokia|huawei|vivo|honor|redmi|galaxy|pixel)\b/i.test(productTitle || '')
    || /\d+\/\d+\s*GB/i.test(productTitle || '');
  if (productTitle && productTitle.length > 80 && !isPhoneName) {
    console.log(`✂️ العنوان طويل (${productTitle.length} حرف) — تقصير يدوي`);
    productTitle = shortenTitleFallback(productTitle);
    console.log(`✂️ بعد التقصير: ${productTitle}`);
  } else if (productTitle && productTitle.length > 80 && isPhoneName) {
    console.log(`📱 عنوان هاتف طويل (${productTitle.length} حرف) — يُحتفظ به كما هو`);
  }

  const t = Object.assign({}, config.messageTemplate || {});
  // Override with latest main settings from DB (so changes in settings page take effect immediately)
  try {
    const [dbPrefix, dbSalePrice, dbLinkText, dbCouponText, dbFooter, dbBotLink, dbHashtags, dbDollarRate] = await Promise.all([
      db.getAppStorage('MSG_prefix'),
      db.getAppStorage('MSG_salePrice'),
      db.getAppStorage('MSG_linkText'),
      db.getAppStorage('MSG_couponText'),
      db.getAppStorage('MSG_footer'),
      db.getAppStorage('MSG_botLink'),
      db.getAppStorage('MSG_hashtags'),
      db.getAppStorage('MSG_dollarRate')
    ]);
    if (dbPrefix)    t.prefix    = dbPrefix;
    if (dbSalePrice) t.priceLabel = dbSalePrice;
    if (dbLinkText)  t.linkLabel  = dbLinkText;
    if (dbCouponText) t.couponLabel = dbCouponText;
    if (dbFooter)    t.footer    = dbFooter;
    if (dbBotLink)   t.botLink   = dbBotLink;
    if (dbHashtags)  t.hashtags  = dbHashtags;
    if (dbDollarRate) t.dollarRate = parseFloat(dbDollarRate) || 0;
    console.log(`💱 MSG_dollarRate from DB: ${JSON.stringify(dbDollarRate)} → t.dollarRate: ${t.dollarRate}`);
  } catch (e) {
    console.log('⚠️ تعذّر تحميل إعدادات الرسالة من DB:', e.message);
  }
  const productPrice = firstProductPrice;

  let extractedCoupon = null;
  if (aiResult && Array.isArray(aiResult.coupons) && aiResult.coupons.length > 0) {
    extractedCoupon = aiResult.coupons.join(' | ');
    console.log(`🧠 كوبونات من جيميني: ${extractedCoupon}`);
  }
  if (!extractedCoupon) {
    try {
      extractedCoupon = await extractCouponWithAI(text);
      if (extractedCoupon) console.log(`🤖 كوبون مستخرج بالذكاء الاصطناعي: ${extractedCoupon}`);
    } catch (e) {}
  }
  if (!extractedCoupon) {
    extractedCoupon = extractCouponFromPost(text);
    if (extractedCoupon) console.log(`📋 كوبون مستخرج بالأنماط: ${extractedCoupon}`);
    else console.log(`⚠️ لم يتم العثور على كوبون في النص`);
  }

  const couponPrefixes = (t.couponFilter || '').split(',').map(p => p.trim().toUpperCase()).filter(p => p);
  console.log(`🔍 Coupon filter config: "${t.couponFilter}" → prefixes: [${couponPrefixes.join(', ')}]`);
  if (couponPrefixes.length > 0 && extractedCoupon) {
    console.log(`🔍 Filtering coupon: "${extractedCoupon}" with prefixes: [${couponPrefixes.join(', ')}]`);
    const filtered = extractedCoupon.split(' | ')
      .map(c => c.trim())
      .filter(c => couponPrefixes.some(prefix => c.toUpperCase().startsWith(prefix)));
    if (filtered.length > 0) {
      extractedCoupon = filtered.join(' | ');
      console.log(`🔍 كوبونات بعد الفلترة: ${extractedCoupon}`);
    } else {
      console.log(`🚫 كل الكوبونات المستخرجة لا تطابق الفلتر — تم تجاهلها`);
      extractedCoupon = null;
    }
  }

  let fixedCoupons = (t.fixedCoupons || '').split(',').map(c => c.trim().toUpperCase()).filter(c => c);
  if (couponPrefixes.length > 0 && fixedCoupons.length > 0) {
    const filteredFixed = fixedCoupons.filter(fc => couponPrefixes.some(prefix => fc.startsWith(prefix)));
    console.log(`🔍 كوبونات ثابتة قبل الفلترة: ${fixedCoupons.join(', ')} → بعد: ${filteredFixed.join(', ')}`);
    fixedCoupons = filteredFixed;
  }
  if (fixedCoupons.length > 0) {
    const existingCoupons = extractedCoupon ? extractedCoupon.split(' | ').map(c => c.trim().toUpperCase()) : [];
    const newCoupons = fixedCoupons.filter(fc => !existingCoupons.includes(fc));
    if (newCoupons.length > 0) {
      extractedCoupon = extractedCoupon
        ? extractedCoupon + ' | ' + newCoupons.join(' | ')
        : newCoupons.join(' | ');
      console.log(`📌 كوبونات ثابتة مضافة بعد الفلترة: ${newCoupons.join(', ')}`);
    }
  }

  productTitle = cleanTitle(productTitle);

  const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let message = '';
  const quoteParts = [];
  if (t.seasonOfferEnabled && t.seasonOffer && t.seasonOffer.trim()) {
    quoteParts.push(t.seasonOffer.trim());
  }

  if (t.hookEnabled !== false) {
    try {
      const hook = await generateHook(productTitle);
      if (hook && hook.trim()) {
        quoteParts.push(hook.trim());
        console.log(`🎯 Algerian hook: "${hook.trim()}"`);
      }
    } catch (e) {
      console.log(`⚠️ Hook generation failed: ${e.message}`);
    }
  }

  if (quoteParts.length) {
    message += `<blockquote>${escH(quoteParts.join('\n'))}</blockquote>\n\n`;
  }

  if (t.headerText && t.headerText.trim()) message += `${escH(t.headerText.trim())}\n`;
  if (t.prefix) message += `${escH(t.prefix)} ${escH(productTitle)}\n`;
  else if (productTitle) message += `${escH(productTitle)}\n`;
  if (productPrice && t.priceLabel) {
    const priceDisplay = (() => {
      const num = parseFloat(String(productPrice).replace(/[^\d.]/g, ''));
      if (isNaN(num)) return String(productPrice);
      return '$' + (num % 1 === 0 ? num.toFixed(0) : parseFloat(num.toFixed(2)));
    })();
    const dzdDisplay = (() => {
      const r = parseFloat(t.dollarRate);
      if (!r || isNaN(r) || r <= 0) return null;
      const cleaned = String(productPrice).replace(/,/g, '.').replace(/[^\d.]/g, '');
      const num = parseFloat(cleaned);
      if (isNaN(num) || num <= 0) return null;
      const dz = Math.round(num * r);
      return dz.toString() + ' دج';
    })();
    message += `${escH(t.priceLabel)} [ ${escH(priceDisplay)}${dzdDisplay ? ' | ' + escH(dzdDisplay) : ''} ]\n`;
  }
  if (extractedCoupon && !/^(null|undefined|none|coupon:?\s*null)$/i.test(extractedCoupon.trim())) {
    const couponCodes = extractedCoupon.split(' | ').map(c => c.trim()).filter(Boolean);
    const couponValues = couponCodes.map(c => { const m = c.match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; });
    const maxVal = Math.max(...couponValues);
    let label = (t.couponLabel || 'كوبون').replace(/:+\s*$/, '').trim();
    if (maxVal > 0) message += `${escH(label)}: [ $${maxVal} ]\n`;
    message += `✂️ ${couponCodes.map(c => `<code>${escH(c)}</code>`).join(' | ')}\n`;
  }

  const platformCouponCodes = extractedCoupon
    ? extractedCoupon.split(' | ').map(c => c.trim().toUpperCase()).filter(Boolean)
    : [];

  const sellerCouponLines = [];
  if (aiResult && aiResult.sellerCoupon) {
    const sc = String(aiResult.sellerCoupon).trim();
    if (!platformCouponCodes.includes(sc.toUpperCase())) {
      sellerCouponLines.push(sc);
    } else {
      console.log(`⚠️ قسيمة البائع من جيميني "${sc}" موجودة ضمن الكوبونات العادية — تجاهل`);
    }
    if (aiResult.sellerCouponCode) {
      const scc = String(aiResult.sellerCouponCode).trim();
      if (!platformCouponCodes.includes(scc.toUpperCase())) {
        console.log(`🧠 كود قسيمة البائع من جيميني: ${scc}`);
      }
    }
  }
  if (sellerCouponLines.length === 0) {
    let sellerCouponText = t.sellerCoupon || '';
    if (!sellerCouponText.trim()) {
      try {
        const aiCoupon = await extractSellerCouponWithAI(text);
        if (aiCoupon) {
          const parts = aiCoupon.split(' | ').map(c => c.trim()).filter(Boolean);
          const filtered = parts.filter(c => !platformCouponCodes.includes(c.toUpperCase()));
          if (filtered.length > 0) sellerCouponText = filtered.join(' | ');
          else console.log(`⚠️ قسائم البائع AI كلها موجودة ضمن الكوبونات — تجاهل`);
        }
      } catch (e) {}
    }
    if (!sellerCouponText.trim()) {
      const regexResult = extractSellerCouponFromPost(text) || '';
      if (regexResult) {
        const parts = regexResult.split(' | ').map(c => c.trim()).filter(Boolean);
        const filtered = parts.filter(c => !platformCouponCodes.includes(c.toUpperCase()));
        if (filtered.length > 0) sellerCouponText = filtered.join(' | ');
      }
    }
    if (sellerCouponText.trim()) sellerCouponLines.push(...sellerCouponText.split(' | ').map(c => c.trim()).filter(Boolean));
  }
  if (sellerCouponLines.length > 0) {
    const couponDisplay = t.sellerCouponCode && t.sellerCouponCode.trim() ? t.sellerCouponCode.trim() : sellerCouponLines.join(' | ');
    message += `🎟 إحجز قسيمة البائع: [ ${escH(couponDisplay)} ]\n`;
  }

  message += '\n';
  // كشف عرض الباندل: من جيميني أو مباشرة من نص الرسالة الأصلية
  const bundleKeywords = /bundle\s*deals?|عروض\s*باندل|باندل|(?:سعر|تخفيض[^،.]{0,30}?|وأضف|أضف)\s*(ثلاث|ثلاثة|اثنين|اثنان|\d+)\s*قطع|افتح\s*(?:هذا\s*)?(?:الرابط|الرابط\s*أولا|أولا)|أدخل\s*أولا|ادخل\s*أولا|ثانيا\s*(?:ادخل|أدخل|أضف)|ثانياً\s*(?:ادخل|أدخل|أضف)|خليه?\s*مفتوح/i;
  const aiBundle = aiResult && (aiResult.isBundleDeal === true || aiResult.isBundleDeal === 'true');
  const textBundle = bundleKeywords.test(text || '');
  const isBundleDeal = (aiBundle || textBundle) && convertedLinks.length >= 2;
  if (isBundleDeal) {
    // استخراج عدد القطع: من جيميني أولاً، ثم من النص
    let qty = (aiResult && aiResult.bundleQuantity && Number.isInteger(aiResult.bundleQuantity) && aiResult.bundleQuantity > 1)
      ? aiResult.bundleQuantity : null;
    if (!qty) {
      const qtyMap = { 'ثلاث': 3, 'ثلاثة': 3, 'اثنين': 2, 'اثنان': 2 };
      // ابحث عن X قطع في أي سياق: سعر X قطع، تخفيض X قطع، وأضف X قطع، ثانيا...X قطع
      const qtyMatch = (text || '').match(/(?:سعر|تخفيض[^،.]{0,30}?|وأضف|أضف|لـ|لـ)\s*(ثلاث|ثلاثة|اثنين|اثنان|(\d+))\s*قطع/i)
        || (text || '').match(/(ثلاث|ثلاثة|اثنين|اثنان|(\d+))\s*قطع/i);
      if (qtyMatch) qty = qtyMap[qtyMatch[1]] || parseInt(qtyMatch[2]) || 3;
      else qty = 3;
    }
    console.log(`🛒 عرض باندل مكتشف (AI: ${aiBundle}, نص: ${textBundle}) — ${qty} قطع`);
    message += `1️⃣ أدخل أولا لهذا الرابط\n`;
    message += `${escH(convertedLinks[0].affLink)}\n\n`;
    message += `2️⃣ ثانيا أضف المنتج الى السلة من هنا\n`;
    message += `${escH(convertedLinks[1].affLink)}\n`;
    if (convertedLinks.length > 2) {
      convertedLinks.slice(2).forEach(cl => { message += `${escH(cl.affLink)}\n`; });
    }
  } else {
    if (t.linkLabel) message += `${escH(t.linkLabel)}\n`;
    convertedLinks.forEach(cl => {
      message += `${escH(cl.affLink)}\n`;
    });
  }
  if (t.footer) message += `\n${escH(t.footer)}\n`;
  if (t.botLink) message += `🔗 ${escH(t.botLink)}\n`;
  if (t.hashtags) message += `\n${escH(t.hashtags)}`;

  // === المرحلة 3: النشر ===
  const botToken = await getBotToken();
  const allOriginalLinks = convertedLinks.map(cl => cl.originalLink).join(', ');
  const firstAffLink = convertedLinks[0].affLink;

  if (isDailyLimitReached(config)) {
    console.log(`🚫 تم بلوغ الحد اليومي (${config.dailyLimit}) — تخطي النشر`);
    addLogEntry({
      source: sourceName, originalLink: allOriginalLinks, affiliateLink: firstAffLink,
      title: productTitle, price: productPrice, image: imageUrlForLog,
      status: 'daily_limit', targets: targetIds, message
    });
    return;
  }

  const reviewData = {
    message, productImage, targetIds, sourceName, originalLink: allOriginalLinks,
    affiliateLink: firstAffLink, productTitle, productPrice, imageUrlForLog,
    originalText: text
  };

  if (config.manualReview && config.ownerId && botToken) {
    console.log(`📋 إرسال للمراجعة اليدوية...`);
    addLogEntry({
      source: sourceName, originalLink: allOriginalLinks, affiliateLink: firstAffLink,
      title: productTitle, price: productPrice, image: imageUrlForLog,
      status: 'review', targets: targetIds, message
    });
    await sendForReview(botToken, config.ownerId, reviewData);
  } else if (config.autoPublish) {
    const delayMs = config.publishDelay ? randomDelay(config.delayMin || 1, config.delayMax || 5) : 0;
    const delayMinutes = Math.round(delayMs / 60000);

    if (config.notifyOwner && config.ownerId && botToken) {
      await sendOwnerNotification(botToken, config.ownerId, {
        source: sourceName, title: productTitle, price: productPrice,
        affiliateLink: firstAffLink, delayMinutes
      });
    }

    const publishFn = async () => {
      await executePublish(reviewData);
    };

    if (delayMs > 0) {
      console.log(`⏱ تأخير ${delayMinutes} دقيقة قبل النشر...`);
      addLogEntry({
        source: sourceName, originalLink: allOriginalLinks, affiliateLink: firstAffLink,
        title: productTitle, price: productPrice, image: imageUrlForLog,
        status: 'pending', targets: targetIds, scheduledDelay: delayMinutes, message
      });
      setTimeout(publishFn, delayMs);
    } else {
      await publishFn();
    }
  } else {
    addLogEntry({
      source: sourceName, originalLink: allOriginalLinks, affiliateLink: firstAffLink,
      title: productTitle, price: productPrice, image: imageUrlForLog,
      status: 'detected', targets: targetIds, message
    });
  }
}

async function startSpy(config) {
  if (spyRunning) {
    await stopSpy();
  }

  let TelegramClient, StringSession, NewMessage;
  try {
    TelegramClient = require('telegram').TelegramClient;
    StringSession = require('telegram/sessions').StringSession;
    NewMessage = require('telegram/events').NewMessage;
  } catch (e) {
    throw new Error('مكتبة telegram غير مثبّتة — ميزة التجسس غير متاحة في هذه البيئة');
  }

  const apiId = parseInt(config.apiId);
  const apiHash = config.apiHash;

  if (!apiId || !apiHash) {
    throw new Error('API ID و API Hash مطلوبان - احصل عليهما من my.telegram.org');
  }
  if (!config.targetChannels || config.targetChannels.length === 0) {
    throw new Error('يجب إضافة قناة هدف واحدة على الأقل');
  }
  if (!config.sourceChannels || config.sourceChannels.length === 0) {
    throw new Error('يجب إضافة قناة مصدر واحدة على الأقل');
  }

  const botToken = await getBotToken();
  if (!botToken && (config.autoPublish || config.manualReview)) {
    throw new Error('توكن البوت غير موجود - أضفه في إعدادات التطبيق الرئيسية');
  }
  if (config.manualReview && !config.ownerId) {
    throw new Error('وضع المراجعة اليدوية يتطلب إدخال معرف حسابك (Chat ID)');
  }

  let sessionStr = '';
  try {
    sessionStr = await db.getTelegramSession('spy');
    if (sessionStr) {
      console.log('✅ تم تحميل جلسة تيليجرام من قاعدة البيانات');
    }
  } catch (e) {
    console.log('⚠️ فشل تحميل الجلسة من DB:', e.message);
  }
  if (!sessionStr) {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        sessionStr = sessionData.session || '';
        if (sessionStr) {
          console.log('✅ تم تحميل جلسة تيليجرام من الملف — مزامنة إلى DB...');
          await db.saveTelegramSession(sessionStr, 'spy').catch(e => console.log('⚠️ فشل مزامنة الجلسة:', e.message));
        }
      }
    } catch (e) {}
  }

  if (!sessionStr) {
    throw new Error('SESSION_REQUIRED');
  }

  const session = new StringSession(sessionStr);
  spyClient = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await spyClient.connect();

  if (!await spyClient.isUserAuthorized()) {
    throw new Error('SESSION_REQUIRED');
  }

  try {
    const me = await spyClient.getMe();
    console.log(`🕵️ تم الاتصال بحساب: ${me.firstName || ''} ${me.lastName || ''} (@${me.username || 'بدون'})`);
  } catch (e) {
    console.log('🕵️ تم الاتصال بحساب تيليجرام');
  }

  console.log('🔄 جاري مزامنة المحادثات...');
  try {
    const dialogs = await spyClient.getDialogs({ limit: 100 });
    console.log(`📋 تمت مزامنة ${dialogs.length} محادثة`);
  } catch (e) {
    console.log(`⚠️ فشل مزامنة المحادثات: ${e.message}`);
  }

  const sourceUsernames = config.sourceChannels.map(ch => {
    if (ch.startsWith('@')) return ch.substring(1);
    if (ch.includes('t.me/')) {
      const match = ch.match(/t\.me\/([^\/\?]+)/);
      if (match) return match[1];
    }
    return ch;
  });

  const targetUsernames = new Set();
  const targetIdSet = new Set();
  for (const ch of (config.targetChannels || [])) {
    if (ch.startsWith('-')) {
      targetIdSet.add(ch);
      targetIdSet.add(ch.replace(/^-100/, ''));
    } else if (ch.startsWith('@')) {
      targetUsernames.add(ch.substring(1).toLowerCase());
    } else if (ch.includes('t.me/')) {
      const match = ch.match(/t\.me\/([^\/\?]+)/);
      if (match) targetUsernames.add(match[1].toLowerCase());
    } else {
      targetUsernames.add(ch.toLowerCase());
    }
  }

  for (const tgt of targetUsernames) {
    try {
      const entity = await spyClient.getEntity(tgt);
      const entityId = String(entity.id?.value ?? entity.id);
      targetIdSet.add(entityId);
    } catch (e) {}
  }

  let botId = null;
  const spyBotToken = await getBotToken();
  if (spyBotToken) {
    const tokenMatch = spyBotToken.match(/^(\d+):/);
    if (tokenMatch) botId = tokenMatch[1];
  }

  let meId = null;
  try {
    const me = await spyClient.getMe();
    meId = String(me.id?.value ?? me.id);
  } catch (e) {}

  const resolvedSourceIds = new Set();
  for (const src of sourceUsernames) {
    try {
      const entity = await spyClient.getEntity(src);
      const entityId = String(entity.id?.value ?? entity.id);
      resolvedSourceIds.add(entityId);
      console.log(`✅ تم حل القناة: ${src} → ${entity.title || src} (ID: ${entityId})`);
    } catch (e) {
      console.log(`❌ فشل حل القناة "${src}": ${e.message}`);
    }
  }

  if (resolvedSourceIds.size === 0) {
    console.log('⚠️ لم يتم حل أي قناة مصدر — تأكد أن الحساب مشترك في القنوات');
  }

  console.log(`🛡 حماية التكرار: ${targetIdSet.size} قنوات هدف محظورة، botId=${botId || 'غير معروف'}`);

  let msgCount = 0;

  spyClient.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || !msg.peerId) return;

      msgCount++;
      if (msgCount <= 10 || msgCount % 50 === 0) {
        console.log(`📨 رسالة #${msgCount} — out:${msg.out} peerId: ${JSON.stringify(msg.peerId.className || msg.peerId.constructor?.name || 'unknown')}`);
      }

      let chatEntity;
      try {
        chatEntity = await spyClient.getEntity(msg.peerId);
      } catch (e) {
        if (msgCount <= 10) console.log(`⚠️ فشل حل الكيان: ${e.message}`);
        return;
      }

      const chatUsername = (chatEntity.username || '').toLowerCase();
      const chatTitle = chatEntity.title || chatEntity.username || '';
      const chatId = String(chatEntity.id?.value ?? chatEntity.id);

      if (msgCount <= 10) {
        console.log(`📍 رسالة من: ${chatTitle} | username: ${chatUsername} | id: ${chatId}`);
      }

      if (targetIdSet.has(chatId) || targetUsernames.has(chatUsername)) {
        if (msgCount <= 20) console.log(`🚫 تخطي رسالة من قناة الهدف: ${chatTitle}`);
        return;
      }

      const isSource = resolvedSourceIds.has(chatId) ||
        sourceUsernames.some(src => {
          const srcLower = src.toLowerCase();
          return chatUsername === srcLower ||
                 chatId === src ||
                 ('-100' + chatId) === src;
        });

      if (!isSource) return;

      const msgId = msg.id;
      if (isMessageProcessed(chatId, msgId)) {
        console.log(`🔁 تخطي رسالة مكررة: ${chatTitle} #${msgId}`);
        return;
      }
      markMessageProcessed(chatId, msgId);

      console.log(`✅ رسالة مطابقة من قناة مصدر: ${chatTitle}`);

      let text = msg.message || '';
      
      let entityUrls = [];
      if (msg.entities && Array.isArray(msg.entities)) {
        for (const ent of msg.entities) {
          if (ent.className === 'MessageEntityTextUrl' || ent.url) {
            const url = ent.url || '';
            if (url && /aliexpress\.com/i.test(url)) {
              entityUrls.push(url);
              console.log(`🔗 رابط مخفي من entity: ${url.substring(0, 80)}...`);
            }
          }
          if (ent.className === 'MessageEntityUrl') {
            const urlText = text.substring(ent.offset, ent.offset + ent.length);
            if (urlText && /aliexpress\.com/i.test(urlText)) {
              const fullUrl = urlText.startsWith('http') ? urlText : 'https://' + urlText;
              entityUrls.push(fullUrl);
              console.log(`🔗 رابط من entity (URL): ${fullUrl.substring(0, 80)}`);
            }
          }
        }
      }

      if (msg.replyMarkup && msg.replyMarkup.rows) {
        for (const row of msg.replyMarkup.rows) {
          if (row.buttons) {
            for (const btn of row.buttons) {
              const btnUrl = btn.url || '';
              if (btnUrl && /aliexpress\.com/i.test(btnUrl)) {
                entityUrls.push(btnUrl);
                console.log(`🔗 رابط من زر: ${btnUrl.substring(0, 80)}...`);
              }
            }
          }
        }
      }
      
      if (entityUrls.length > 0) {
        text = text + '\n' + entityUrls.join('\n');
      }

      if (!text.trim()) {
        console.log('⚠️ رسالة فارغة (ربما صورة/فيديو بدون نص)');
        return;
      }

      const aliLinks = extractAliExpressLinks(text);
      
      if (aliLinks.length === 0) {
        console.log(`ℹ️ لا توجد روابط AliExpress في الرسالة — النص (${text.length} حرف): ${text.substring(0, 200)}`);
        return;
      }

      let sourceImage = null;
      // 1) صورة مباشرة (photo)
      if (msg.media && msg.media.photo) {
        try {
          const buffer = await spyClient.downloadMedia(msg.media);
          if (Buffer.isBuffer(buffer) && buffer.length > 1000) {
            sourceImage = buffer;
            console.log(`🖼 صورة مستخرجة من المنشور (${Math.round(buffer.length/1024)}KB)`);
          }
        } catch (imgErr) {
          console.log(`⚠️ فشل تحميل صورة المنشور: ${imgErr.message}`);
        }
      }
      // 2) صورة مرسلة كمستند (uncompressed photo or image file)
      if (!sourceImage && msg.media && msg.media.document) {
        const doc = msg.media.document;
        const mimeType = doc.mimeType || '';
        const isImage = mimeType.startsWith('image/') && !mimeType.includes('gif');
        if (isImage) {
          try {
            const buffer = await spyClient.downloadMedia(msg.media);
            if (Buffer.isBuffer(buffer) && buffer.length > 1000) {
              sourceImage = buffer;
              console.log(`🖼 صورة مستخرجة من مستند (${mimeType}, ${Math.round(buffer.length/1024)}KB)`);
            }
          } catch (docErr) {
            console.log(`⚠️ فشل تحميل صورة المستند: ${docErr.message}`);
          }
        }
      }
      // 3) صورة من معاينة الويب (webpage preview)
      if (!sourceImage && msg.media && msg.media.webpage && msg.media.webpage.photo) {
        try {
          const buffer = await spyClient.downloadMedia(msg.media.webpage.photo);
          if (Buffer.isBuffer(buffer) && buffer.length > 1000) {
            sourceImage = buffer;
            console.log(`🖼 صورة مستخرجة من معاينة الويب (${Math.round(buffer.length/1024)}KB)`);
          }
        } catch (wpErr) {
          console.log(`⚠️ فشل تحميل صورة المعاينة: ${wpErr.message}`);
        }
      }

      console.log(`🔗 وجد ${aliLinks.length} رابط AliExpress — بدء المعالجة`);
      const liveConfig = await getCachedConfig();
      const mergedConfig = { ...config, ...liveConfig, targetChannels: config.targetChannels };
      await processPost(mergedConfig, text, sourceImage, chatTitle);
    } catch (err) {
      console.log('❌ خطأ Userbot:', err.message);
    }
  }, new NewMessage({}));

  console.log(`🔍 مراقبة القنوات: ${sourceUsernames.join(', ')}`);

  spyRunning = true;
  config.enabled = true;
  invalidateConfigCache();
  await saveConfig(config);

  if (config.manualReview && botToken) {
    startReviewBot(botToken);
  }

  console.log('🕵️ تم تشغيل نظام التجسس');
}

async function stopSpy() {
  stopReviewBot();
  if (spyClient) {
    try { await spyClient.disconnect(); } catch (e) {}
    spyClient = null;
  }
  spyRunning = false;
  try {
    const config = await getCachedConfig();
    config.enabled = false;
    invalidateConfigCache();
    await saveConfig(config);
  } catch (e) {
    console.log('⚠️ فشل حفظ حالة الإيقاف:', e.message);
  }
  console.log('🛑 تم إيقاف نظام التجسس');
}

async function sendLoginCode(config) {
  let TelegramClient, StringSession;
  try {
    TelegramClient = require('telegram').TelegramClient;
    StringSession = require('telegram/sessions').StringSession;
  } catch (e) {
    throw new Error('مكتبة telegram غير مثبّتة — ميزة التجسس غير متاحة في هذه البيئة');
  }

  const apiId = parseInt(config.apiId);
  const apiHash = config.apiHash;
  const phoneNumber = config.phoneNumber;

  if (!apiId || !apiHash) throw new Error('API ID و API Hash مطلوبان');
  if (!phoneNumber) throw new Error('رقم الهاتف مطلوب');

  if (spyClient) {
    try { await spyClient.disconnect(); } catch (e) {}
    spyClient = null;
  }

  const session = new StringSession('');
  spyClient = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
  await spyClient.connect();

  const result = await spyClient.sendCode(
    { apiId, apiHash },
    phoneNumber
  );

  if (!result.phoneCodeHash) {
    throw new Error('فشل إرسال الرمز - لم يتم استلام رمز من تيليجرام');
  }
  
  authState = { step: 'code_sent', phoneCodeHash: result.phoneCodeHash, phoneNumber };
  await saveAuthState();
  console.log('✅ تم حفظ حالة الرمز المرسل، في انتظار التحقق');
  return { success: true, message: 'تم إرسال رمز التحقق إلى تيليجرام' };
}

async function verifyCode(config, code, password) {
  if (!spyClient) throw new Error('ابدأ بإرسال رمز التحقق أولاً');
  if (authState.step !== 'code_sent' && authState.step !== 'need_password') {
    throw new Error('ابدأ بإرسال رمز التحقق أولاً');
  }

  try {
    if (authState.step === 'need_password') {
      const { computeCheck } = require('telegram/Password');
      const passwordResult = await spyClient.invoke(
        new (require('telegram/tl').Api.account.GetPassword)()
      );
      const srp = await computeCheck(passwordResult, password);
      await spyClient.invoke(
        new (require('telegram/tl').Api.auth.CheckPassword)({ password: srp })
      );
    } else {
      try {
        await spyClient.invoke(
          new (require('telegram/tl').Api.auth.SignIn)({
            phoneNumber: authState.phoneNumber,
            phoneCodeHash: authState.phoneCodeHash,
            phoneCode: code
          })
        );
      } catch (e) {
        if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
          authState.step = 'need_password';
          await saveAuthState();
          return { success: false, needPassword: true, message: 'الحساب محمي بكلمة مرور - أدخل كلمة المرور' };
        }
        throw e;
      }
    }

    const sessionStr = spyClient.session.save();
    if (!sessionStr || typeof sessionStr !== 'string' || sessionStr.trim() === '') {
      throw new Error('فشل استخراج جلسة التيليجرام - الرجاء المحاولة مرة أخرى');
    }
    
    const saveDbResult = await db.saveTelegramSession(sessionStr, 'spy');
    if (!saveDbResult) {
      console.log('⚠️ تحذير: فشل حفظ الجلسة في قاعدة البيانات، محاولة الملف كبديل');
    } else {
      console.log('✅ تم حفظ جلسة تيليجرام في قاعدة البيانات');
    }
    
    try {
      fs.writeFileSync(SESSION_FILE, JSON.stringify({ session: sessionStr }));
      console.log('✅ تم حفظ جلسة تيليجرام في الملف');
    } catch (e) {
      console.log('⚠️ فشل حفظ الملف:', e.message);
    }
    
    authState = { step: 'authenticated' };
    await saveAuthState();

    await spyClient.disconnect();
    spyClient = null;

    return { success: true, message: 'تم تسجيل الدخول بنجاح! يمكنك الآن تشغيل التجسس' };
  } catch (e) {
    throw new Error('فشل التحقق: ' + e.message);
  }
}

async function getStatus() {
  const config = await getCachedConfig();
  const safeConfig = { ...config };
  safeConfig.apiHash = safeConfig.apiHash ? '****' : '';
  safeConfig.phoneNumber = safeConfig.phoneNumber ? safeConfig.phoneNumber.substring(0, 4) + '****' : '';
  safeConfig.cook = safeConfig.cook ? true : false;
  safeConfig.botToken = safeConfig.botToken ? true : false;

  let hasSession = false;
  try {
    const dbSession = await db.getTelegramSession('spy');
    hasSession = !!dbSession;
  } catch (e) {}
  if (!hasSession) {
    hasSession = fs.existsSync(SESSION_FILE);
  }

  const log = await loadLog();
  return {
    running: spyRunning,
    config: safeConfig,
    log,
    hasSession,
    authStep: authState.step
  };
}

async function logoutSpy() {
  try {
    await db.saveTelegramSession('', 'spy');
    console.log('✅ تم حذف جلسة تيليجرام من قاعدة البيانات');
  } catch (e) {
    console.log('⚠️ فشل حذف الجلسة من DB:', e.message);
  }
  
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
      console.log('✅ تم حذف ملف الجلسة المحلي');
    }
  } catch (e) {
    console.log('⚠️ فشل حذف ملف الجلسة:', e.message);
  }
  
  authState = { step: 'idle', phoneCodeHash: null };
  try {
    await saveAuthState();
  } catch (e) {
    console.log('⚠️ فشل حفظ حالة تسجيل الخروج:', e.message);
  }
  
  console.log('🚪 تم تسجيل الخروج من حساب تيليجرام');
}

module.exports = {
  loadConfig,
  saveConfig,
  invalidateConfigCache,
  startSpy,
  stopSpy,
  getStatus,
  loadLog,
  addLogEntry,
  extractAliExpressLinks,
  extractPrice,
  sendLoginCode,
  verifyCode,
  logoutSpy,
  executePublish
};
