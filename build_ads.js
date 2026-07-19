const sharp = require('sharp');

const W = 1920;
const H = 1080;
const LOGO = 'public/ads/logo.png';

async function renderText(text, { fontSize, color = '#FFFFFF', weight = 'bold', width = W - 200, align = 'center' }) {
  const pangoMarkup = `<span foreground="${color}" font_family="Cairo" font_weight="${weight}" size="${fontSize * 1024}">${text}</span>`;
  return sharp({
    text: {
      text: pangoMarkup,
      font: 'Cairo',
      width,
      dpi: 72,
      rgba: true,
      align,
    }
  }).png().toBuffer({ resolveWithObject: true });
}

async function renderTextWithStroke(text, opts) {
  const stroke = await renderText(text, { ...opts, color: opts.strokeColor || '#000000' });
  const fill = await renderText(text, opts);
  const strokeBlurred = await sharp(stroke.data).blur(2).toBuffer({ resolveWithObject: true });
  const Wd = Math.max(strokeBlurred.info.width, fill.info.width);
  const Hd = Math.max(strokeBlurred.info.height, fill.info.height);
  const out = await sharp({ create: { width: Wd, height: Hd, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: strokeBlurred.data, left: 0, top: 0 },
      { input: strokeBlurred.data, left: 0, top: 0 },
      { input: strokeBlurred.data, left: 0, top: 0 },
      { input: fill.data, left: Math.floor((Wd - fill.info.width) / 2), top: Math.floor((Hd - fill.info.height) / 2) },
    ])
    .png()
    .toBuffer({ resolveWithObject: true });
  return out;
}

async function buildAd({ bg, top, mid, cta, footer, out }) {
  const logoBuf = await sharp(LOGO).resize({ width: 240 }).png().toBuffer();

  const topImg = await renderTextWithStroke(top, { fontSize: 56, color: '#FFFFFF', weight: '900', width: W - 380, align: 'right' });
  const midImg = await renderTextWithStroke(mid, { fontSize: 110, color: '#FFC424', weight: '900', width: W - 200, align: 'center' });
  const ctaTextImg = await renderText(cta, { fontSize: 56, color: '#1a1a2e', weight: '900', width: 700, align: 'center' });
  const footerImg = await renderTextWithStroke(footer, { fontSize: 42, color: '#FFFFFF', weight: '700', width: 600, align: 'center' });

  const ctaBgWidth = 800;
  const ctaBgHeight = 140;
  const ctaBg = await sharp({
    create: { width: ctaBgWidth, height: ctaBgHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ctaBgWidth}" height="${ctaBgHeight}"><rect x="0" y="0" rx="70" ry="70" width="${ctaBgWidth}" height="${ctaBgHeight}" fill="#FFC424"/></svg>`)
    }])
    .png()
    .toBuffer();

  const gradient = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <defs><linearGradient id="g" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="rgba(0,0,0,0.92)"/>
          <stop offset="55%" stop-color="rgba(0,0,0,0.55)"/>
          <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
        </linearGradient></defs>
        <rect x="0" y="${H - 600}" width="${W}" height="600" fill="url(#g)"/>
        <rect x="0" y="0" width="${W}" height="200" fill="rgba(0,0,0,0.55)"/>
      </svg>`)
    }])
    .png()
    .toBuffer();

  const ctaX = Math.floor((W - ctaBgWidth) / 2);
  const ctaY = H - 250;

  await sharp(bg)
    .resize(W, H, { fit: 'cover', position: 'center' })
    .composite([
      { input: gradient, left: 0, top: 0 },
      { input: logoBuf, top: 50, left: 60 },
      { input: topImg.data, top: 80, left: W - topImg.info.width - 80 },
      { input: midImg.data, top: Math.floor(H / 2) - Math.floor(midImg.info.height / 2) + 30, left: Math.floor((W - midImg.info.width) / 2) },
      { input: ctaBg, top: ctaY, left: ctaX },
      { input: ctaTextImg.data, top: ctaY + Math.floor((ctaBgHeight - ctaTextImg.info.height) / 2), left: ctaX + Math.floor((ctaBgWidth - ctaTextImg.info.width) / 2) },
      { input: footerImg.data, top: H - 80, left: Math.floor((W - footerImg.info.width) / 2) },
    ])
    .png()
    .toFile(out);
  console.log('✅', out);
}

(async () => {
  await buildAd({
    bg: 'public/ads/bg1_deals.png',
    top: 'تخفيضات يومية من علي إكسبريس',
    mid: 'وفّر حتى ٪70',
    cta: 'اشترك الآن في القناة',
    footer: '@AliOffersDz',
    out: 'public/ads/ad1_deals_16x9.png'
  });
  await buildAd({
    bg: 'public/ads/bg2_lifestyle.png',
    top: 'انضم لآلاف المتسوقين الأذكياء',
    mid: 'أفضل العروض كل يوم',
    cta: 'اضغط للانضمام مجاناً',
    footer: '@AliOffersDz',
    out: 'public/ads/ad2_lifestyle_16x9.png'
  });
  await buildAd({
    bg: 'public/ads/bg3_explosion.png',
    top: 'لا تفوّت أي عرض',
    mid: 'كوبونات حصرية يومياً',
    cta: 'انضم إلى القناة',
    footer: '@AliOffersDz',
    out: 'public/ads/ad3_explosion_16x9.png'
  });
})().catch(e => { console.error(e); process.exit(1); });
