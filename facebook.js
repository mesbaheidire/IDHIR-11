const https = require('https');
const http = require('http');

const FB_GRAPH_URL = 'graph.facebook.com';
const FB_API_VERSION = 'v19.0';

async function postToFacebookPage(pageAccessToken, pageId, message, imageUrl, link, imageBuffer, imageMime) {
  if (!pageAccessToken || !pageId) {
    throw new Error('Facebook Page Access Token و Page ID مطلوبان');
  }

  if (imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
    return postPhotoBufferToPage(pageAccessToken, pageId, message, imageBuffer, imageMime || 'image/jpeg');
  }
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    return postPhotoToPage(pageAccessToken, pageId, message, imageUrl);
  }
  return postTextToPage(pageAccessToken, pageId, message, link);
}

function postPhotoBufferToPage(token, pageId, message, buffer, mime) {
  return new Promise((resolve, reject) => {
    const boundary = '----FB' + Date.now().toString(16) + Math.random().toString(16).slice(2);
    const ext = (mime || '').includes('png') ? 'png'
              : (mime || '').includes('webp') ? 'webp'
              : (mime || '').includes('gif') ? 'gif'
              : 'jpg';
    const filename = `image.${ext}`;
    const CRLF = '\r\n';
    const partHeader = (name, extra = '') =>
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${extra}${CRLF}`;
    const parts = [];
    parts.push(Buffer.from(partHeader('access_token') + CRLF + token + CRLF, 'utf8'));
    parts.push(Buffer.from(partHeader('message') + CRLF + (message || '') + CRLF, 'utf8'));
    parts.push(Buffer.from(
      partHeader('source', `; filename="${filename}"`) +
      `Content-Type: ${mime || 'image/jpeg'}${CRLF}${CRLF}`,
      'utf8'
    ));
    parts.push(buffer);
    parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'));
    const body = Buffer.concat(parts);

    const options = {
      hostname: FB_GRAPH_URL,
      path: `/${FB_API_VERSION}/${pageId}/photos`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || 'Facebook API error'));
          } else {
            resolve({ success: true, postId: parsed.post_id || parsed.id });
          }
        } catch (e) {
          reject(new Error('Invalid Facebook API response'));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

function postTextToPage(token, pageId, message, link) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      message: message,
      link: link || undefined,
      access_token: token
    });

    const options = {
      hostname: FB_GRAPH_URL,
      path: `/${FB_API_VERSION}/${pageId}/feed`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || 'Facebook API error'));
          } else {
            resolve({ success: true, postId: parsed.id });
          }
        } catch (e) {
          reject(new Error('Invalid Facebook API response'));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

function postPhotoToPage(token, pageId, message, imageUrl) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      message: message,
      url: imageUrl,
      access_token: token
    });

    const options = {
      hostname: FB_GRAPH_URL,
      path: `/${FB_API_VERSION}/${pageId}/photos`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || 'Facebook API error'));
          } else {
            resolve({ success: true, postId: parsed.post_id || parsed.id });
          }
        } catch (e) {
          reject(new Error('Invalid Facebook API response'));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

function fbGet(path) {
  return new Promise((resolve) => {
    const options = { hostname: FB_GRAPH_URL, path: `/${FB_API_VERSION}${path}`, method: 'GET' };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: { message: 'Invalid JSON response from Facebook' } }); }
      });
    });
    req.on('error', (e) => resolve({ error: { message: e.message } }));
    req.end();
  });
}

async function verifyPageToken(pageAccessToken, pageId) {
  // الخطوة 1: اعرف لمن يعود التوكن
  const me = await fbGet(`/me?fields=id,name&access_token=${encodeURIComponent(pageAccessToken)}`);
  if (me.error) {
    return { valid: false, error: `توكن غير صالح: ${me.error.message}` };
  }
  const isUserToken = String(me.id) !== String(pageId);

  // الخطوة 2-أ: إذا توكن User → استخرج قائمة الصفحات + Page Token الصحيح
  if (isUserToken) {
    const accounts = await fbGet(`/me/accounts?fields=id,name,access_token,tasks&access_token=${encodeURIComponent(pageAccessToken)}`);
    if (accounts.error) {
      return {
        valid: false,
        error: `User Token بدون صلاحية pages_show_list: ${accounts.error.message}`,
        hint: 'أضف صلاحية pages_show_list + pages_manage_posts للتطبيق',
        isUserToken: true
      };
    }
    const pages = (accounts.data || []);
    const match = pages.find(p => String(p.id) === String(pageId));
    if (!match) {
      return {
        valid: false,
        error: `الصفحة ${pageId} ليست ضمن صفحاتك. الصفحات المتاحة: ${pages.map(p => p.id + '(' + p.name + ')').join(', ') || 'لا شيء'}`,
        hint: 'تأكد أنك مدير على هذه الصفحة بنفس حساب فيسبوك المستخدم لإنشاء التوكن',
        isUserToken: true,
        availablePages: pages.map(p => ({ id: p.id, name: p.name }))
      };
    }
    const tasks = match.tasks || [];
    const canCreate = tasks.includes('CREATE_CONTENT') || tasks.includes('MANAGE');
    if (!match.access_token) {
      return {
        valid: false,
        pageName: match.name,
        error: 'لم يتمّ إرجاع Page Access Token (ربما تنقص صلاحية pages_show_list)',
        isUserToken: true,
        tasks
      };
    }
    return {
      valid: false, // ما زلنا User Token — يجب الاستبدال
      pageName: match.name,
      error: 'تستخدم User Token. تم العثور على Page Token الصحيح — اضغط الزر للاستبدال.',
      hint: 'سيُستبدل التوكن تلقائياً بـ Page Access Token الذي يستطيع النشر',
      isUserToken: true,
      tasks,
      canCreate,
      suggestedPageToken: match.access_token
    };
  }

  // الخطوة 2-ب: إذا me.id == pageId → هذا Page Access Token. يكفي التحقق من الاسم.
  const pageInfo = await fbGet(`/${pageId}?fields=name,id&access_token=${encodeURIComponent(pageAccessToken)}`);
  if (pageInfo.error) {
    return {
      valid: false,
      error: `الصفحة غير قابلة للوصول: ${pageInfo.error.message}`,
      isUserToken: false
    };
  }
  return {
    valid: true,
    pageName: pageInfo.name,
    pageId: pageInfo.id,
    isUserToken: false,
    tokenType: 'PAGE'
  };
}

function formatFacebookMessage(title, price, affiliateLink, coupon, template) {
  const t = template || {};
  let msg = '';

  if (t.prefix) msg += t.prefix + '\n\n';
  if (title) msg += title + '\n\n';
  if (price) msg += (t.priceLabel || '💰 السعر:') + ' ' + price + '\n\n';
  if (affiliateLink) msg += (t.linkLabel || '🛒 رابط الشراء:') + '\n' + affiliateLink + '\n\n';
  if (coupon) msg += (t.couponLabel || '🎟️ كوبون:') + ' ' + coupon + '\n\n';
  if (t.footer) msg += t.footer + '\n';
  if (t.hashtags) msg += '\n' + t.hashtags;

  return msg.trim();
}

module.exports = {
  postToFacebookPage,
  verifyPageToken,
  formatFacebookMessage
};
