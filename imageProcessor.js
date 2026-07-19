// إزالة خلفية المنتج عبر APIs مع تدوير المفاتيح + استخراج السعر + رسم السعر اليدوي
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const FormData = require('form-data');

// ░░░ تسجيل خط Caveat في fontconfig ░░░
let _fontReady = false;
function registerCaveatFont() {
  if (_fontReady) return;
  try {
    const os = require('os');
    const { execSync } = require('child_process');
    const fontDir = path.join(os.homedir(), '.fonts');
    if (!fs.existsSync(fontDir)) fs.mkdirSync(fontDir, { recursive: true });
    const src = path.join(__dirname, 'public', 'fonts', 'Caveat.ttf');
    const dst = path.join(fontDir, 'Caveat.ttf');
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
    try { execSync('fc-cache -f ' + fontDir, { stdio: 'pipe' }); } catch (_) {}
    _fontReady = true;
  } catch (e) {
    console.log('⚠️ تسجيل خط Caveat فشل:', e.message);
  }
}
registerCaveatFont();

// ═══════════════════════════════════════════════════════════════
// نظام تدوير مفاتيح إزالة الخلفية (Multi-provider)
// ═══════════════════════════════════════════════════════════════
// Providers مدعومة: removebg, photroom, clipdrop
// تنسيق المفتاح: "provider:key" أو فقط "key" (افتراضي removebg)
// التخزين: ملف removebg_keys.json + env REMOVEBG_API_KEYS (CSV)

const KEYS_FILE = path.join(__dirname, 'removebg_keys.json');

const PROVIDERS = {
  removebg: {
    name: 'remove.bg',
    url: 'https://api.remove.bg/v1.0/removebg',
    async call(key, buffer) {
      const form = new FormData();
      form.append('image_file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
      form.append('size', 'auto');
      form.append('format', 'png');
      const r = await axios.post(this.url, form, {
        headers: { ...form.getHeaders(), 'X-Api-Key': key },
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 20 * 1024 * 1024,
      });
      return Buffer.from(r.data);
    }
  },
  photroom: {
    name: 'Photoroom',
    url: 'https://sdk.photoroom.com/v1/segment',
    async call(key, buffer) {
      const form = new FormData();
      form.append('image_file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
      const r = await axios.post(this.url, form, {
        headers: { ...form.getHeaders(), 'x-api-key': key, 'Accept': 'image/png' },
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 20 * 1024 * 1024,
      });
      return Buffer.from(r.data);
    }
  },
  clipdrop: {
    name: 'Clipdrop',
    url: 'https://clipdrop-api.co/remove-background/v1',
    async call(key, buffer) {
      const form = new FormData();
      form.append('image_file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
      const r = await axios.post(this.url, form, {
        headers: { ...form.getHeaders(), 'x-api-key': key },
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 20 * 1024 * 1024,
      });
      return Buffer.from(r.data);
    }
  },
};

function loadRemoveBgKeys() {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
      return { keys: data.keys || [], currentIndex: data.currentIndex || 0 };
    }
  } catch (e) {
    console.log('Error loading removebg keys:', e.message);
  }
  return { keys: [], currentIndex: 0 };
}

function saveRemoveBgKeys(data) {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.log('Error saving removebg keys:', e.message);
    return false;
  }
}

// أسماء بديلة للمزوّدين (alias → canonical)
const PROVIDER_ALIASES = {
  'removebg': 'removebg', 'remove.bg': 'removebg', 'remove_bg': 'removebg', 'rembg': 'removebg',
  'photoroom': 'photroom', 'photroom': 'photroom', 'photo-room': 'photroom',
  'clipdrop': 'clipdrop', 'clip-drop': 'clipdrop',
};

// تحليل سلسلة "provider:key" → {provider, key}
function parseKeyEntry(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const colonIdx = s.indexOf(':');
  if (colonIdx > 0 && colonIdx < 20) {
    const provRaw = s.slice(0, colonIdx).toLowerCase();
    const key = s.slice(colonIdx + 1).trim();
    const canonical = PROVIDER_ALIASES[provRaw];
    if (canonical && PROVIDERS[canonical] && key.length > 8) {
      return { provider: canonical, key };
    }
  }
  // افتراضي: removebg
  if (s.length > 8) return { provider: 'removebg', key: s };
  return null;
}

// مفاتيح من env var (CSV)
function getEnvRemoveBgKeys() {
  const v = process.env.REMOVEBG_API_KEYS || process.env.REMOVE_BG_API_KEY || '';
  if (!v) return [];
  return v.split(',').map(parseKeyEntry).filter(Boolean);
}

// قائمة كل المفاتيح المتاحة (مدمجة)
function getAllKeys() {
  const file = loadRemoveBgKeys();
  const env = getEnvRemoveBgKeys();
  return [...file.keys, ...env];
}

// تدوير المؤشر (ملف فقط؛ env keys ندوّرها بالتعاقب لكن نحفظ في نفس الملف)
function rotateRemoveBgKey() {
  const data = loadRemoveBgKeys();
  const total = getAllKeys().length;
  if (total <= 1) return;
  data.currentIndex = ((data.currentIndex || 0) + 1) % total;
  saveRemoveBgKeys(data);
}

// ░░░ إزالة الخلفية مع تدوير تلقائي عند الفشل ░░░
async function removeBackground(inputBuffer) {
  const allKeys = getAllKeys();
  if (allKeys.length === 0) {
    console.log('⚠️ لا توجد مفاتيح remove.bg محفوظة — تخطّي إزالة الخلفية');
    return null;
  }
  const data = loadRemoveBgKeys();
  let startIdx = (data.currentIndex || 0) % allKeys.length;

  for (let attempt = 0; attempt < allKeys.length; attempt++) {
    const idx = (startIdx + attempt) % allKeys.length;
    const entry = allKeys[idx];
    const provider = PROVIDERS[entry.provider];
    if (!provider) continue;
    try {
      const out = await provider.call(entry.key, inputBuffer);
      // نجاح → نحفظ المؤشر للمفتاح التالي (load-balance)
      data.currentIndex = (idx + 1) % allKeys.length;
      saveRemoveBgKeys(data);
      console.log(`✅ خلفية محذوفة عبر ${provider.name} (مفتاح ${idx + 1}/${allKeys.length})`);
      return out;
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data ? Buffer.from(e.response.data).toString().slice(0, 200) : e.message;
      console.log(`⚠️ ${provider.name} مفتاح ${idx + 1} فشل (${status || '?'}): ${msg}`);
      // نواصل مع المفتاح التالي
    }
  }
  console.log('❌ كل مفاتيح إزالة الخلفية فشلت');
  return null;
}

// ░░░ استخراج السعر من نص المنشور ░░░
function extractPrice(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
  const NUM = '(\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
  const patterns = [
    new RegExp(`(?:بعد\\s*التخفيض|السعر\\s*بعد)[:\\s]+${NUM}`, 'i'),
    new RegExp(`السعر[:\\s]+\\$?\\s*${NUM}\\s*\\$?`, 'i'),
    new RegExp(`price[:\\s]+\\$?\\s*${NUM}`, 'i'),
    new RegExp(`\\$\\s*${NUM}`),
    new RegExp(`${NUM}\\s*\\$`),
    new RegExp(`${NUM}\\s*USD`, 'i'),
    new RegExp(`ب\\s+${NUM}\\s*\\$`, 'i'),
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) {
      const norm = normalizeNumber(m[1]);
      const f = parseFloat(norm);
      if (!isNaN(f) && f > 0 && f < 100000) return norm;
    }
  }
  return null;
}

function normalizeNumber(s) {
  s = String(s).trim();
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) return s.replace(/\./g, '').replace(',', '.');
    return s.replace(/,/g, '');
  } else if (lastComma > -1) {
    const commaCount = (s.match(/,/g) || []).length;
    const after = s.length - lastComma - 1;
    if (commaCount > 1 || after === 3) return s.replace(/,/g, '');
    return s.replace(',', '.');
  } else if (lastDot > -1) {
    const after = s.length - lastDot - 1;
    if (after === 3) return s.replace(/\./g, '');
    return s;
  }
  return s;
}

// ░░░ رسم السعر اليدوي على الإطار ░░░
async function overlayPrice(frameBuffer, price, opts = {}) {
  if (!price) return frameBuffer;
  const {
    x = 70, y = 240, fontSize = 130,
    color = '#0F0F1A', accent = '#E63946',
  } = opts;

  const family = 'Caveat, Comic Sans MS, cursive, sans-serif';
  const cleanPrice = String(price).replace(/[\$\s]/g, '');
  const text = `${cleanPrice}$`;
  const w = Math.round(fontSize * (text.length * 0.55 + 1));
  const h = Math.round(fontSize * 1.4);

  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <text x="6" y="${Math.round(fontSize * 1.05)}" font-family="${family}" font-size="${fontSize}" font-weight="700" fill="${color}" opacity="0.15">${text}</text>
    <text x="0" y="${fontSize}" font-family="${family}" font-size="${fontSize}" font-weight="700" fill="${color}">${text}</text>
    <path d="M 5 ${Math.round(fontSize * 1.15)} Q ${w/2} ${Math.round(fontSize * 1.25)} ${w-10} ${Math.round(fontSize * 1.15)}" stroke="${accent}" stroke-width="6" fill="none" stroke-linecap="round"/>
  </svg>`;

  const overlay = await sharp(Buffer.from(svg)).png().toBuffer();
  return await sharp(frameBuffer)
    .composite([{ input: overlay, left: x, top: y, blend: 'over' }])
    .toBuffer();
}

module.exports = {
  removeBackground, extractPrice, overlayPrice,
  // Key management API
  loadRemoveBgKeys, saveRemoveBgKeys, getAllKeys, getEnvRemoveBgKeys,
  parseKeyEntry, rotateRemoveBgKey, PROVIDERS,
};
