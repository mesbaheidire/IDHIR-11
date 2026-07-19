const got = require("got");
const { URL } = require("url");
const { getProductDetails } = require('./aliexpress-api');


function isValidAffUrl(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    if (!/^https?:\/\//i.test(v)) return false;
    try {
        const u = new URL(v);
        if (!u.hostname || !u.hostname.includes('.')) return false;
        return true;
    } catch {
        return false;
    }
}

async function getFinalRedirect(url, maxRedirects = 10) {
    let currentUrl = url;
    let bestUrl = url;
    
    for (let i = 0; i < maxRedirects; i++) {
        try {
            const response = await got(currentUrl, {
                followRedirect: false,
                https: { rejectUnauthorized: false },
                timeout: { request: 10000 },
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                }
            });

            if (response.headers.location) {
                let nextUrl = response.headers.location;
                if (nextUrl.startsWith('/')) {
                    const urlObj = new URL(currentUrl);
                    nextUrl = `${urlObj.protocol}//${urlObj.host}${nextUrl}`;
                }
                
                if (nextUrl.includes('productIds=') || nextUrl.includes('/item/')) {
                    bestUrl = nextUrl;
                }
                
                if (nextUrl.includes('/error/') || nextUrl.includes('404')) {
                    console.log("Stopping at 404, using best URL:", bestUrl);
                    return bestUrl;
                }
                
                currentUrl = nextUrl;
            } else {
                const body = response.body || '';
                const metaRefresh = body.match(/content=["'][^"']*url=([^"'\s>]+)/i);
                if (metaRefresh) {
                    currentUrl = metaRefresh[1];
                    if (currentUrl.includes('/item/') || currentUrl.includes('productIds=')) bestUrl = currentUrl;
                    continue;
                }
                const jsRedirect = body.match(/(?:window\.location|location\.href)\s*=\s*["']([^"']+)/i);
                if (jsRedirect) {
                    currentUrl = jsRedirect[1];
                    if (currentUrl.includes('/item/') || currentUrl.includes('productIds=')) bestUrl = currentUrl;
                    continue;
                }
                const bodyLink = body.match(/https?:\/\/[^\s"'<>]*aliexpress\.com\/item\/(\d+)\.html[^\s"'<>]*/i);
                if (bodyLink) {
                    bestUrl = bodyLink[0];
                    return bestUrl;
                }
                return currentUrl;
            }
        } catch (err) {
            if (err.response && err.response.headers && err.response.headers.location) {
                let nextUrl = err.response.headers.location;
                if (nextUrl.startsWith('/')) {
                    const urlObj = new URL(currentUrl);
                    nextUrl = `${urlObj.protocol}//${urlObj.host}${nextUrl}`;
                }
                
                if (nextUrl.includes('productIds=') || nextUrl.includes('/item/')) {
                    bestUrl = nextUrl;
                }
                
                if (nextUrl.includes('/error/') || nextUrl.includes('404')) {
                    console.log("Stopping at 404, using best URL:", bestUrl);
                    return bestUrl;
                }
                
                currentUrl = nextUrl;
            } else {
                const errBody = err.response?.body || '';
                if (typeof errBody === 'string') {
                    const bodyLink = errBody.match(/https?:\/\/[^\s"'<>]*aliexpress\.com\/item\/(\d+)\.html[^\s"'<>]*/i);
                    if (bodyLink) {
                        console.log("📎 رابط منتج مستخرج من صفحة الخطأ:", bodyLink[0].substring(0, 80));
                        return bodyLink[0];
                    }
                }
                console.error("❌ Redirect error:", err.message);
                return bestUrl !== url ? bestUrl : currentUrl;
            }
        }
    }
    
    return currentUrl;
}


function extractProductId(url) {
    try {
        const u = new URL(url);

        // 1) productIds في query
        if (u.searchParams.has("productIds")) {
            const pIds = u.searchParams.get("productIds");
            if (pIds && pIds.includes(',')) return pIds.split(',')[0];
            return pIds;
        }
        
        // 1.1) itemId في query
        if (u.searchParams.has("itemId")) {
            return u.searchParams.get("itemId");
        }

        // 2) redirectUrl
        if (u.searchParams.has("redirectUrl")) {
            const decoded = decodeURIComponent(u.searchParams.get("redirectUrl"));
            const m = decoded.match(/item\/(\d+)\.html/);
            if (m) return m[1];
            
            // البحث عن productIds داخل redirectUrl المشفر
            const m2 = decoded.match(/productIds=(\d+)/);
            if (m2) return m2[1];
        }
        
        // 2.1) xman_goto
        if (u.searchParams.has("xman_goto")) {
            const decoded = decodeURIComponent(u.searchParams.get("xman_goto"));
            const m = decoded.match(/item\/(\d+)\.html/);
            if (m) return m[1];
            
            const m2 = decoded.match(/productIds=(\d+)/);
            if (m2) return m2[1];
        }

        // 3) الرابط العادي /item/xxxx.html
        const m = u.pathname.match(/item\/(\d+)\.html/);
        if (m) return m[1];

        return null;
    } catch {
        return null;
    }
}


async function idCatcher(input) {
    if (!input || typeof input !== "string") return null;

    if (/^\d+$/.test(input)) {
        return { id: input };
    }

    if (!input.startsWith("http")) {
        input = "https://" + input;
    }

    let finalUrl = await getFinalRedirect(input);
    
    console.log("Final URL after redirects:", finalUrl);

    const id = extractProductId(finalUrl);
    
    console.log("Extracted Product ID:", id);

    return { id, finalUrl };
}


async function fetchLinkPreview(productId) {
    // دالة مساعدة للحصول على صورة من Simple Preview (linkpreview.xyz + vi.aliexpress.com)
    async function trySimplePreview() {
        try {
            const spRes = await got("https://linkpreview.xyz/api/get-meta-tags", {
                searchParams: { url: `https://vi.aliexpress.com/item/${productId}.html` },
                responseType: "json",
                timeout: { request: 12000 }
            });
            const spImage = spRes.body?.image || null;
            let spTitle = spRes.body?.title || '';
            spTitle = spTitle.replace(/ - AliExpress.*$/i, '').replace(/\s*-\s*AliExpress\s*\d*$/i, '').trim();
            return spImage ? { image: spImage, title: spTitle } : null;
        } catch (e) {
            console.log("⚠️ Simple Preview failed:", e.message);
            return null;
        }
    }

    // ⭐ 0) Simple Preview أولاً (نفس ترتيب صفحة التجسس — الأكثر موثوقية للصورة)
    const spEarly = await trySimplePreview();
    if (spEarly?.image) {
        console.log("✅ Simple Preview حصل على الصورة — جلب بيانات API للسعر");
    }

    // 1) AliExpress API (للحصول على السعر/المتجر/التقييم)
    try {
        const apiResult = await getProductDetails(productId);
        if (apiResult && apiResult.title) {
            // الأولوية للصورة: Simple Preview > AliExpress API
            const finalImage = spEarly?.image || apiResult.image_url || null;
            console.log("✅ Product fetched via AliExpress API - Title:", apiResult.title.substring(0, 50) + "...");
            return {
                method: spEarly?.image ? "Simple Preview + API" : "AliExpress API",
                title: apiResult.title,
                image_url: finalImage,
                price: apiResult.sale_price || apiResult.price || "غير متوفر",
                original_price: apiResult.original_price,
                discount: apiResult.discount,
                currency: apiResult.currency,
                shop_name: apiResult.shop_name,
                rating: apiResult.rating,
                orders: apiResult.orders
            };
        }
    } catch (apiErr) {
        console.log("AliExpress API fetch failed:", apiErr.message);
    }

    // إن فشل API لكن Simple Preview نجح: نُرجع الصورة + العنوان فقط
    if (spEarly?.image) {
        console.log("✅ Simple Preview standalone (API فشل):", spEarly.image.substring(0, 60));
        return {
            method: "Simple Preview",
            title: spEarly.title || `منتج AliExpress #${productId}`,
            image_url: spEarly.image,
            price: "راجع الرابط"
        };
    }

    // 2) Microlink.io API (احتياط خارجي)
    try {
        console.log("Trying microlink.io API...");
        const apiRes = await got('https://api.microlink.io', {
            searchParams: {
                url: `https://m.aliexpress.com/item/${productId}.html`
            },
            responseType: 'json',
            timeout: { request: 15000 }
        });
        
        const data = apiRes.body;
        if (data.status === 'success' && data.data) {
            let title = data.data.title || '';
            const imageUrl = data.data.image?.url || null;
            
            title = title.replace(/ - AliExpress.*$/i, '').replace(/\s*-\s*AliExpress\s*\d*$/i, '').trim();
            
            const isValidTitle = title && 
                title.length > 10 && 
                !title.includes('AliExpress') && 
                !title.includes('Smarter Shopping') &&
                !title.match(/^\d+\.html$/);
            
            if (isValidTitle) {
                console.log("✅ Product fetched via microlink.io - Title:", title.substring(0, 50) + "...");
                return {
                    method: "Microlink API",
                    title: title,
                    image_url: imageUrl,
                    price: "راجع الرابط"
                };
            }
        }
    } catch (apiErr) {
        console.log("microlink.io API failed:", apiErr.message);
    }

    // 3) Web Scraping - try multiple URL formats
    const urlsToTry = [
        `https://www.aliexpress.com/item/${productId}.html`,
        `https://www.aliexpress.us/item/${productId}.html`,
        `https://ar.aliexpress.com/item/${productId}.html`,
        `https://www.aliexpress.com/item/info/${productId}.html`
    ];
    
    for (const productUrl of urlsToTry) {
        try {
            const res = await got(productUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                timeout: { request: 20000 },
                followRedirect: true,
                retry: { limit: 2 }
            });

            const html = res.body;
            
            if (html.includes('error/404') || html.includes('Page Not Found') || html.includes('id="error-notice"')) {
                continue;
            }
            
            let title = '';
            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (titleMatch) {
                title = titleMatch[1].replace(/ - AliExpress.*$/i, '').replace(/\|.*$/i, '').replace('AliExpress', '').trim();
            }

            const jsonPatterns = [
                /window\.runParams\s*=\s*(\{.+?\});/s,
                /_expDataLayer\.push\((\{.+?\})\);/s,
                /data:\s*(\{.+?\}),\s*serverTime/s,
                /window\.detailData\s*=\s*(\{.+?\});/s,
                /window\.__INITIAL_STATE__\s*=\s*(\{.+?\});/s
            ];

            for (const pattern of jsonPatterns) {
                const match = html.match(pattern);
                if (match) {
                    try {
                        let jsonStr = match[1];
                        if (jsonStr.lastIndexOf('}') !== jsonStr.length - 1) {
                            jsonStr = jsonStr.substring(0, jsonStr.lastIndexOf('}') + 1);
                        }
                        const jsonData = JSON.parse(jsonStr);
                        
                        const itemDetail = jsonData.productInfoComponent || 
                                         jsonData.data?.productInfoComponent ||
                                         jsonData.item ||
                                         jsonData.product ||
                                         (jsonData.widgets && jsonData.widgets.find(w => w.name === 'product-info'));

                        if (itemDetail) {
                            return {
                                method: "Web Scraping (JSON)",
                                title: itemDetail.subject || itemDetail.title || title,
                                image_url: (function pickImg() {
                                    const isVid = (u) => typeof u === 'string' && (/\.(mp4|webm|mov|avi|m3u8|ts|flv|mkv)(\?|$|#)/i.test(u) || /cloud\.video\.taobao\.com|video\.aliexpress|play\.aliexpress|videoid=|playerType=|movie\.aliexpress/i.test(u));
                                    const candidates = [itemDetail.mainImage, itemDetail.image, ...(Array.isArray(itemDetail.images) ? itemDetail.images : [])].filter(Boolean);
                                    return candidates.find(u => !isVid(u)) || null;
                                })(),
                                price: itemDetail.price || (itemDetail.priceList && itemDetail.priceList[0]?.amount?.value) || "راجع الرابط"
                            };
                        }
                    } catch (e) {}
                }
            }

            const metaTitle = html.match(/<meta property="og:title" content="([^"]+)"/i);
            const metaImage = html.match(/<meta property="og:image" content="([^"]+)"/i);
            
            if (metaTitle && metaTitle[1]) {
                title = metaTitle[1].replace(/ - AliExpress.*$/i, '').trim();
            }

            if (title && title.length > 5 && !title.includes('AliExpress')) {
                console.log("Preview fetched via scraping - Title:", title.substring(0, 50));
                return {
                    method: "Web Scraping (Meta Tags)",
                    title: title,
                    image_url: (metaImage ? metaImage[1] : null),
                    price: "راجع الرابط"
                };
            }
        } catch (err) {
            console.log("Scraping attempt failed for", productUrl, "-", err.message);
        }
    }

    // 4) LinkPreview.xyz API
    try {
        console.log("Trying LinkPreview.xyz API...");
        const res = await got("https://linkpreview.xyz/api/get-meta-tags", {
            searchParams: {
                url: `https://vi.aliexpress.com/item/${productId}.html`
            },
            responseType: "json",
            timeout: { request: 15000 }
        });

        if (res.body && (res.body.title || res.body.image)) {
            console.log("✅ Product fetched via LinkPreview.xyz - Title:", (res.body.title || "").substring(0, 50) + "...");
            return {
                method: "LinkPreview.xyz",
                title: res.body.title || `منتج AliExpress #${productId}`,
                image_url: res.body.image || null,
                price: "راجع الرابط"
            };
        }
    } catch (err) {
        console.log("LinkPreview.xyz API failed:", err.message);
    }
    
    // 5) Mobile page fallback
    try {
        console.log("Trying direct mobile page for image...");
        const mobileRes = await got(`https://m.aliexpress.com/item/${productId}.html`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html',
                'Accept-Language': 'en'
            },
            timeout: { request: 12000 },
            followRedirect: true
        });
        const mHtml = mobileRes.body;
        const ogImg = mHtml.match(/<meta property="og:image" content="([^"]+)"/i);
        const ogTitle = mHtml.match(/<meta property="og:title" content="([^"]+)"/i);
        const titleTag = mHtml.match(/<title>([^<]+)<\/title>/i);
        const imgUrl = ogImg ? ogImg[1] : null;
        let mTitle = ogTitle ? ogTitle[1] : (titleTag ? titleTag[1] : '');
        mTitle = mTitle.replace(/ - AliExpress.*$/i, '').replace(/\|.*$/i, '').trim();
        if (imgUrl || (mTitle && mTitle.length > 5)) {
            console.log("✅ Product fetched via mobile page - Image:", imgUrl ? 'yes' : 'no');
            return {
                method: "Mobile Page",
                title: mTitle || `منتج AliExpress #${productId}`,
                image_url: imgUrl,
                price: "راجع الرابط"
            };
        }
    } catch (mErr) {
        console.log("Mobile page fetch failed:", mErr.message);
    }

    console.log("All methods failed, using fallback");
    return {
        method: "Fallback (Default)",
        title: `منتج AliExpress #${productId}`,
        image_url: null,
        price: "راجع الرابط"
    };
}


async function portaffFunction(cookie, ids) {

    const idObj = await idCatcher(ids);
    const productId = idObj?.id;

    if (!productId) throw new Error("❌ لم يتم استخراج Product ID.");

    let cookieStr = prepareCookie(cookie);
    
    const sourceTypes = {
        "555": "coin",
        "620": "point",
        "562": "super",
        "570": "limit",
        "561": "ther3"
    };

    let result = { aff: {}, previews: {} };
    let promoRequests = [];

    for (const type in sourceTypes) {
        const name = sourceTypes[type];

        const targetUrl = type === "561"
            ? `https://www.aliexpress.com/ssr/300000512/BundleDeals2?disableNav=YES&pha_manifest=ssr&_immersiveMode=true&productIds=${productId}&aff_fcid=`
            : type === "555"
                ? `https://m.aliexpress.com/p/coin-index/index.html?_immersiveMode=true&from=syicon&productIds=${productId}&aff_fcid=`
                : `https://star.aliexpress.com/share/share.htm?redirectUrl=https%3A%2F%2Fvi.aliexpress.com%2Fitem%2F${productId}.html%3FsourceType%3D${type === "620" ? '620%26channel%3Dcoin' : type}`;

        promoRequests.push(
            got("https://portals.aliexpress.com/tools/linkGenerate/generatePromotionLink.htm", {
                searchParams: {
                    trackId: process.env.ALIEXPRESS_TRACK_ID || "default",
                    targetUrl
                },
                headers: {
                    cookie: cookieStr
                }
            })
                .then(r => {
                    const raw = r.body;
                    if (typeof raw === 'string' && (raw.includes('<!DOCTYPE') || raw.includes('login.html') || raw.includes('<html'))) {
                        console.log(`⚠️ الكوكي منتهي — رد تسجيل دخول من AliExpress (${name})`);
                        return { type: name, data: null, cookieExpired: true };
                    }
                    try {
                        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                        return { type: name, data: parsed.data };
                    } catch {
                        return { type: name, data: null };
                    }
                })
                .catch(() => ({ type: name, data: null }))
        );
    }

    const promoResults = await Promise.all(promoRequests);

    const cookieExpired = promoResults.some(pr => pr.cookieExpired);
    if (cookieExpired) {
        console.log('🔴 الكوكي منتهي الصلاحية — جدّد الكوكي من إعدادات التطبيق');
    }

    for (const pr of promoResults) {
        let candidate = null;
        if (pr.data && typeof pr.data === 'object') {
            candidate = pr.data.promotionUrl || pr.data.couponUrl || pr.data.url || null;
        } else if (typeof pr.data === 'string') {
            candidate = pr.data;
        }
        result.aff[pr.type] = isValidAffUrl(candidate) ? candidate : null;
    }

    try {
        result.previews = await fetchLinkPreview(productId);
    } catch (previewErr) {
        console.log(`⚠️ فشل جلب معاينة المنتج: ${previewErr.message} — متابعة بدون صورة`);
        result.previews = {
            method: "Fallback (Preview Error)",
            title: `منتج AliExpress #${productId}`,
            image_url: null,
            price: "راجع الرابط"
        };
    }
    if (!result.previews) {
        result.previews = {
            method: "Fallback (No Preview)",
            title: `منتج AliExpress #${productId}`,
            image_url: null,
            price: "راجع الرابط"
        };
    }
    if (!result.previews.title) {
        result.previews.title = `منتج AliExpress #${productId}`;
    }
    result.productId = productId;

    return result;
}

function prepareCookie(cookie) {
    let cookieStr = String(cookie || '').trim();
    if (!cookieStr) return '';

    // إذا كان كوكي كامل (يحتوي على ; وعدة أسماء) — مرّره كما هو
    if (cookieStr.includes(';') && cookieStr.includes('=')) {
        // تأكد من وجود xman_t — إن لم يكن، فالكوكي ليس صالحاً للأفلييت
        if (!/xman_t=/.test(cookieStr)) {
            console.log('⚠️ الكوكي لا يحتوي على xman_t — قد لا يعمل');
        }
        return cookieStr;
    }

    // إذا كان فقط القيمة الخام (بدون اسم) — لفّها بـ xman_t
    if (cookieStr.includes('xman_t=')) {
        return cookieStr.endsWith(';') ? cookieStr : cookieStr + ';';
    }
    return `xman_t=${cookieStr};`;
}

async function directAffLink(cookie, originalUrl) {
    let cookieStr = prepareCookie(cookie);

    const response = await got("https://portals.aliexpress.com/tools/linkGenerate/generatePromotionLink.htm", {
        searchParams: {
            trackId: process.env.ALIEXPRESS_TRACK_ID || "default",
            targetUrl: originalUrl
        },
        headers: {
            cookie: cookieStr
        }
    });

    const rawBody = response.body;
    if (typeof rawBody === 'string' && (rawBody.includes('<!DOCTYPE') || rawBody.includes('login.html') || rawBody.includes('<html'))) {
        throw new Error('⚠️ الكوكي منتهي الصلاحية — AliExpress يطلب تسجيل الدخول. جدّد الكوكي من إعدادات التطبيق.');
    }

    let parsed;
    try {
        parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch (e) {
        throw new Error('⚠️ رد غير متوقع من AliExpress — تحقق من صلاحية الكوكي');
    }

    const data = parsed.data;
    let affLink = null;
    if (data && typeof data === 'object') {
        affLink = data.promotionUrl || data.couponUrl || data.url || null;
    } else if (typeof data === 'string') {
        affLink = data;
    }

    if (!isValidAffUrl(affLink)) {
        console.log(`⚠️ رد غير صالح من AliExpress (ليس رابطاً): ${String(affLink).substring(0, 80)}`);
        throw new Error('فشل تحويل الرابط — رد غير صالح من AliExpress (تحقق من الكوكي)');
    }

    const idObj = await idCatcher(originalUrl);
    const productId = idObj?.id;
    let previews = {};
    if (productId) {
        previews = await fetchLinkPreview(productId);
    }

    return { affLink, previews, productId };
}

exports.portaffFunction = portaffFunction;
exports.directAffLink = directAffLink;
exports.fetchLinkPreview = fetchLinkPreview;
exports.idCatcher = idCatcher;
