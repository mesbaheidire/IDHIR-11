const crypto = require('crypto');
const got = require('got');

const API_URL = 'https://api-sg.aliexpress.com/sync';

function signRequest(params, appSecret) {
    const sortedParams = Object.keys(params)
        .sort()
        .reduce((acc, key) => {
            acc[key] = params[key];
            return acc;
        }, {});

    const sortedString = Object.keys(sortedParams).reduce((acc, key) => {
        return `${acc}${key}${sortedParams[key]}`;
    }, '');

    const signString = `${appSecret}${sortedString}${appSecret}`;

    return crypto
        .createHash('md5')
        .update(signString, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// قائمة كاملة بكل الحقول المهمة - نطلبها صراحةً من API
const PRODUCT_FIELDS = [
    'product_id','product_title','product_main_image_url','product_small_image_urls',
    'product_detail_url','promotion_link','shop_title','shop_url','shop_id',
    'target_sale_price','target_sale_price_currency','target_original_price','target_original_price_currency',
    'sale_price','original_price','discount','commission_rate','hot_product_commission_rate',
    'evaluate_rate','avg_evaluation_rate','rating_weighted','review_count',
    'lastest_volume','volume','30days_commission','first_level_category_id','first_level_category_name',
    'second_level_category_id','second_level_category_name','original_price_currency','sale_price_currency',
    'product_video_url'
].join(',');

// استخراج الحقول من المنتج بأسماء متعددة محتملة
function normalizeProduct(p) {
    if (!p) return null;
    const rating = p.evaluate_rate || p.avg_evaluation_rate || p.rating_weighted || p.evaluation_rate || null;
    const orders = p.lastest_volume || p.volume || p.sales || p.last_30days_volume || null;
    return {
        id: p.product_id,
        title: p.product_title || '',
        image_url: p.product_main_image_url || p.product_small_image_urls?.string?.[0] || null,
        price: p.target_sale_price || p.sale_price || p.target_original_price || null,
        original_price: p.target_original_price || p.original_price || null,
        sale_price: p.target_sale_price || p.sale_price || null,
        discount: p.discount || null,
        currency: p.target_sale_price_currency || p.sale_price_currency || 'USD',
        product_url: p.product_detail_url || null,
        promotion_link: p.promotion_link || null,
        shop_name: p.shop_title || null,
        shop_id: p.shop_id || null,
        rating: rating ? String(rating).replace('%','') : null,
        orders: orders != null ? Number(orders) : null,
        review_count: p.review_count || null,
        commission_rate: p.commission_rate || p.hot_product_commission_rate || null,
        category_id: p.first_level_category_id || null,
        category_name: p.first_level_category_name || null,
        video_url: p.product_video_url || null
    };
}

async function _callApi(method, extraParams = {}, timeout = 15000) {
    const appKey = process.env.ALIEXPRESS_APP_KEY;
    const appSecret = process.env.ALIEXPRESS_APP_SECRET;
    if (!appKey || !appSecret) throw new Error('Missing AliExpress API credentials');

    const params = {
        method,
        app_key: appKey,
        sign_method: 'md5',
        timestamp: Date.now().toString(),
        format: 'json',
        v: '2.0',
        tracking_id: process.env.ALIEXPRESS_TRACK_ID || 'default',
        ...extraParams
    };
    params.sign = signRequest(params, appSecret);

    const response = await got(API_URL, {
        searchParams: params,
        timeout: { request: timeout },
        responseType: 'json'
    });
    return response.body;
}

// طريقة fallback: نبحث عن المنتج بالـ ID عبر product.query (يُرجع تقييم/طلبات بشكل أفضل)
async function _queryById(productId, options = {}) {
    try {
        const data = await _callApi('aliexpress.affiliate.product.query', {
            target_currency: options.currency || 'USD',
            target_language: options.language || 'EN',
            product_ids: String(productId),
            fields: PRODUCT_FIELDS,
            page_no: '1',
            page_size: '1'
        });
        const r = data.aliexpress_affiliate_product_query_response?.resp_result;
        const list = r?.result?.products?.product;
        if (list) {
            const p = Array.isArray(list) ? list[0] : list;
            return normalizeProduct(p);
        }
    } catch (e) {
        console.log('  ↳ fallback query.product by ID failed:', e.message);
    }
    return null;
}

// طريقة fallback ثانية: نبحث بـ keywords (عنوان المنتج) ثم نطابق المنتج بـ ID
// هذه الطريقة تُرجع التقييم/الطلبات بشكل أكثر موثوقية لأن نتائج البحث تشمل بطاقات منتجات كاملة
async function _queryByKeywords(productId, title, options = {}) {
    if (!title) return null;
    try {
        // نُقصّر العنوان لأول 8 كلمات (AE يقبل بحث محدود)
        const keywords = String(title).split(/\s+/).slice(0, 8).join(' ').slice(0, 100);
        if (!keywords) return null;

        // نجلب صفحتين بحد أقصى للعثور على المنتج بالـ ID المطلوب
        for (let page = 1; page <= 2; page++) {
            const data = await _callApi('aliexpress.affiliate.product.query', {
                target_currency: options.currency || 'USD',
                target_language: options.language || 'EN',
                keywords,
                fields: PRODUCT_FIELDS,
                page_no: String(page),
                page_size: '50',
                sort: 'SALE_PRICE_ASC'
            });
            const r = data.aliexpress_affiliate_product_query_response?.resp_result;
            const list = r?.result?.products?.product;
            if (!list) continue;
            const arr = Array.isArray(list) ? list : [list];
            const match = arr.find(p => String(p.product_id) === String(productId));
            if (match) return normalizeProduct(match);
        }
    } catch (e) {
        console.log('  ↳ fallback query by keywords failed:', e.message);
    }
    return null;
}

async function getProductDetails(productId, options = {}) {
    if (!productId) return null;
    
    const maxRetries = 2;
    let lastError = null;
    let baseInfo = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 1) {
                await new Promise(resolve => setTimeout(resolve, 1100 * (attempt - 1)));
            }

            const data = await _callApi('aliexpress.affiliate.productdetail.get', {
                product_ids: String(productId),
                target_currency: options.currency || 'USD',
                target_language: options.language || 'EN',
                fields: PRODUCT_FIELDS
            });

            if (data.aliexpress_affiliate_productdetail_get_response) {
                const result = data.aliexpress_affiliate_productdetail_get_response.resp_result;
                const products = result?.result?.products?.product;
                if (products) {
                    const product = Array.isArray(products) ? products[0] : products;
                    baseInfo = normalizeProduct(product);
                    break;
                }
            }

            if (data.error_response) {
                lastError = data.error_response.msg || JSON.stringify(data.error_response);
                console.error(`AliExpress productdetail attempt ${attempt}:`, lastError);
            }
        } catch (err) {
            lastError = err.message;
            console.error(`AliExpress productdetail attempt ${attempt} error:`, lastError);
        }
    }

    // إذا حصلنا على البيانات الأساسية لكن ينقصنا تقييم/طلبات → نستدعي product.query للتكميل
    if (baseInfo && (!baseInfo.rating || !baseInfo.orders || !baseInfo.discount)) {
        const enriched = await _queryById(productId, options);
        if (enriched) {
            if (!baseInfo.rating && enriched.rating) baseInfo.rating = enriched.rating;
            if (!baseInfo.orders && enriched.orders) baseInfo.orders = enriched.orders;
            if (!baseInfo.discount && enriched.discount) baseInfo.discount = enriched.discount;
            if (!baseInfo.review_count && enriched.review_count) baseInfo.review_count = enriched.review_count;
        }
    }

    // Fallback ثانٍ: إذا ما زالت ناقصة → ابحث بالعنوان (يُرجع بطاقات أكمل)
    if (baseInfo && baseInfo.title && (!baseInfo.rating || !baseInfo.orders || !baseInfo.discount)) {
        const byKw = await _queryByKeywords(productId, baseInfo.title, options);
        if (byKw) {
            if (!baseInfo.rating && byKw.rating) baseInfo.rating = byKw.rating;
            if (!baseInfo.orders && byKw.orders) baseInfo.orders = byKw.orders;
            if (!baseInfo.discount && byKw.discount) baseInfo.discount = byKw.discount;
            if (!baseInfo.review_count && byKw.review_count) baseInfo.review_count = byKw.review_count;
            console.log(`  ↳ enriched ${productId} via keywords search: rating=${baseInfo.rating} orders=${baseInfo.orders} discount=${baseInfo.discount}`);
        }
    }

    // إذا فشلت productdetail تماماً → نجرب product.query كملاذ أخير
    if (!baseInfo) {
        baseInfo = await _queryById(productId, options);
    }

    return baseInfo;
}

async function searchHotProducts(options = {}) {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 1) {
                await new Promise(resolve => setTimeout(resolve, 1100 * (attempt - 1)));
            }

            const appKey = process.env.ALIEXPRESS_APP_KEY;
            const appSecret = process.env.ALIEXPRESS_APP_SECRET;

            if (!appKey || !appSecret) {
                console.error('Missing AliExpress API credentials');
                return { success: false, error: 'Missing API credentials' };
            }

            const params = {
                method: 'aliexpress.affiliate.hotproduct.query',
                app_key: appKey,
                sign_method: 'md5',
                timestamp: Date.now().toString(),
                format: 'json',
                v: '2.0',
                target_currency: options.currency || 'USD',
                target_language: options.language || 'EN',
                tracking_id: process.env.ALIEXPRESS_TRACK_ID || 'default',
                page_no: options.page || '1',
                page_size: options.limit || '10'
            };

            if (options.category) params.category_ids = options.category;
            if (options.keywords) params.keywords = options.keywords;
            if (options.minPrice) params.min_sale_price = options.minPrice;
            if (options.maxPrice) params.max_sale_price = options.maxPrice;

            params.sign = signRequest(params, appSecret);

            const response = await got(API_URL, {
                searchParams: params,
                timeout: { request: 20000 },
                responseType: 'json'
            });

            const data = response.body;
            
            if (data.aliexpress_affiliate_hotproduct_query_response) {
                const result = data.aliexpress_affiliate_hotproduct_query_response.resp_result;
                if (result && result.result && result.result.products && result.result.products.product) {
                    const products = result.result.products.product;
                    const productList = Array.isArray(products) ? products : [products];
                    
                    return {
                        success: true,
                        total: result.result.total_record_count || productList.length,
                        products: productList.map(p => ({
                            id: p.product_id,
                            title: p.product_title || '',
                            image_url: p.product_main_image_url || null,
                            price: p.target_sale_price || p.target_original_price || null,
                            original_price: p.target_original_price || null,
                            sale_price: p.target_sale_price || null,
                            discount: p.discount || null,
                            currency: p.target_sale_price_currency || 'USD',
                            product_url: p.product_detail_url || null,
                            promotion_link: p.promotion_link || null,
                            shop_name: p.shop_title || null,
                            rating: p.evaluate_rate || null,
                            orders: p.lastest_volume || null,
                            commission_rate: p.commission_rate || null
                        }))
                    };
                }
            }

            if (data.error_response) {
                lastError = data.error_response.msg || JSON.stringify(data.error_response);
                console.error(`Hot Products API Attempt ${attempt} Error:`, lastError);
            }

        } catch (err) {
            lastError = err.message;
            console.error(`Hot Products API attempt ${attempt} error:`, lastError);
        }
        
        if (attempt < maxRetries) {
            console.log(`Retrying Hot Products API... (${attempt}/${maxRetries})`);
        }
    }

    return { success: false, error: lastError || 'Failed to fetch hot products' };
}

async function searchProducts(options = {}) {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 1) {
                await new Promise(resolve => setTimeout(resolve, 1100 * (attempt - 1)));
            }

            const appKey = process.env.ALIEXPRESS_APP_KEY;
            const appSecret = process.env.ALIEXPRESS_APP_SECRET;

            if (!appKey || !appSecret) {
                console.error('Missing AliExpress API credentials');
                return { success: false, error: 'Missing API credentials' };
            }

            const params = {
                method: 'aliexpress.affiliate.product.query',
                app_key: appKey,
                sign_method: 'md5',
                timestamp: Date.now().toString(),
                format: 'json',
                v: '2.0',
                target_currency: options.currency || 'USD',
                target_language: options.language || 'EN',
                tracking_id: process.env.ALIEXPRESS_TRACK_ID || 'default',
                page_no: options.page || '1',
                page_size: options.limit || '10',
                sort: options.sort || 'SALE_PRICE_ASC'
            };

            if (options.keywords) params.keywords = options.keywords;
            if (options.category) params.category_ids = options.category;
            if (options.minPrice) params.min_sale_price = options.minPrice;
            if (options.maxPrice) params.max_sale_price = options.maxPrice;

            params.sign = signRequest(params, appSecret);

            const response = await got(API_URL, {
                searchParams: params,
                timeout: { request: 20000 },
                responseType: 'json'
            });

            const data = response.body;
            
            if (data.aliexpress_affiliate_product_query_response) {
                const result = data.aliexpress_affiliate_product_query_response.resp_result;
                if (result && result.result && result.result.products && result.result.products.product) {
                    const products = result.result.products.product;
                    const productList = Array.isArray(products) ? products : [products];
                    
                    return {
                        success: true,
                        total: result.result.total_record_count || productList.length,
                        products: productList.map(p => ({
                            id: p.product_id,
                            title: p.product_title || '',
                            image_url: p.product_main_image_url || null,
                            price: p.target_sale_price || p.target_original_price || null,
                            original_price: p.target_original_price || null,
                            sale_price: p.target_sale_price || null,
                            discount: p.discount || null,
                            currency: p.target_sale_price_currency || 'USD',
                            product_url: p.product_detail_url || null,
                            promotion_link: p.promotion_link || null,
                            shop_name: p.shop_title || null,
                            rating: p.evaluate_rate || null,
                            orders: p.lastest_volume || null,
                            commission_rate: p.commission_rate || null
                        }))
                    };
                }
            }

            if (data.error_response) {
                lastError = data.error_response.msg || JSON.stringify(data.error_response);
                console.error(`Product Query API Attempt ${attempt} Error:`, lastError);
            }

        } catch (err) {
            lastError = err.message;
            console.error(`Product Query API attempt ${attempt} error:`, lastError);
        }
        
        if (attempt < maxRetries) {
            console.log(`Retrying Product Query API... (${attempt}/${maxRetries})`);
        }
    }

    return { success: false, error: lastError || 'Failed to search products' };
}

module.exports = { getProductDetails, searchHotProducts, searchProducts };
