const sharp = require('sharp');

const W = 1920, H = 1080;
const LOGO = 'public/ads/logo.png';
const BG = 'public/ads/bg1b_deals.png';
const OUT = 'public/ads/ad5_persuasive_16x9.png';

async function pangoText(text, { size, color = '#FFFFFF', weight = '900', width = W - 200, align = 'center', strikethrough = false }) {
  const strike = strikethrough ? ' strikethrough="true" strikethrough_color="#FF3B30"' : '';
  const markup = `<span foreground="${color}" font_family="Cairo" font_weight="${weight}" size="${size * 1024}"${strike}>${text}</span>`;
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

  // Headline (top, white with stroke)
  const headline = await withStroke('لا تشتري من AliExpress', { size: 60, color: '#FFFFFF', weight: '900', width: W - 400, align: 'right' });
  const headline2 = await withStroke('قبل ما تشوف هذا!', { size: 60, color: '#FFC424', weight: '900', width: W - 400, align: 'right' });

  // Price comparison (center)
  const oldPrice = await pangoText('5000 دج', { size: 80, color: '#FF3B30', weight: '700', width: 500, align: 'center', strikethrough: true });
  const arrow = await pangoText('→', { size: 90, color: '#FFFFFF', weight: '900', width: 120, align: 'center' });
  const newPriceBig = await withStroke('1500 دج', { size: 130, color: '#FFC424', weight: '900', width: 700, align: 'center' });

  // Discount badge (red circle "-70%")
  const badgeSize = 280;
  const badgeBg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${badgeSize}" height="${badgeSize}">
      <defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-opacity="0.5"/></filter></defs>
      <circle cx="${badgeSize/2}" cy="${badgeSize/2}" r="${badgeSize/2 - 10}" fill="#E53935" stroke="#FFFFFF" stroke-width="6" filter="url(#s)" transform="rotate(-12 ${badgeSize/2} ${badgeSize/2})"/>
    </svg>`)).png().toBuffer();
  const badgePct = await pangoText('-70%', { size: 78, color: '#FFFFFF', weight: '900', width: badgeSize - 40, align: 'center' });
  const badgeLbl = await pangoText('خصم', { size: 32, color: '#FFFFFF', weight: '700', width: badgeSize - 40, align: 'center' });

  // Social proof line
  const social = await withStroke('+10,000 جزائري يوفّرون يومياً', { size: 38, color: '#FFFFFF', weight: '700', width: W - 400, align: 'center' });

  // CTA button
  const ctaW = 900, ctaH = 150;
  const ctaBg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ctaW}" height="${ctaH}">
      <defs><filter id="s2" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-opacity="0.45"/></filter></defs>
      <rect rx="75" ry="75" width="${ctaW}" height="${ctaH}" fill="#FFC424" stroke="#1a1a2e" stroke-width="4" filter="url(#s2)"/>
    </svg>`)).png().toBuffer();
  const ctaTxt = await pangoText('اشترك مجاناً واحصل على الكوبون', { size: 50, color: '#1a1a2e', weight: '900', width: ctaW - 60, align: 'center' });

  // Urgency chip (top corner)
  const urgencyW = 520, urgencyH = 72;
  const urgencyBg = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${urgencyW}" height="${urgencyH}">
      <rect rx="36" ry="36" width="${urgencyW}" height="${urgencyH}" fill="#E53935"/>
    </svg>`)).png().toBuffer();
  const urgencyTxt = await pangoText('عرض اليوم فقط', { size: 36, color: '#FFFFFF', weight: '900', width: urgencyW - 40, align: 'center' });

  const footer = await withStroke('@AliOffersDz', { size: 38, color: '#FFFFFF', weight: '700', width: 600, align: 'center' });

  // Dark overlay for readability
  const overlay = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs><linearGradient id="g" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="rgba(0,0,0,0.95)"/>
        <stop offset="60%" stop-color="rgba(0,0,0,0.55)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
      </linearGradient></defs>
      <rect x="0" y="${H - 700}" width="${W}" height="700" fill="url(#g)"/>
      <rect x="0" y="0" width="${W}" height="220" fill="rgba(0,0,0,0.65)"/>
    </svg>`)).png().toBuffer();

  // Layout positions
  const ctaX = Math.floor((W - ctaW) / 2);
  const ctaY = H - 240;

  // Price row positioning (centered group)
  const oldPW = oldPrice.info.width, arrW = arrow.info.width, newPW = newPriceBig.info.width;
  const gap = 40;
  const totalPriceW = oldPW + gap + arrW + gap + newPW;
  const priceY = 460;
  const priceStartX = Math.floor((W - totalPriceW) / 2);

  await sharp(BG)
    .resize(W, H, { fit: 'cover', position: 'center' })
    .composite([
      { input: overlay, left: 0, top: 0 },
      // Logo top-left
      { input: logoBuf, top: 50, left: 60 },
      // Urgency chip top-right
      { input: urgencyBg, top: 70, left: W - urgencyW - 60 },
      { input: urgencyTxt.data, top: 70 + Math.floor((urgencyH - urgencyTxt.info.height) / 2), left: W - urgencyW - 60 + Math.floor((urgencyW - urgencyTxt.info.width) / 2) },
      // Headlines (right-aligned)
      { input: headline.data, top: 170, left: W - headline.info.width - 80 },
      { input: headline2.data, top: 170 + headline.info.height + 10, left: W - headline2.info.width - 80 },
      // Discount badge (left side)
      { input: badgeBg, top: 380, left: 80 },
      { input: badgePct.data, top: 380 + Math.floor(badgeSize / 2) - Math.floor(badgePct.info.height / 2) - 18, left: 80 + Math.floor((badgeSize - badgePct.info.width) / 2) },
      { input: badgeLbl.data, top: 380 + Math.floor(badgeSize / 2) + Math.floor(badgePct.info.height / 2) - 28, left: 80 + Math.floor((badgeSize - badgeLbl.info.width) / 2) },
      // Price comparison
      { input: oldPrice.data, top: priceY + 30, left: priceStartX },
      { input: arrow.data, top: priceY + 25, left: priceStartX + oldPW + gap },
      { input: newPriceBig.data, top: priceY - 20, left: priceStartX + oldPW + gap + arrW + gap },
      // Social proof
      { input: social.data, top: 700, left: Math.floor((W - social.info.width) / 2) },
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
