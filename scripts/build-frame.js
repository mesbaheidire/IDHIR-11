// إطار AliOffersDz: حدود صفراء متدرّجة + تبويبة شعار علوية + شريط شراء سفلي
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SIZE = 1024;
const YELLOW = '#FFC424';
const YELLOW_LIGHT = '#FFD960';
const YELLOW_DARK = '#E5A800';
const BLACK = '#0F0F1A';
const PURPLE = '#6E48E8';
const PURPLE_DARK = '#5538C7';

// أبعاد الإطار
const BORDER_TOP = 28;
const BORDER_SIDE = 36;
const BUY_BAR_H = 150;       // ارتفاع الشريط السفلي
const RADIUS = 32;            // نصف قطر الزوايا الخارجية
const INNER_RADIUS = 18;      // نصف قطر زوايا المساحة البيضاء
const TAB_W = 170;             // عرض تبويبة الشعار
const TAB_H = 70;              // ارتفاع التبويبة (تنزل في المساحة البيضاء)
const LOGO_SIZE = 130;         // قطر شعار البوت

const innerX = BORDER_SIDE;
const innerY = BORDER_TOP;
const innerW = SIZE - BORDER_SIDE * 2;
const innerH = SIZE - BORDER_TOP - BUY_BAR_H;
const tabX = (SIZE - TAB_W) / 2;
const logoX = (SIZE - LOGO_SIZE) / 2;
const logoY = -10;             // الشعار يبرز فوق حافة الإطار

(async () => {
  // ░░░ تحميل الشعار ░░░
  const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
  const logoBuf = await sharp(logoPath).resize(LOGO_SIZE, LOGO_SIZE, { fit: 'cover' }).png().toBuffer();

  // ░░░ بناء SVG للإطار ░░░
  const frameSvg = `
<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gradFrame" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${YELLOW_LIGHT}"/>
      <stop offset="50%" stop-color="${YELLOW}"/>
      <stop offset="100%" stop-color="${YELLOW_DARK}"/>
    </linearGradient>
    <linearGradient id="gradBuyBar" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${YELLOW_DARK}"/>
      <stop offset="50%" stop-color="${YELLOW}"/>
      <stop offset="100%" stop-color="${YELLOW_DARK}"/>
    </linearGradient>
    <linearGradient id="gradPurple" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${PURPLE}"/>
      <stop offset="100%" stop-color="${PURPLE_DARK}"/>
    </linearGradient>
    <filter id="softShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
      <feOffset dx="0" dy="3"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.25"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- ░ الخلفية الصفراء الكاملة (الإطار الخارجي) ░ -->
  <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#gradFrame)"/>

  <!-- ░ المساحة البيضاء الداخلية (للمنتج) ░ -->
  <rect x="${innerX}" y="${innerY}" width="${innerW}" height="${innerH}"
        rx="${INNER_RADIUS}" fill="#FFFFFF"/>

  <!-- ░ تبويبة الشعار العلوية: امتداد بيضاوي يخرج من المساحة البيضاء للأعلى ░ -->
  <path d="M ${tabX} ${innerY}
           Q ${tabX} ${innerY - TAB_H} ${tabX + TAB_W/2 - 50} ${innerY - TAB_H/2}
           Q ${tabX + TAB_W/2} ${innerY - TAB_H - 18} ${tabX + TAB_W/2 + 50} ${innerY - TAB_H/2}
           Q ${tabX + TAB_W} ${innerY - TAB_H} ${tabX + TAB_W} ${innerY}
           Z" fill="#FFFFFF"/>

  <!-- ░ الشريط السفلي (شريط الشراء) ░ -->
  <path d="M 0 ${SIZE - BUY_BAR_H}
           L ${SIZE} ${SIZE - BUY_BAR_H}
           L ${SIZE} ${SIZE - RADIUS}
           Q ${SIZE} ${SIZE} ${SIZE - RADIUS} ${SIZE}
           L ${RADIUS} ${SIZE}
           Q 0 ${SIZE} 0 ${SIZE - RADIUS}
           Z" fill="url(#gradBuyBar)"/>

  <!-- ░ خط فاصل أنيق فوق شريط الشراء ░ -->
  <line x1="0" y1="${SIZE - BUY_BAR_H}" x2="${SIZE}" y2="${SIZE - BUY_BAR_H}"
        stroke="${YELLOW_DARK}" stroke-width="2" opacity="0.5"/>

  <!-- ░ زر السعر الفخم أسفل-يسار ░ -->
  <g transform="translate(50, ${SIZE - BUY_BAR_H/2 - 55})">
    <!-- ظل عميق -->
    <rect x="4" y="6" width="380" height="110" rx="55" fill="${BLACK}" opacity="0.35"/>
    <!-- خلفية الزر بتدرّج بنفسجي -->
    <rect x="0" y="0" width="380" height="110" rx="55" fill="url(#gradPurple)"/>
    <!-- إطار ذهبي رفيع -->
    <rect x="0" y="0" width="380" height="110" rx="55" fill="none"
          stroke="${YELLOW}" stroke-width="3"/>
    <!-- لمعة علوية -->
    <rect x="30" y="8" width="320" height="16" rx="8" fill="#FFFFFF" opacity="0.22"/>
  </g>
</svg>`;

  const baseBuf = await sharp(Buffer.from(frameSvg)).png().toBuffer();

  // تركيب الشعار في التبويبة العلوية
  const composed = await sharp(baseBuf)
    .composite([{ input: logoBuf, left: logoX, top: logoY }])
    .jpeg({ quality: 94, background: { r: 255, g: 255, b: 255 } })
    .toBuffer();

  const outPath = path.join(__dirname, '..', 'public', 'custom_frame.jpg');
  fs.writeFileSync(outPath, composed);
  console.log('✅ Built new frame: yellow border + top logo tab + bottom buy bar');

  // ═══════════════ معاينة مع منتج وسعر ═══════════════
  const { overlayPrice } = require(path.join(__dirname, '..', 'imageProcessor.js'));

  const productSvg = `<svg width="700" height="600" xmlns="http://www.w3.org/2000/svg">
    <circle cx="350" cy="300" r="240" fill="#1F2937"/>
    <text x="350" y="290" font-family="Arial Black" font-size="56" font-weight="900" fill="white" text-anchor="middle">PRODUCT</text>
    <text x="350" y="350" font-family="Arial" font-size="26" fill="#9CA3AF" text-anchor="middle">(transparent)</text>
  </svg>`;
  const productBuf = await sharp(Buffer.from(productSvg)).png().toBuffer();

  // منطقة المنتج: داخل المساحة البيضاء، تحت تبويبة الشعار
  // يبدأ عند y ≈ 130 (تحت اللوقو) وينتهي قبل شريط الشراء
  const PADX = 70;
  const prodLeft = innerX + PADX;
  const prodTop = innerY + 130;
  const prodW = innerW - PADX * 2;
  const prodH = (SIZE - BUY_BAR_H) - prodTop - 20;

  const resized = await sharp(productBuf).resize(prodW, prodH, { fit: 'inside' }).toBuffer();
  const m = await sharp(resized).metadata();
  const offX = prodLeft + Math.round((prodW - m.width) / 2);
  const offY = prodTop + Math.round((prodH - m.height) / 2);

  let preview = await sharp(outPath)
    .composite([{ input: resized, left: offX, top: offY, blend: 'over' }])
    .jpeg({ quality: 92 })
    .toBuffer();

  // السعر بخط يدوي مركّز داخل الزر البنفسجي (380x110 في 50, SIZE-130)
  preview = await overlayPrice(preview, '16.5', {
    x: 110,
    y: SIZE - 145,
    fontSize: 76,
    color: '#FFFFFF',
    accent: YELLOW,
  });

  await sharp(preview).jpeg({ quality: 92 }).toFile(path.join(__dirname, '..', 'public', 'preview_yellow.jpg'));
  console.log('✅ Preview saved');
})().catch(e => { console.error(e); process.exit(1); });
