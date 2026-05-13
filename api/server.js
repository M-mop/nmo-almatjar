const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));
app.get('/', (req, res) => {
  const f = path.join(publicPath, 'index.html');
  fs.existsSync(f) ? res.sendFile(f) : res.send('<h1>ذكاء المتجر</h1>');
});

// لوحة الإدارة
app.get('/admin', (req, res) => {
  const f = path.join(publicPath, 'admin.html');
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).send('Admin page not found');
});

const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REDIRECT_URI = 'https://salla-ai-app-indol.vercel.app/auth/callback';

// ─────────────────────────────────────────
// SUPABASE — قاعدة بيانات العملاء
// ─────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://neepfsawxdcdmfnbilft.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_jl6GnYYSuhlUjb8Ww6DTzA_Ek3_Ald6';

async function dbQuery(method, table, body, params) {
  params = params || '';
  const url = SUPABASE_URL + '/rest/v1/' + table + params;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation'
  };
  const r = await axios({ method: method, url: url, headers: headers, data: body });
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

// Single source of truth for model name
const AI_MODEL = 'claude-haiku-4-5-20251001';
console.log('=== SERVER START ===', 'model:', AI_MODEL, 'anthropic_key:', !!process.env.ANTHROPIC_API_KEY);

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

// ─────────────────────────────────────────
// EXTRACT HELPER  — robust triple-strategy
// ─────────────────────────────────────────
function extractSection(text, key) {
  // Strategy 1: ###KEY### delimiter
  let m = text.match(new RegExp(`###${key}###\\s*\\n([\\s\\S]+?)(?=\\n###[A-Z0-9_]+###|$)`));
  if (m && m[1].trim()) return m[1].trim();

  // Strategy 2: KEY:\n multi-line
  m = text.match(new RegExp(`(?:^|\\n)${key}:\\s*\\n([\\s\\S]+?)(?=\\n[A-Z0-9_]+:|$)`, 'm'));
  if (m && m[1].trim()) return m[1].trim();

  // Strategy 3: KEY: single line
  m = text.match(new RegExp(`(?:^|\\n)${key}:\\s*([^\\n]+)`, 'm'));
  return m ? m[1].trim() : '';
}

// ─────────────────────────────────────────
// CONVERT PLAIN TEXT → RICH HTML
// ─────────────────────────────────────────
function descriptionToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  for (let line of lines) {
    line = line.trim();
    if (!line) {
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }

    // Bullet point
    if (line.startsWith('- ') || line.startsWith('• ')) {
      if (!inList) {
        html += '<ul style="padding-right:20px;margin:10px 0;">';
        inList = true;
      }
      html += `<li style="margin-bottom:6px;line-height:1.8;color:#444;">${line.replace(/^[-•]\s*/, '')}</li>`;
      continue;
    }

    if (inList) { html += '</ul>'; inList = false; }

    // Heading: line ends with : or wrapped in ** or is short (< 50 chars, no period)
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
// AUTH
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
    // جلب بيانات المتجر وحفظ العميل في قاعدة البيانات
    try {
      const storeInfo = await axios.get('https://api.salla.dev/admin/v2/store/info', {
        headers: { Authorization: 'Bearer ' + accessToken }
      });
      await saveCustomer(accessToken, storeInfo.data.data || {});
    } catch(se) { console.error('store info error:', se.message); }
    res.redirect('/?token=' + accessToken);
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

// ─────────────────────────────────────────
// SEO SCORE
// ─────────────────────────────────────────
app.post('/api/seo-score', async (req, res) => {
  try {
    const { products } = req.body;
    const scored = products.map(p => {
      let score = 0;
      const issues = [];
      const desc = p.description || '';
      if (desc.length > 100) score += 25; else issues.push('الوصف قصير جداً');
      if (desc.length > 300) score += 15;
      if ((p.name||'').length > 20) score += 20; else issues.push('العنوان قصير');
      if (p.tags?.length > 0) score += 15;    else issues.push('لا توجد وسوم');
      if (p.images?.length > 0) score += 15;  else issues.push('لا توجد صور');
      if (p.metadata_title) score += 10;      else issues.push('عنوان SEO غير موجود');
      let grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
      return { id: p.id, name: p.name, score, grade, issues };
    });
    res.json({ results: scored });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// GENERATE DESCRIPTION  ★ MAIN FIX ★
// ─────────────────────────────────────────
app.post('/api/generate-description', async (req, res) => {
  try {
    const { name, currentDescription, audience, tone, instructions, mode } = req.body;

    const toneMap = { professional:'احترافي ورسمي', youth:'شبابي وعصري', luxury:'فاخر وراقي', friendly:'ودي وقريب' };
    const modeInst = mode === 'improve' ? 'حسّن الوصف الحالي' : 'اكتب وصفاً احترافياً جديداً';

    // ── Category Intelligence: auto-detect product category ──
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

    // ── Fetch reviews if available (Review-to-Content) ──
    const reviewsText = instructions?.includes('###REVIEWS###')
      ? instructions.split('###REVIEWS###')[1]?.trim() || ''
      : '';
    const reviewsSection = reviewsText
      ? `
تقييمات العملاء الفعلية (استخدمها لتعزيز الوصف):
${reviewsText}
`
      : '';

    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `أنت خبير كتابة محتوى تجارة إلكترونية متخصص. اكتب بالعربية فقط. لا تستخدم markdown أو نجوم أو **bold**.

المنتج: ${name}
الفئة المكتشفة: ${detectedCat}
${currentDescription ? `الوصف الحالي:
${currentDescription}
` : ''}الجمهور المستهدف: ${audience || 'العملاء السعوديين'}
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
    console.log('=== generate-description RAW (first 600) ===\n', text.substring(0, 600));

    const longDesc = extractSection(text, 'LONG_DESC');
    const features = extractSection(text, 'FEATURES')
      .split('\n').filter(f => f.trim().startsWith('-')).map(f => f.replace(/^-\s*/, '').trim());

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

// ─────────────────────────────────────────
// IMPROVE DESCRIPTION
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// GENERATE SEO
// ─────────────────────────────────────────
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
      seoTitle:    extractSection(text, 'SEO_TITLE'),
      seoDescription: extractSection(text, 'SEO_DESC'),
      seoKeywords: extractSection(text, 'SEO_KEYWORDS')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// GENERATE TAGS
// ─────────────────────────────────────────
app.post('/api/generate-tags', async (req, res) => {
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

// ─────────────────────────────────────────
// OPTIMIZE TITLE
// ─────────────────────────────────────────
app.post('/api/optimize-title', async (req, res) => {
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

// ─────────────────────────────────────────
// GENERATE SOCIAL
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// GENERATE BLOG
// ─────────────────────────────────────────
app.post('/api/generate-blog', async (req, res) => {
  try {
    const { storeName, products, topic } = req.body;
    const productNames = products.map(p => p.name).join('، ');
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `مقالة SEO لمتجر "${storeName}". الموضوع: ${topic}. المنتجات: ${productNames}

###BLOG_TITLE###
[عنوان المقالة]

###BLOG_INTRO###
[مقدمة — فقرتان]

###BLOG_BODY###
[جسم المقالة — 4-5 فقرات]

###BLOG_CONCLUSION###
[خاتمة تحفز على الشراء]

###BLOG_META###
[وصف SEO للمقالة 150 حرف]`
      }]
    });
    const text = message.content[0].text;
    res.json({
      title:      extractSection(text, 'BLOG_TITLE'),
      intro:      extractSection(text, 'BLOG_INTRO'),
      body:       extractSection(text, 'BLOG_BODY'),
      conclusion: extractSection(text, 'BLOG_CONCLUSION'),
      meta:       extractSection(text, 'BLOG_META')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// UPDATE PRODUCT
// ─────────────────────────────────────────
app.post('/api/update-product', async (req, res) => {
  try {
    const { productId, description, descriptionHtml, seoTitle, seoDescription, name, token } = req.body;
    if (!productId || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const updateData = {};
    // Prefer pre-built HTML; fall back to converter
    if (descriptionHtml) updateData.description = descriptionHtml;
    else if (description) updateData.description = descriptionToHtml(description);
    if (seoTitle)       updateData.metadata_title       = seoTitle;
    if (seoDescription) updateData.metadata_description = seoDescription;
    if (name)           updateData.name = name;
    const result = await sallaUpdate(productId, updateData, token);
    res.json({ success: true, product: result.data });
  } catch (e) {
    console.error('Update error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ─────────────────────────────────────────
// ADD TAGS
// ─────────────────────────────────────────
app.post('/api/add-tags', async (req, res) => {
  try {
    const { productId, tags, token } = req.body;
    if (!productId || !tags?.length || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const tagIds = [];

    // 1) جلب الوسوم الموجودة على المنتج
    try {
      const prod = await sallaGet(`products/${productId}`, token);
      (prod.data?.tags || []).forEach(t => { if (t.id) tagIds.push(t.id); });
    } catch(e) {}

    // 2) جلب كل الوسوم في المتجر مرة واحدة (لتجنب rate limit)
    let allStoreTags = [];
    try {
      const list = await axios.get('https://api.salla.dev/admin/v2/products/tags', {
        headers: { Authorization: `Bearer ${token}` }
      });
      allStoreTags = list.data?.data || [];
    } catch(e) {}

    // 3) لكل وسم: إما موجود أو أنشئه
    for (const tagName of tags.slice(0, 5)) {
      try {
        // ابحث في الوسوم الموجودة أولاً
        const existing = allStoreTags.find(t =>
          t.name?.toLowerCase().trim() === tagName.toLowerCase().trim()
        );
        if (existing?.id) {
          if (!tagIds.includes(existing.id)) tagIds.push(existing.id);
          continue;
        }
        // أنشئ وسم جديد
        const r = await axios.post(
          `https://api.salla.dev/admin/v2/products/tags?tag_name=${encodeURIComponent(tagName)}`,
          {}, { headers: { Authorization: `Bearer ${token}` } }
        );
        const newId = r.data?.data?.id;
        if (newId && !tagIds.includes(newId)) {
          tagIds.push(newId);
          allStoreTags.push({ id: newId, name: tagName }); // أضفه للكاش
        }
        await new Promise(r => setTimeout(r, 900)); // delay كافي لتجنب rate limit سلة
      } catch(e) {
        console.warn(`Tag "${tagName}" failed:`, e.message);
      }
    }

    // 4) delay قبل تحديث المنتج
    await new Promise(r => setTimeout(r, 500));
    // 5) حدّث المنتج بالوسوم
    if (tagIds.length > 0) await sallaUpdate(productId, { tags: tagIds }, token);
    res.json({ success: true, added: tagIds.length, tagIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// PRODUCT REVIEWS (Review-to-Content)
// ─────────────────────────────────────────
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
// ALT TEXT
// ─────────────────────────────────────────
app.post('/api/generate-alt', async (req, res) => {
  try {
    const { productName, count } = req.body;
    const altTexts = [];
    for (let i = 1; i <= (count || 1); i++) {
      const msg = await anthropic.messages.create({
        model: AI_MODEL, max_tokens: 100,
        messages: [{ role: 'user', content: `Alt Text للصورة ${i} للمنتج: ${productName}. 50-100 حرف بالعربية. النص فقط:` }]
      });
      altTexts.push(msg.content[0].text.trim());
    }
    res.json({ altTexts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// SEO PAGES
// ─────────────────────────────────────────
app.post('/api/seo-pages', async (req, res) => {
  try {
    const { products, storeName } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 800,
      messages: [{ role: 'user', content: `منتجات: ${products.map(p=>p.name).join('، ')} — متجر: ${storeName||'المتجر'}
اقترح 5 صفحات SEO.

###PAGE1_TITLE###
[عنوان]
###PAGE1_URL###
[slug]
###PAGE1_DESC###
[وصف]

###PAGE2_TITLE###
[عنوان]
###PAGE2_URL###
[slug]
###PAGE2_DESC###
[وصف]

###PAGE3_TITLE###
[عنوان]
###PAGE3_URL###
[slug]
###PAGE3_DESC###
[وصف]

###PAGE4_TITLE###
[عنوان]
###PAGE4_URL###
[slug]
###PAGE4_DESC###
[وصف]

###PAGE5_TITLE###
[عنوان]
###PAGE5_URL###
[slug]
###PAGE5_DESC###
[وصف]` }]
    });
    const text = msg.content[0].text;
    const pages = [];
    for (let i = 1; i <= 5; i++) {
      const t = extractSection(text, `PAGE${i}_TITLE`);
      const u = extractSection(text, `PAGE${i}_URL`);
      const d = extractSection(text, `PAGE${i}_DESC`);
      if (t) pages.push({ title: t, url: u, description: d });
    }
    res.json({ pages });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────
app.get('/api/templates', (req, res) => {
  res.json({ templates: [
    { id:'fashion',     name:'👗 ملابس وأزياء',        tone:'youth',        instructions:'ركز على الأناقة والتناسق، اذكر المقاسات والألوان، أسلوب شبابي' },
    { id:'electronics', name:'📱 إلكترونيات',           tone:'professional', instructions:'ركز على المواصفات التقنية والأداء، اذكر الضمان، أسلوب احترافي' },
    { id:'perfume',     name:'🌸 عطور ومستحضرات',       tone:'luxury',       instructions:'ركز على الرائحة والثبات، اجعله فاخراً شاعرياً، اذكر المناسبات' },
    { id:'food',        name:'🍃 غذاء وصحة',            tone:'friendly',     instructions:'ركز على الفوائد الصحية والمكونات الطبيعية، أسلوب ودي' },
    { id:'home',        name:'🏠 منزل وديكور',          tone:'professional', instructions:'ركز على الجودة والتصميم، اذكر الأبعاد والمواد' },
    { id:'jewelry',     name:'💍 مجوهرات',              tone:'luxury',       instructions:'ركز على المواد والتصميم الفريد، اذكر المناسبات والهدايا' }
  ]});
});

// ─────────────────────────────────────────
// IMAGE GEN
// ─────────────────────────────────────────
app.post('/api/generate-image', async (req, res) => {
  try {
    const { name, prompt, style } = req.body;
    const r = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `Professional product photo of ${name}. ${prompt || ''}. ${style}. High quality, commercial photography, no text.`,
      n: 1, size: '1024x1024', quality: 'standard'
    });
    res.json({ imageUrl: r.data[0].url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// EDIT IMAGE
// ─────────────────────────────────────────
app.post('/api/edit-image', upload.single('image'), async (req, res) => {
  try {
    const { prompt } = req.body;
    const base64 = req.file.buffer.toString('base64');
    const mime   = req.file.mimetype;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
          { type: 'text', text: `خبير تحرير صور. المطلوب: "${prompt}". أنشئ DALL-E prompt إنجليزي احترافي. الـ prompt فقط.` }
        ]
      }]
    });
    const r = await openai.images.generate({ model: 'dall-e-3', prompt: msg.content[0].text.slice(0,900), n:1, size:'1024x1024', quality:'standard' });
    res.json({ imageUrl: r.data[0].url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// TRANSLATE
// ─────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  try {
    const { text, language } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 500,
      messages: [{ role:'user', content:`ترجم إلى ${language} بشكل احترافي للتجارة الإلكترونية. الترجمة فقط:\n\n${text}` }]
    });
    res.json({ translation: msg.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────
app.post('/webhook/salla', (req, res) => {
  console.log('Webhook:', req.body?.event);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// DEBUG endpoint
app.get('/api/debug', async (req, res) => {
  const result = {
    model: AI_MODEL,
    anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
    anthropic_key_prefix: process.env.ANTHROPIC_API_KEY?.substring(0,10) + '...',
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
// ADMIN — لوحة إدارة العملاء
// ─────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin2025';

function checkAdmin(req, res) {
  const pass = req.headers['x-admin-key'] || req.query.key;
  if (pass !== ADMIN_PASS) { res.status(401).json({ error: 'غير مصرح' }); return false; }
  return true;
}

// جلب كل العملاء
app.get('/api/admin/customers', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await dbQuery('GET', 'customers', null, '?order=created_at.desc');
    res.json({ customers: data, total: data.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// تعديل بيانات عميل
app.put('/api/admin/customers/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { id } = req.params;
    const updates = req.body;
    const data = await dbQuery('PATCH', 'customers', updates, `?id=eq.${id}`);
    res.json({ success: true, customer: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// حذف عميل
app.delete('/api/admin/customers/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    await dbQuery('DELETE', 'customers', null, `?id=eq.${req.params.id}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// إحصائيات سريعة
app.get('/api/admin/stats', async (req, res) => {
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
