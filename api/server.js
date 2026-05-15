const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();

// ─── SECURITY: Rate Limiting ───────────────
const rateLimitMap = new Map();
function rateLimit(maxReqs, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
    const key = ip + req.path;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count++;
    rateLimitMap.set(key, entry);
    if (entry.count > maxReqs) {
      return res.status(429).json({ error: 'طلبات كثيرة — انتظر قليلاً' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now - val.start > 300000) rateLimitMap.delete(key);
  }
}, 300000);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── SECURITY: Token Validation ────────────
function requireToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ','') || req.body?.token;
  if (!token || token === 'demo' || token.length < 20) {
    return res.status(401).json({ error: 'غير مصرح — يرجى ربط المتجر أولاً' });
  }
  req.sallaToken = token;
  next();
}

// ─── SECURITY: Admin Key Validation ────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!key || key !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'غير مصرح — كلمة مرور خاطئة' });
  }
  next();
}

// ─── SECURITY: Security Headers ────────────
app.use((req, res, next) => {
  // ✅ السماح لسلة بتضمين التطبيق في iframe
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.salla.sa https://*.salla.dev https://*.salla.partners"
  );
  // ✅ إزالة X-Frame-Options لأنه يتعارض مع iframe سلة
  res.removeHeader('X-Frame-Options');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '5mb' }));

const publicPath = path.join(__dirname, '../public');

// ════════════════════════════════════════════
// ROUTES قبل static
// ════════════════════════════════════════════
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'landing.html'));
});
app.get('/app', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicPath, 'admin.html'));
});
app.get('/about', (req, res) => { res.sendFile(path.join(publicPath, 'about.html')); });
app.get('/about.html', (req, res) => { res.sendFile(path.join(publicPath, 'about.html')); });
app.get('/privacy', (req, res) => { res.sendFile(path.join(publicPath, 'privacy.html')); });
app.get('/privacy.html', (req, res) => { res.sendFile(path.join(publicPath, 'privacy.html')); });
app.get('/terms', (req, res) => { res.sendFile(path.join(publicPath, 'terms.html')); });
app.get('/terms.html', (req, res) => { res.sendFile(path.join(publicPath, 'terms.html')); });
app.get('/landing', (req, res) => { res.sendFile(path.join(publicPath, 'landing.html')); });
app.get('/landing.html', (req, res) => { res.sendFile(path.join(publicPath, 'landing.html')); });

app.use(express.static(publicPath, { index: false }));

const openai  = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REDIRECT_URI = process.env.APP_URL
  ? process.env.APP_URL + '/auth/callback'
  : 'https://nmo-almatjar-production.up.railway.app/auth/callback';

// ─────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://neepfsawxdcdmfnbilft.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_jl6GnYYSuhlUjb8Ww6DTzA_Ek3_Ald6';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;

async function dbQuery(method, table, body, params) {
  params = params || '';
  const url = SUPABASE_URL + '/rest/v1/' + table + params;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation'
  };
  const r = await axios({ method, url, headers, data: body });
  return r.data;
}

async function saveCustomer(token, store) {
  try {
    await dbQuery('POST', 'customers', {
      salla_token: token,
      store_id: (store.id || '').toString(),
      store_name: store.name || '',
      email: store.email || (store.merchant && store.merchant.email) || '',
      avatar: store.avatar || '',
      plan: store.plan || 'free',
      products_count: store.products_count || 0,
      last_login: new Date().toISOString(),
      created_at: new Date().toISOString()
    });
    console.log('Customer saved:', store.name);
  } catch(e) {
    console.error('saveCustomer error:', e.message);
  }
}

const AI_MODEL = 'claude-haiku-4-5-20251001';

const PLANS = {
  free:       { limit: 2,     name: 'مجاني',     price: 0   },
  pro:        { limit: 200,   name: 'Pro',        price: 99  },
  enterprise: { limit: 99999, name: 'Enterprise', price: 299 }
};

async function checkLimit(storeId) {
  try {
    const url = SUPABASE_URL + '/rest/v1/customers?store_id=eq.' + String(storeId);
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };
    const r = await axios.get(url, { headers });
    const customer = r.data?.[0];
    if (!customer) return { allowed: true, plan: 'free', used: 0, limit: 2 };
    const { plan, products_count } = customer;
    const limit = PLANS[plan]?.limit || 2;
    return { allowed: products_count < limit, plan, used: products_count, limit };
  } catch(e) {
    return { allowed: true, plan: 'free', used: 0, limit: 2 };
  }
}

async function incUsageCount(storeId) {
  try {
    const url = SUPABASE_URL + '/rest/v1/customers?store_id=eq.' + String(storeId);
    const headers = {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    };
    // جلب القيمة الحالية أولاً
    const r = await axios.get(url, { headers });
    const current = r.data?.[0]?.products_count || 0;
    await axios.patch(url, { products_count: current + 1 }, { headers });
  } catch(e) { console.warn('incUsage error:', e.message); }
}

// ─────────────────────────────────────────
// ✅ EMBEDDED AUTH — التحقق من توكن سلة المضمّن
// ─────────────────────────────────────────
app.post('/api/auth/verify-embedded', rateLimit(30, 60000), async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token مطلوب' });

    // التحقق عبر Salla Introspection API الرسمي
    let merchantId = null;
    try {
      const introspect = await axios.post(
        'https://api.salla.dev/exchange-authority/v1/introspect',
        { token },
        {
          headers: {
            'Content-Type': 'application/json',
            'S-Source': process.env.SALLA_CLIENT_ID
          }
        }
      );
      merchantId = introspect.data?.data?.merchant_id;
    } catch(ie) {
      console.warn('Introspect failed:', ie.response?.data || ie.message);
      // نكمل — قد يكون التوكن عادي OAuth
    }

    // جلب معلومات المتجر
    let storeName = 'متجرك';
    let storeId = merchantId ? String(merchantId) : null;
    try {
      const storeInfo = await axios.get('https://api.salla.dev/admin/v2/store/info', {
        headers: { Authorization: 'Bearer ' + token }
      });
      const data = storeInfo.data?.data || {};
      storeName = data.name || storeName;
      storeId = storeId || String(data.id || '');
      await saveCustomer(token, data);
    } catch(se) {
      console.warn('Store info error:', se.message);
      if (!storeId) return res.status(401).json({ error: 'فشل التحقق من المتجر' });
    }

    res.json({
      success: true,
      access_token: token,
      merchant_id: merchantId,
      store_id: storeId,
      store_name: storeName
    });

  } catch(e) {
    console.error('verify-embedded error:', e.message);
    res.status(401).json({ error: 'فشل التحقق من الجلسة' });
  }
});

// ─────────────────────────────────────────
// ✅ BILLING WEBHOOK — استقبال اشتراكات سلة
// ─────────────────────────────────────────
app.post('/api/billing/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Billing webhook:', JSON.stringify(body));

    // سلة ترسل event مثل: app.subscription.started / app.subscription.renewed
    const event   = body.event || body.type || '';
    const storeId = String(body.data?.store?.id || body.store_id || body.merchant_id || '');
    const planId  = body.data?.plan_id || body.plan || '';

    if (!storeId) return res.status(400).json({ error: 'storeId مطلوب' });

    // تحويل plan_id لاسم الخطة
    const planMap = {
      'pro':           'pro',
      'pro_200':       'pro',
      'enterprise':    'enterprise',
      'enterprise_999':'enterprise',
      'free':          'free'
    };
    const resolvedPlan = planMap[planId] || (planId.includes('enterprise') ? 'enterprise' : 'pro');

    // تحديث في Supabase
    const url = SUPABASE_URL + '/rest/v1/customers?store_id=eq.' + storeId;
    const headers = {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    };

    const updateData = {
      plan: resolvedPlan,
      plan_updated_at: new Date().toISOString()
    };

    // عند إلغاء الاشتراك — ارجع لـ free
    if (event.includes('ended') || event.includes('cancelled') || event.includes('canceled')) {
      updateData.plan = 'free';
    }

    // عند بدء اشتراك جديد — أعد العداد
    if (event.includes('started') || event.includes('renewed')) {
      updateData.products_count = 0;
    }

    await axios.patch(url, updateData, { headers });
    console.log(`✅ Billing: store=${storeId} plan=${updateData.plan} event=${event}`);
    res.json({ success: true });

  } catch(e) {
    console.error('billing webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// PLAN API
// ─────────────────────────────────────────
app.post('/api/plan', async (req, res) => {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'غير مصرح' });

    let storeId = req.body.storeId;
    if (!storeId && token !== 'demo') {
      try {
        const storeInfo = await sallaGet('store/info', token);
        storeId = String(storeInfo.data?.id || '');
      } catch(e) { storeId = 'unknown'; }
    }

    const url = SUPABASE_URL + '/rest/v1/customers?store_id=eq.' + storeId;
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };
    const r = await axios.get(url, { headers });
    const customer = r.data?.[0];

    const plan  = customer?.plan || 'free';
    const used  = customer?.products_count || 0;
    const limit = PLANS[plan]?.limit || 2;

    res.json({
      plan, used, limit,
      allowed: used < limit,
      plans: PLANS
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const { email, source } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'بريد إلكتروني غير صحيح' });
    const cleanEmail = email.toLowerCase().trim();
    const url = SUPABASE_URL + '/rest/v1/leads';
    const headers = {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates'
    };
    try {
      await axios.post(url, { email: cleanEmail, source: source||'app' }, { headers });
    } catch(dbErr) {
      const code = dbErr.response?.data?.code || '';
      if (code !== '23505' && dbErr.response?.status !== 409) {
        console.error('DB error:', dbErr.response?.data);
      }
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function getToken(req) {
  return req.headers.authorization?.replace('Bearer ', '') || req.body?.token || '';
}

async function sallaGet(endpoint, token) {
  const r = await axios.get(`https://api.salla.dev/admin/v2/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data;
}

async function sallaUpdate(productId, data, token) {
  const r = await axios.put(`https://api.salla.dev/admin/v2/products/${productId}`, data, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return r.data;
}

function extractSection(text, key) {
  let m = text.match(new RegExp(`###${key}###\\s*\\n([\\s\\S]+?)(?=\\n###[A-Z0-9_]+###|$)`));
  if (m && m[1].trim()) return m[1].trim();
  m = text.match(new RegExp(`(?:^|\\n)${key}:\\s*\\n([\\s\\S]+?)(?=\\n[A-Z0-9_]+:|$)`, 'm'));
  if (m && m[1].trim()) return m[1].trim();
  m = text.match(new RegExp(`(?:^|\\n)${key}:\\s*([^\\n]+)`, 'm'));
  return m ? m[1].trim() : '';
}

function descriptionToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  for (let line of lines) {
    line = line.trim();
    if (!line) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (line.startsWith('- ') || line.startsWith('• ')) {
      if (!inList) { html += '<ul style="padding-right:20px;margin:10px 0;">'; inList = true; }
      html += `<li style="margin-bottom:6px;line-height:1.8;color:#444;">${line.replace(/^[-•]\s*/, '')}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const isHeading = (line.endsWith(':') && line.length < 60)
      || /^\*\*(.+)\*\*$/.test(line)
      || (line.length < 55 && !line.endsWith('.') && !line.endsWith('،'));
    if (isHeading) {
      const clean = line.replace(/\*\*/g, '').replace(/:$/, '');
      html += `<h3 style="font-size:16px;font-weight:700;color:#222;margin:18px 0 8px;">${clean}</h3>`;
    } else {
      html += `<p style="font-size:14px;line-height:1.9;color:#444;margin-bottom:12px;">${line.replace(/\*\*/g, '<strong>').replace(/\*\*/g, '</strong>')}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

// ─────────────────────────────────────────
// AUTH — OAuth
// ─────────────────────────────────────────
app.get('/auth/salla', (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  res.redirect(`https://accounts.salla.sa/oauth2/auth?client_id=${process.env.SALLA_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=offline_access&state=${state}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');
    const params = new URLSearchParams();
    params.append('client_id', process.env.SALLA_CLIENT_ID);
    params.append('client_secret', process.env.SALLA_CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', REDIRECT_URI);
    const r = await axios.post('https://accounts.salla.sa/oauth2/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const accessToken = r.data.access_token;
    try {
      const storeInfo = await axios.get('https://api.salla.dev/admin/v2/store/info', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      await saveCustomer(accessToken, storeInfo.data.data || {});
    } catch(se) { console.error('store info error:', se.message); }
    res.redirect('/app?token=' + accessToken);
  } catch (e) {
    console.error('Auth error:', e.response?.data || e.message);
    res.redirect('/?error=auth_failed');
  }
});

// ─────────────────────────────────────────
// PRODUCTS
// ─────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const token = getToken(req);
    if (!token || token === 'demo') {
      return res.json({ products: [
        { id: 1, name: 'منتج تجريبي', price: { amount: 99 },  description: 'وصف قصير' },
        { id: 2, name: 'منتج آخر',    price: { amount: 149 }, description: '' }
      ]});
    }
    const data = await sallaGet('products?per_page=50', token);
    res.json({ products: data.data || [] });
  } catch (e) {
    res.json({ products: [] });
  }
});

app.post('/api/seo-score', rateLimit(10, 60000), async (req, res) => {
  try {
    const { products } = req.body;
    const scored = products.map(p => {
      let score = 0;
      const issues = [];
      const desc = p.description || '';
      if (desc.length > 100) score += 25; else issues.push('الوصف قصير جداً');
      if (desc.length > 300) score += 15;
      if ((p.name||'').length > 20) score += 20; else issues.push('العنوان قصير');
      if (p.tags?.length > 0) score += 15;   else issues.push('لا توجد وسوم');
      if (p.images?.length > 0) score += 15; else issues.push('لا توجد صور');
      if (p.metadata_title) score += 10;     else issues.push('عنوان SEO غير موجود');
      let grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
      return { id: p.id, name: p.name, score, grade, issues };
    });
    res.json({ results: scored });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-description', rateLimit(10, 60000), async (req, res) => {
  try {
    const { name, currentDescription, audience, tone, instructions, mode, storeId } = req.body;
    if (storeId) {
      const limit = await checkLimit(storeId);
      if (!limit.allowed) {
        return res.status(429).json({
          error: `وصلت للحد الشهري (${limit.used}/${limit.limit} منتج). الرجاء الترقية للخطة Pro`,
          limitReached: true, plan: limit.plan, used: limit.used, limit: limit.limit
        });
      }
    }

    const toneMap = { professional:'احترافي ورسمي', youth:'شبابي وعصري', luxury:'فاخر وراقي', friendly:'ودي وقريب' };
    const modeInst = mode === 'improve' ? 'حسّن الوصف الحالي' : 'اكتب وصفاً احترافياً جديداً';

    const catMap = {
      fashion:     { keywords:['فستان','بلوزة','قميص','بنطلون','جاكيت','عباءة','تيشيرت','ملابس','شنطة','حذاء','حقيبة'],    focus:'ركز على: القياسات والمقاسات المتاحة، نوع وجودة القماش، المناسبة المثالية للارتداء، عدد الألوان المتاحة، إمكانية التنسيق مع قطع أخرى' },
      electronics: { keywords:['جوال','موبايل','لابتوب','تابلت','سماعة','شاشة','كاميرا','ساعة ذكية','إلكتروني','جهاز','طابعة'],  focus:'ركز على: المواصفات التقنية الدقيقة، الأداء والسرعة، مدة البطارية، الضمان والخدمة بعد البيع، التوافق مع الأجهزة الأخرى' },
      perfume:     { keywords:['عطر','بخور','دهن','ورد','oud','عود','مسك','برفيوم'],                                          focus:'ركز على: العائلة العطرية (شرقي/غربي/زهري)، النوتات الرئيسية والقاعدة، ثبات العطر ومدة دوامه، المناسبات المثالية، من أين يُستخرج' },
      food:        { keywords:['قهوة','شاي','تمر','عسل','زيت','مكسرات','شوكولاتة','حلوى','عضوي','طبيعي'],                  focus:'ركز على: الفوائد الصحية والغذائية، المكونات الطبيعية والمصدر، طريقة الاستخدام، الشهادات والاعتمادات، الحجم والكمية' },
      home:        { keywords:['أثاث','كنب','طاولة','كرسي','ديكور','سجادة','ستارة','مطبخ','إناء','تحفة'],                  focus:'ركز على: الأبعاد الدقيقة، المواد المستخدمة وجودتها، سهولة التنظيف والصيانة، التصميم ومدى توافقه مع الديكور، الوزن والتجميع' },
      jewelry:     { keywords:['خاتم','سوار','قلادة','أساور','مجوهرات','ذهب','فضة','ألماس','حجر'],                          focus:'ركز على: نوع المعدن والعيار، الحجر الكريم وخصائصه، المقاسات المتاحة، المناسبة (هدية/زفاف/يومي)، طريقة العناية والتخزين' },
    };
    let detectedCat = 'general';
    let catFocus = 'ركز على: الفوائد الرئيسية، مواصفات المنتج، المناسبة، جودة الصنع';
    const nameLower = name.toLowerCase();
    for (const [cat, data] of Object.entries(catMap)) {
      if (data.keywords.some(k => nameLower.includes(k) || (currentDescription||'').includes(k))) {
        detectedCat = cat; catFocus = data.focus; break;
      }
    }

    const reviewsText = instructions?.includes('###REVIEWS###')
      ? instructions.split('###REVIEWS###')[1]?.trim() || ''
      : '';
    const reviewsSection = reviewsText ? `\nتقييمات العملاء الفعلية (استخدمها لتعزيز الوصف):\n${reviewsText}\n` : '';

    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `أنت خبير كتابة محتوى تجارة إلكترونية متخصص. اكتب بالعربية فقط. لا تستخدم markdown أو نجوم أو **bold**.

المنتج: ${name}
الفئة المكتشفة: ${detectedCat}
${currentDescription ? `الوصف الحالي:\n${currentDescription}\n` : ''}الجمهور المستهدف: ${audience || 'العملاء السعوديين'}
الأسلوب: ${toneMap[tone] || 'احترافي'}
تعليمات الفئة: ${catFocus}
تعليمات إضافية: ${instructions?.split('###REVIEWS###')[0]?.trim() || modeInst}
${reviewsSection}
اكتب الرد بهذا الشكل بالضبط. لا تضف أي نص خارج هذه الأقسام:

###SEO_TITLE###
[عنوان المنتج المحسّن لـ SEO بين 50-60 حرف — يتضمن الكلمة الرئيسية]

###SEO_DESC###
[وصف محركات البحث — جملة واحدة أو جملتان، 140-160 حرف]

###SHORT_DESC###
[وصف قصير مقنع — جملتان فقط، يبرز أهم ميزة]

###LONG_DESC###
[اكتب وصفاً كاملاً مراعياً تعليمات الفئة:
- فقرة افتتاحية (3-4 جمل) تصف المنتج وقيمته
- عنوان فرعي تفصيلي ثم فقرة
- مميزات المنتج بعلامة - 
- فقرة ختامية تحفز على الشراء]

###FEATURES###
[5 مميزات مخصصة للفئة، كل ميزة في سطر يبدأ بـ - ]

###TIKTOK_CAPTION###
[كابشن TikTok — جملة جذابة + 5 هاشتاقات]

###DETECTED_CATEGORY###
[${detectedCat}]`
      }]
    });

    const text = message.content[0].text;
    const longDesc = extractSection(text, 'LONG_DESC');
    const features = extractSection(text, 'FEATURES')
      .split('\n').filter(f => f.trim().startsWith('-')).map(f => f.replace(/^-\s*/, '').trim());

    if (storeId) await incUsageCount(storeId);
    res.json({
      seoTitle:         extractSection(text, 'SEO_TITLE'),
      seoDescription:   extractSection(text, 'SEO_DESC'),
      shortDescription: extractSection(text, 'SHORT_DESC'),
      description:      longDesc,
      descriptionHtml:  descriptionToHtml(longDesc),
      features,
      tiktokCaption:    extractSection(text, 'TIKTOK_CAPTION'),
      detectedCategory: extractSection(text, 'DETECTED_CATEGORY') || detectedCat,
      oldDescription:   currentDescription || ''
    });
  } catch (e) {
    console.error('generate-description ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/improve-description', async (req, res) => {
  try {
    const { name, currentDescription, instructions } = req.body;
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `خبير تحسين محتوى للتجارة الإلكترونية. بالعربية بدون markdown.
المنتج: ${name}
الوصف الحالي: ${currentDescription || 'لا يوجد'}
تعليمات: ${instructions || 'حسّن الوصف وارفع جودته'}

###SEO_TITLE###
[عنوان محسّن]

###SEO_DESC###
[وصف SEO 150 حرف]

###LONG_DESC###
[وصف محسّن كامل مع عناوين فرعية ونقاط]`
      }]
    });
    const text = message.content[0].text;
    const longDesc = extractSection(text, 'LONG_DESC');
    res.json({
      seoTitle:       extractSection(text, 'SEO_TITLE'),
      seoDescription: extractSection(text, 'SEO_DESC'),
      description:    longDesc,
      descriptionHtml:descriptionToHtml(longDesc),
      oldDescription: currentDescription || ''
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-seo', async (req, res) => {
  try {
    const { name, description, keywords } = req.body;
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `خبير SEO. بالعربية فقط.
المنتج: ${name}
الوصف: ${description || name}
كلمات إضافية: ${keywords || ''}

###SEO_TITLE###
[عنوان SEO 50-60 حرف]

###SEO_DESC###
[وصف SEO 150-160 حرف]

###SEO_KEYWORDS###
[15 كلمة مفتاحية مفصولة بفاصلة]`
      }]
    });
    const text = message.content[0].text;
    res.json({
      seoTitle:       extractSection(text, 'SEO_TITLE'),
      seoDescription: extractSection(text, 'SEO_DESC'),
      seoKeywords:    extractSection(text, 'SEO_KEYWORDS')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-tags', rateLimit(20, 60000), async (req, res) => {
  try {
    const { name, description } = req.body;
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `وسوم للمنتج: ${name}. الوصف: ${description || ''}.
أعطني 10 وسوم قصيرة (1-3 كلمات) مفصولة بفاصلة. عربية وإنجليزية. الوسوم فقط:`
      }]
    });
    const tags = message.content[0].text.split(',').map(t => t.trim()).filter(t => t && t.length < 40);
    res.json({ tags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/optimize-title', rateLimit(20, 60000), async (req, res) => {
  try {
    const { name, description, category } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: `حسّن عنوان المنتج للـ SEO.
العنوان الحالي: ${name}
الفئة: ${category || 'عام'}
الوصف: ${description || ''}
اكتب 3 عناوين محسّنة بالعربية، لا تتجاوز 70 حرفاً.

###TITLE1###
[العنوان الأول]

###TITLE2###
[العنوان الثاني]

###TITLE3###
[العنوان الثالث]` }]
    });
    const text = msg.content[0].text;
    res.json({
      original: name,
      title1: extractSection(text, 'TITLE1'),
      title2: extractSection(text, 'TITLE2'),
      title3: extractSection(text, 'TITLE3')
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-social', async (req, res) => {
  try {
    const { name, description } = req.body;
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `محتوى سوشال ميديا للمنتج: ${name}. الوصف: ${description || ''}

###INSTAGRAM###
[كابشن انستغرام + هاشتاقات]

###TIKTOK###
[سكريبت TikTok 15-30 ثانية]

###TWITTER###
[تغريدة 280 حرف]

###HASHTAGS###
[20 هاشتاق]`
      }]
    });
    const text = message.content[0].text;
    res.json({
      instagram: extractSection(text, 'INSTAGRAM'),
      tiktok:    extractSection(text, 'TIKTOK'),
      twitter:   extractSection(text, 'TWITTER'),
      hashtags:  extractSection(text, 'HASHTAGS')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-product', rateLimit(30, 60000), async (req, res) => {
  try {
    const { productId, description, descriptionHtml, seoTitle, seoDescription, name, token } = req.body;
    if (!productId || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const updateData = {};
    if (descriptionHtml) updateData.description = descriptionHtml;
    else if (description) updateData.description = descriptionToHtml(description);
    if (seoTitle)       { updateData.metadata_title = seoTitle; updateData.name = seoTitle; }
    if (seoDescription) updateData.metadata_description = seoDescription;
    if (name && !seoTitle) updateData.name = name;
    const result = await sallaUpdate(productId, updateData, token);
    res.json({ success: true, product: result.data });
  } catch (e) {
    console.error('Update error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.post('/api/add-tags', rateLimit(5, 60000), async (req, res) => {
  try {
    const { productId, tags, token } = req.body;
    if (!productId || !tags?.length || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const cleanTags = tags.slice(0,10).map(t=>String(t).trim()).filter(t=>t.length>0);
    if (!cleanTags.length) return res.json({ success: true, added: 0 });
    const authHeader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const tagIds = [];
    let storeTags = [];
    try {
      const listR = await axios.get('https://api.salla.dev/admin/v2/products/tags', { headers: authHeader });
      storeTags = listR.data?.data || [];
    } catch(e) { console.warn('list tags:', e.message); }
    for (const tagName of cleanTags) {
      const existing = storeTags.find(t => t.name?.trim().toLowerCase() === tagName.toLowerCase());
      if (existing?.id) { tagIds.push(existing.id); continue; }
      try {
        const r = await axios.post(
          'https://api.salla.dev/admin/v2/products/tags',
          null,
          { headers: authHeader, params: { tag_name: tagName } }
        );
        const newId = r.data?.data?.id;
        if (newId) { tagIds.push(newId); storeTags.push({id:newId,name:tagName}); }
      } catch(e) { console.warn('create tag:', tagName, e.response?.data?.error?.message || e.message); }
      await new Promise(r=>setTimeout(r,300));
    }
    if (tagIds.length > 0) {
      let existingTagIds = [];
      try {
        const prod = await sallaGet(`products/${productId}`, token);
        existingTagIds = (prod.data?.tags||[]).map(t=>t.id).filter(Boolean);
      } catch(e) {}
      const allTagIds = [...new Set([...existingTagIds, ...tagIds])];
      await sallaUpdate(productId, { tags: allTagIds }, token);
    }
    res.json({ success: true, added: tagIds.length, tagIds });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/get-reviews', async (req, res) => {
  try {
    const { productId, token } = req.body;
    if (!productId || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const r = await sallaGet(`products/${productId}/reviews`, token);
    const reviews = (r.data || []).slice(0, 10).map(rv => ({
      rating: rv.rating,
      comment: rv.comment || rv.body || '',
      author: rv.reviewer?.name || 'عميل'
    })).filter(rv => rv.comment && rv.comment.length > 5);
    res.json({ reviews, count: reviews.length });
  } catch (e) {
    res.status(500).json({ error: e.message, reviews: [] });
  }
});

// ─────────────────────────────────────────
// WEBHOOK سلة — أحداث التطبيق
// ─────────────────────────────────────────
app.post('/webhook/salla', async (req, res) => {
  try {
    const { event, data } = req.body;
    console.log('Webhook event:', event);

    // ✅ استقبال تثبيت التطبيق من سلة (Easy Mode)
    if (event === 'app.store.authorize') {
      const token = data?.token?.access_token || data?.access_token;
      const storeId = String(data?.merchant?.id || data?.store?.id || '');
      if (token && storeId) {
        try {
          const storeInfo = await axios.get('https://api.salla.dev/admin/v2/store/info', {
            headers: { Authorization: 'Bearer ' + token }
          });
          await saveCustomer(token, storeInfo.data?.data || { id: storeId });
          console.log('✅ App installed for store:', storeId);
        } catch(e) { console.warn('install webhook store info:', e.message); }
      }
    }

    // ✅ أحداث الاشتراك
    if (event?.includes('app.subscription') || event?.includes('app.trial')) {
      const storeId = String(data?.store?.id || data?.merchant?.id || '');
      const planId  = data?.plan_id || '';
      if (storeId) {
        const planMap = { 'pro':'pro', 'pro_200':'pro', 'enterprise':'enterprise', 'enterprise_999':'enterprise' };
        const plan = planMap[planId] || 'pro';
        const url = SUPABASE_URL + '/rest/v1/customers?store_id=eq.' + storeId;
        const headers = {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json'
        };
        const updateData = { plan_updated_at: new Date().toISOString() };
        if (event.includes('ended') || event.includes('cancelled')) {
          updateData.plan = 'free';
        } else {
          updateData.plan = event.includes('trial') ? 'trial' : plan;
          if (event.includes('started') || event.includes('renewed')) updateData.products_count = 0;
        }
        await axios.patch(url, updateData, { headers }).catch(e => console.warn(e.message));
        console.log(`Subscription event: ${event} store:${storeId} plan:${updateData.plan}`);
      }
    }

    res.json({ success: true });
  } catch(e) {
    console.error('webhook error:', e.message);
    res.json({ success: true }); // دائماً 200 لسلة
  }
});

app.get('/api/templates', (req, res) => {
  res.json({ templates: [
    { id:'fashion',     name:'👗 ملابس وأزياء',   tone:'youth',        instructions:'ركز على الأناقة والتناسق، اذكر المقاسات والألوان، أسلوب شبابي' },
    { id:'electronics', name:'📱 إلكترونيات',      tone:'professional', instructions:'ركز على المواصفات التقنية والأداء، اذكر الضمان، أسلوب احترافي' },
    { id:'perfume',     name:'🌸 عطور ومستحضرات', tone:'luxury',       instructions:'ركز على الرائحة والثبات، اجعله فاخراً شاعرياً، اذكر المناسبات' },
    { id:'food',        name:'🍃 غذاء وصحة',       tone:'friendly',     instructions:'ركز على الفوائد الصحية والمكونات الطبيعية، أسلوب ودي' },
    { id:'home',        name:'🏠 منزل وديكور',     tone:'professional', instructions:'ركز على الجودة والتصميم، اذكر الأبعاد والمواد' },
    { id:'jewelry',     name:'💍 مجوهرات',         tone:'luxury',       instructions:'ركز على المواد والتصميم الفريد، اذكر المناسبات والهدايا' }
  ]});
});

app.get('/api/debug', async (req, res) => {
  const result = {
    model: AI_MODEL,
    anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
    salla_client_id_set: !!process.env.SALLA_CLIENT_ID,
    openai_key_set: !!process.env.OPENAI_API_KEY,
    node_version: process.version,
    time: new Date().toISOString()
  };
  try {
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 10,
      messages: [{ role: 'user', content: 'Say: OK' }]
    });
    result.anthropic_test = 'SUCCESS: ' + msg.content[0].text;
  } catch(e) {
    result.anthropic_test = 'FAILED: ' + e.message;
  }
  res.json(result);
});

// ─────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin2025';
function checkAdmin(req, res) {
  const pass = req.headers['x-admin-key'] || req.query.key;
  if (pass !== ADMIN_PASS) { res.status(401).json({ error: 'غير مصرح' }); return false; }
  return true;
}

app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await dbQuery('GET', 'customers', null, '?order=created_at.desc');
    res.json({ customers: data, total: data.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { id } = req.params;
    const updates = req.body;
    const data = await dbQuery('PATCH', 'customers', updates, `?id=eq.${id}`);
    res.json({ success: true, customer: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    await dbQuery('DELETE', 'customers', null, `?id=eq.${req.params.id}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const customers = await dbQuery('GET', 'customers', null, '');
    const today = new Date().toISOString().split('T')[0];
    const todayNew = customers.filter(c => c.created_at?.startsWith(today)).length;
    const thisMonth = customers.filter(c => c.created_at?.startsWith(new Date().toISOString().substring(0,7))).length;
    res.json({
      total: customers.length,
      today: todayNew,
      this_month: thisMonth,
      latest: customers.slice(0, 5)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/leads', requireAdmin, async (req, res) => {
  try {
    const url = SUPABASE_URL + '/rest/v1/leads?order=created_at.desc';
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };
    const r = await axios.get(url, { headers });
    res.json({ leads: r.data || [], total: (r.data||[]).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// CATCH-ALL
// ─────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/webhook/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(publicPath, 'landing.html'));
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log('=== SERVER READY === port:' + PORT + ' model:' + AI_MODEL);
});
