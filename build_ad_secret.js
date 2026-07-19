const sharp = require('sharp');

const W = 1920, H = 1080;
const LOGO = 'public/ads/logo.png';
const BG = 'public/ads/bg1b_deals.png';
const OUT = 'public/ads/ad6_secret_16x9.png';

async function pangoText(text, { size, color = '#FFFFFF', weight = '900', width = W - 200, align = 'center' }) {
  const markup = `<span foreground="${color}" font_family="Cairo" font_weight="${weight}" size="${size * 1024}">${text}</span>`;
  return sharp({ text: { text: markup, font: 'Cairo', width, dpi: 72, rgba: true, align } }).png().toBuffer({ resolveWithObject: true });
}

async function withStroke(text, opts) {
  const stroke = await pangoText(text, { ...opts, color: opts.strokeColor || '#000000' });
  const fill = await pangoText(text, opts);
  const blurred = await sharp(stroke.data).blur(2.5).toBuffer({ resolveWithObject: true });
  const Wd = Math.max(blurred.info.width, fill.info.width);
  const Hd = Math.max(blurred.info.height, fill.info.height);
  return sharp({ create: { width: Wd, height: Hd, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: blurred.data, left: 0, top: 0 },
      { input: blurred.data, left: 0, top: 0 },
      { input: blurred.data, left: 0, top: 0 },
      { input: fill.data, left: Math.floor((Wd - fill.info.width) / 2), top: Math.floor((Hd - fill.info.height) / 2) },
    ]).png().toBuffer({ resolveWithObject: true });
}

(async () => {
  const logoBuf = await sharp(LOGO).resize({ width: 220 }).png().toBuffer();

  // Headline (the secret)
  const h1 = await withStroke('السر اللي يخليك تشري من', { size: 58, color: '#FFFFFF', weight: '900', width: W - 200, align: 'center' });
  const h2 = await withStroke('AliExpress بنصف السعر', { size: 78, color: '#FFC424', weight: '900', width: W - 200, align: 'center' });

  // Middle benefit lines
  const m1 = await withStroke('كوبونات حصرية + تخفيضات توصل لـ', { size: 44, color: '#FFFFFF', weight: '700', width: W - 400, align: 'center' });
  const big70 = await withStroke('70%', { size: 150, color: '#FFC424', weight: '900', width: 400, align: 'center' });
  const m2 = await withStroke('كل يوم!', { size: 44, color: '#FFFFFF', weight: '700', width: 400, align: 'center' });

  // CTA
  const ctaW = 950, ctaH = 150;
  const ctaBg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ctaW}" height="${ctaH}">
      <defs><filter id="s" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-opacity="0.45"/></filter></defs>
      <rect rx="75" ry="75" width="${ctaW}" height="${ctaH}" fill="#FFC424" stroke="#1a1a2e" stroke-width="4" filter="url(#s)"/>
    </svg>`)).png().toBuffer();
  const ctaTxt = await pangoText('استفد من العروض الآن', { size: 56, color: '#1a1a2e', weight: '900', width: ctaW - 60, align: 'center' });

  // Top-right "secret" chip
  const chipW = 360, chipH = 72;
  const chipBg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${chipW}" height="${chipH}">
      <rect rx="36" ry="36" width="${chipW}" height="${chipH}" fill="#1a1a2e" stroke="#FFC424" stroke-width="3"/>
    </svg>`)).png().toBuffer();
  const chipTxt = await pangoText('سر مكشوف', { size: 36, color: '#FFC424', weight: '900', width: chipW - 40, align: 'center' });

  // Algeria flag chip
  const flagW = 100, flagH = 72;
  const flagBg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${flagW}" height="${flagH}">
      <rect width="${flagW/2}" height="${flagH}" fill="#006233"/>
      <rect x="${flagW/2}" width="${flagW/2}" height="${flagH}" fill="#FFFFFF"/>
      <circle cx="${flagW/2}" cy="${flagH/2}" r="18" fill="#D21034"/>
      <circle cx="${flagW/2 + 6}" cy="${flagH/2}" r="15" fill="#FFFFFF"/>
      <polygon points="${flagW/2 + 12},${flagH/2} ${flagW/2 + 26},${flagH/2 - 5} ${flagW/2 + 18},${flagH/2 + 4} ${flagW/2 + 26},${flagH/2 + 5} ${flagW/2 + 12},${flagH/2}" fill="#D21034"/>
    </svg>`)).png().toBuffer();

  const footer = await withStroke('@AliOffersDz', { size: 38, color: '#FFFFFF', weight: '700', width: 600, align: 'center' });

  // Dark overlay for readability
  const overlay = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs><linearGradient id="g" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="rgba(0,0,0,0.95)"/>
        <stop offset="55%" stop-color="rgba(0,0,0,0.65)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0.3)"/>
      </linearGradient></defs>
      <rect x="0" y="0" width="${W}" height="${H}" fill="url(#g)"/>
    </svg>`)).png().toBuffer();

  const ctaX = Math.floor((W - ctaW) / 2);
  const ctaY = H - 240;

  // Middle row positioning
  const midRowY = 580;
  const midGap = 30;
  const midTotalW = m1.info.width + midGap + big70.info.width + midGap + m2.info.width;
  const midStartX = Math.floor((W - midTotalW) / 2);

  await sharp(BG)
    .resize(W, H, { fit: 'cover', position: 'center' })
    .composite([
      { input: overlay, left: 0, top: 0 },
      // Logo top-left
      { input: logoBuf, top: 50, left: 60 },
      // Top-right chips
      { input: chipBg, top: 70, left: W - chipW - flagW - 80 },
      { input: chipTxt.data, top: 70 + Math.floor((chipH - chipTxt.info.height) / 2), left: W - chipW - flagW - 80 + Math.floor((chipW - chipTxt.info.width) / 2) },
      { input: flagBg, top: 70, left: W - flagW - 60 },
      // Headlines
      { input: h1.data, top: 230, left: Math.floor((W - h1.info.width) / 2) },
      { input: h2.data, top: 230 + h1.info.height + 20, left: Math.floor((W - h2.info.width) / 2) },
      // Middle row RTL: m1 (right) → 70% (center) → m2 (left)
      { input: m1.data, top: midRowY + 50, left: midStartX + m2.info.width + midGap + big70.info.width + midGap },
      { input: big70.data, top: midRowY - 20, left: midStartX + m2.info.width + midGap },
      { input: m2.data, top: midRowY + 50, left: midStartX },
      // CTA
      { input: ctaBg, top: ctaY, left: ctaX },
      { input: ctaTxt.data, top: ctaY + Math.floor((ctaH - ctaTxt.info.height) / 2), left: ctaX + Math.floor((ctaW - ctaTxt.info.width) / 2) },
      // Footer
      { input: footer.data, top: H - 70, left: Math.floor((W - footer.info.width) / 2) },
    ])
    .png()
    .toFile(OUT);
  console.log('✅', OUT);
})().catch(e => { console.error(e); process.exit(1); });
