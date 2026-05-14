const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
// رفعنا حد الملف لـ 50MB ليتحمل الملفات الكبيرة
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const allowedOrigins = [
  'https://nmo-almatjar-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:3001',
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return callback(null, true);
    return callback(new Error('CORS: غير مسموح'), false);
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-admin-key'],
  credentials: true
}));

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
      return res.status(429).json({ error: 'طلبات كثيرة — انتظر قليلاً', retryAfter: Math.ceil((windowMs - (now - entry.start)) / 1000) });
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

function requireToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ','') || req.body?.token;
  if (!token || token === 'demo' || token.length < 20) {
    return res.status(401).json({ error: 'غير مصرح — يرجى ربط المتجر أولاً' });
  }
  req.sallaToken = token;
  next();
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!key || key !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'غير مصرح — كلمة مرور خاطئة' });
  }
  next();
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '5mb' }));

const publicPath = path.join(__dirname, '../public');

app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/about', (req, res) => res.sendFile(path.join(publicPath, 'about.html')));
app.get('/about.html', (req, res) => res.sendFile(path.join(publicPath, 'about.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(publicPath, 'privacy.html')));
app.get('/privacy.html', (req, res) => res.sendFile(path.join(publicPath, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(publicPath, 'terms.html')));
app.get('/terms.html', (req, res) => res.sendFile(path.join(publicPath, 'terms.html')));
app.get('/landing', (req, res) => res.sendFile(path.join(publicPath, 'landing.html')));
app.get('/landing.html', (req, res) => res.sendFile(path.join(publicPath, 'landing.html')));

app.use(express.static(publicPath, { index: false }));

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REDIRECT_URI = process.env.APP_URL
  ? process.env.APP_URL + '/auth/callback'
  : 'https://nmo-almatjar-production.up.railway.app/auth/callback';

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
  } catch(e) { console.error('saveCustomer error:', e.message); }
}

const AI_MODEL = 'claude-haiku-4-5-20251001';

const PLANS = {
  free:       { limit: 2,     name: 'مجاني',     price: 0   },
  pro:        { limit: 200,   name: 'Pro',        price: 99  },
  enterprise: { limit: 99999, name: 'Enterprise', price: 299 }
};

function genReferralCode(storeId) {
  return 'REF' + Buffer.from(String(storeId)).toString('base64').slice(0,6).toUpperCase();
}

async function checkLimit(storeId) {
  try {
    const res = await dbQuery('GET', 'customers', null, `?store_id=eq.${String(storeId)}&select=plan,products_count`);
    if (!res.length) return { allowed: true, plan: 'free', used: 0, limit: 2 };
    const { plan, products_count } = res[0];
    const limit = PLANS[plan]?.limit || 2;
    return { allowed: products_count < limit, plan, used: products_count, limit };
  } catch(e) {
    return { allowed: true, plan: 'free', used: 0, limit: 2 };
  }
}

async function incUsageCount(storeId) {
  try {
    await dbQuery('PATCH', 'customers', { products_count: 'products_count + 1' }, `?store_id=eq.${String(storeId)}`);
  } catch(e) { console.warn('incUsage error:', e.message); }
}

// ══════════════════════════════════════════════════════════
// EXCEL PRODUCTS — نظام Batch الذكي
//
// الفكرة: بدل طلب منفصل لكل منتج، نرسل 10 منتجات في طلب واحد
//
// مقارنة الأداء (800 منتج):
//   قبل:  800 طلب × 4ث = ~53 دقيقة  ❌
//   بعد:  80 طلب ÷ 5 متوازي × 4ث = ~64 ثانية  ✅
// ══════════════════════════════════════════════════════════
app.post('/api/excel/products', rateLimit(3, 60000), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    const tone = req.body.tone || 'professional';
    const toneMap = { professional:'احترافي', luxury:'فاخر وراقي', youth:'شبابي وعصري', friendly:'ودي وقريب' };

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'الملف فارغ أو تالف' });

    const h = String(ws.getRow(2).getCell(3).value || '');
    if (!h.includes('أسم المنتج')) {
      return res.status(400).json({ error: 'هذا ليس ملف المنتجات الصحيح — صدّر ملف "تصدير وتحديث المنتجات الحالية" من سلة' });
    }

    const products = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum < 3) return;
      const id = row.getCell(1).value;
      const name = row.getCell(3).value;
      if (!id || !name) return;
      const rawDesc = String(row.getCell(9).value || '').replace(/<[^>]*>/g, '').substring(0, 200);
      products.push({ rowNum, id, name: String(name), cleanDesc: rawDesc });
    });

    if (!products.length) return res.status(400).json({ error: 'لا توجد منتجات في الملف' });

    const totalProducts = products.length;
    const chunksCount = Math.ceil(totalProducts / 10);
    console.log(`Excel products: ${totalProducts} منتج → ${chunksCount} طلب للذكاء الاصطناعي`);

    const results = new Array(totalProducts).fill(null);

    // ── معالجة Batch: 10 منتجات في رسالة واحدة ──
    async function processBatch(batch, startIdx) {
      const productsList = batch.map((p, i) =>
        `[${i+1}] الاسم: ${p.name}${p.cleanDesc ? '\nالوصف: ' + p.cleanDesc : ''}`
      ).join('\n---\n');

      const prompt =
`أنت كاتب محتوى للتجارة الإلكترونية. اكتب بالعربية فقط. بلا ** أو markdown.
الأسلوب: ${toneMap[tone]}

حسّن هذه المنتجات (${batch.length} منتج) وأرجع النتائج بهذا التنسيق بالضبط:

${productsList}

---
أرجع النتائج هكذا لكل منتج (لا تغير التنسيق أبداً):
PRODUCT_1_NAME: [الاسم المحسّن]
PRODUCT_1_DESC: [وصف HTML: <p>وصف</p><h3>المميزات</h3><ul><li>ميزة 1</li><li>ميزة 2</li></ul>]
PRODUCT_2_NAME: [الاسم المحسّن]
PRODUCT_2_DESC: [وصف HTML]
... وهكذا للمنتجات الـ ${batch.length}`;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));

          const msg = await anthropic.messages.create({
            model: AI_MODEL,
            max_tokens: 4000,
            messages: [{ role: 'user', content: prompt }]
          });

          const text = msg.content[0].text;

          batch.forEach((p, i) => {
            const num = i + 1;
            // استخراج الاسم
            const nameMatch = text.match(new RegExp(`PRODUCT_${num}_NAME:\\s*([^\\n]+)`));
            // استخراج الوصف (حتى السطر التالي PRODUCT_X أو نهاية النص)
            const descMatch = text.match(new RegExp(`PRODUCT_${num}_DESC:\\s*([\\s\\S]+?)(?=\\nPRODUCT_${num+1}_NAME:|$)`));

            const nm = nameMatch ? nameMatch[1].trim() : p.name;
            const dc = descMatch ? descMatch[1].trim() : '';

            const row = ws.getRow(p.rowNum);
            if (nm) row.getCell(3).value = nm;
            if (dc) row.getCell(9).value = dc;
            row.commit();

            results[startIdx + i] = {
              status: 'success',
              rowNum: p.rowNum,
              oldName: p.name,
              newName: nm,
              newDesc: dc.replace(/<[^>]*>/g, '').substring(0, 150)
            };
          });

          return; // نجح

        } catch(e) {
          console.error(`Products batch attempt ${attempt+1} failed:`, e.message);
          if (attempt === 2) {
            batch.forEach((p, i) => {
              results[startIdx + i] = { status: 'error', rowNum: p.rowNum, oldName: p.name, error: e.message };
            });
          }
        }
      }
    }

    // تقسيم لـ chunks من 10 منتجات
    const CHUNK_SIZE = 10;
    const chunks = [];
    for (let i = 0; i < products.length; i += CHUNK_SIZE) {
      chunks.push({ batch: products.slice(i, i + CHUNK_SIZE), startIdx: i });
    }

    // تشغيل 5 chunks بنفس الوقت (تجنب rate limit)
    const PARALLEL = 5;
    for (let i = 0; i < chunks.length; i += PARALLEL) {
      const wave = chunks.slice(i, i + PARALLEL);
      await Promise.all(wave.map(c => processBatch(c.batch, c.startIdx)));
      if (i + PARALLEL < chunks.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const enhanced = results.filter(r => r && r.status === 'success').length;
    const failed   = results.filter(r => r && r.status === 'error').length;

    const buffer = await wb.xlsx.writeBuffer();
    console.log(`Excel products DONE: ${enhanced}✅ ${failed}❌ من أصل ${totalProducts}`);

    res.json({
      success: true,
      total: totalProducts,
      enhanced,
      failed,
      results: results.filter(Boolean),
      file: Buffer.from(buffer).toString('base64'),
      filename: 'nmo-products-enhanced.xlsx'
    });

  } catch(e) {
    console.error('excel/products ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// EXCEL SEO — نفس نظام Batch (15 منتج لأن SEO أقصر)
//
// 800 منتج = 54 طلب ÷ 6 متوازي × 3ث = ~27 ثانية  ✅
// ══════════════════════════════════════════════════════════
app.post('/api/excel/seo', rateLimit(3, 60000), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: 'الملف فارغ أو تالف' });

    const h4 = String(ws.getRow(1).getCell(4).value || '');
    if (!h4.includes('SEO')) {
      return res.status(400).json({ error: 'هذا ليس ملف SEO الصحيح — صدّر "تصدير واستيراد بيانات SEO للمنتجات" من سلة' });
    }

    const products = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum < 2) return;
      const id = row.getCell(1).value;
      const name = row.getCell(2).value;
      if (!id || !name) return;
      products.push({ rowNum, id, name: String(name) });
    });

    if (!products.length) return res.status(400).json({ error: 'لا توجد منتجات في الملف' });

    console.log(`Excel SEO: ${products.length} منتج → ${Math.ceil(products.length/15)} طلب`);

    const results = new Array(products.length).fill(null);

    async function processSEOBatch(batch, startIdx) {
      const productsList = batch.map((p, i) => `[${i+1}] ${p.name}`).join('\n');

      const prompt =
`خبير SEO للتجارة الإلكترونية. اكتب بالعربية فقط.

اكتب عنوان SEO ووصف SEO لهذه المنتجات (${batch.length} منتج):

${productsList}

أرجع النتائج هكذا بالضبط (لا تغير التنسيق):
SEO_1_TITLE: [عنوان SEO 50-60 حرف]
SEO_1_DESC: [وصف SEO 140-160 حرف]
SEO_2_TITLE: [عنوان SEO]
SEO_2_DESC: [وصف SEO]
... وهكذا للـ ${batch.length} منتج`;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));

          const msg = await anthropic.messages.create({
            model: AI_MODEL,
            max_tokens: 3000,
            messages: [{ role: 'user', content: prompt }]
          });

          const text = msg.content[0].text;

          batch.forEach((p, i) => {
            const num = i + 1;
            const titleMatch = text.match(new RegExp(`SEO_${num}_TITLE:\\s*([^\\n]+)`));
            const descMatch  = text.match(new RegExp(`SEO_${num}_DESC:\\s*([^\\n]+)`));

            const newTitle = titleMatch ? titleMatch[1].trim() : '';
            const newDesc  = descMatch  ? descMatch[1].trim()  : '';

            const row = ws.getRow(p.rowNum);
            if (newTitle) row.getCell(4).value = newTitle;
            if (newDesc)  row.getCell(5).value = newDesc;
            row.commit();

            results[startIdx + i] = { status: 'success', name: p.name, newTitle, newDesc };
          });

          return;

        } catch(e) {
          console.error(`SEO batch attempt ${attempt+1} failed:`, e.message);
          if (attempt === 2) {
            batch.forEach((p, i) => {
              results[startIdx + i] = { status: 'error', name: p.name, error: e.message };
            });
          }
        }
      }
    }

    // SEO batch أكبر (15) لأن الطلبات أقصر
    const CHUNK_SIZE = 15;
    const chunks = [];
    for (let i = 0; i < products.length; i += CHUNK_SIZE) {
      chunks.push({ batch: products.slice(i, i + CHUNK_SIZE), startIdx: i });
    }

    // 6 chunks متوازية
    const PARALLEL = 6;
    for (let i = 0; i < chunks.length; i += PARALLEL) {
      const wave = chunks.slice(i, i + PARALLEL);
      await Promise.all(wave.map(c => processSEOBatch(c.batch, c.startIdx)));
      if (i + PARALLEL < chunks.length) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    const enhanced = results.filter(r => r && r.status === 'success').length;
    const failed   = results.filter(r => r && r.status === 'error').length;

    const buffer = await wb.xlsx.writeBuffer();
    console.log(`Excel SEO DONE: ${enhanced}✅ ${failed}❌ من أصل ${products.length}`);

    res.json({
      success: true,
      total: products.length,
      enhanced,
      failed,
      results: results.filter(Boolean),
      file: Buffer.from(buffer).toString('base64'),
      filename: 'nmo-seo-enhanced.xlsx'
    });

  } catch(e) {
    console.error('excel/seo ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// LEADS
// ─────────────────────────────────────────
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
      await axios.post(url, { email: cleanEmail, source: source||'excel' }, { headers });
    } catch(dbErr) {
      const code = dbErr.response?.data?.code || '';
      if (code !== '23505' && dbErr.response?.status !== 409) {
        console.error('DB error:', dbErr.response?.data);
      }
    }
    res.json({ success: true, message: 'تم التسجيل بنجاح' });
  } catch(e) {
    res.status(500).json({ error: 'حدث خطأ' });
  }
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
  let html = '', inList = false;
  for (let line of lines) {
    line = line.trim();
    if (!line) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (line.startsWith('- ') || line.startsWith('• ')) {
      if (!inList) { html += '<ul style="padding-right:20px;margin:10px 0;">'; inList = true; }
      html += `<li style="margin-bottom:6px;line-height:1.8;color:#444;">${line.replace(/^[-•]\s*/, '')}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const isHeading = (line.endsWith(':') && line.length < 60) || /^\*\*(.+)\*\*$/.test(line) || (line.length < 55 && !line.endsWith('.') && !line.endsWith('،'));
    if (isHeading) {
      html += `<h3 style="font-size:16px;font-weight:700;color:#222;margin:18px 0 8px;">${line.replace(/\*\*/g,'').replace(/:$/,'')}</h3>`;
    } else {
      html += `<p style="font-size:14px;line-height:1.9;color:#444;margin-bottom:12px;">${line}</p>`;
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
// API ROUTES
// ─────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const token = getToken(req);
    if (!token || token === 'demo') {
      return res.json({ products: [
        { id: 1, name: 'منتج تجريبي', price: { amount: 99 }, description: 'وصف قصير' },
        { id: 2, name: 'منتج آخر', price: { amount: 149 }, description: '' }
      ]});
    }
    const data = await sallaGet('products?per_page=50', token);
    res.json({ products: data.data || [] });
  } catch (e) { res.json({ products: [] }); }
});

app.post('/api/plan', async (req, res) => {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'غير مصرح' });
    const storeInfo = await sallaGet('store/info', token);
    const storeId = storeInfo.data?.id;
    const info = await checkLimit(storeId);
    res.json({ ...info, plans: PLANS });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upgrade-plan', async (req, res) => {
  try {
    const { storeId, plan, adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'غير مصرح' });
    if (!PLANS[plan]) return res.status(400).json({ error: 'خطة غير صحيحة' });
    await dbQuery('PATCH', 'customers', { plan }, `?store_id=eq.${String(storeId)}`);
    res.json({ success: true, plan, limit: PLANS[plan].limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-description', rateLimit(10, 60000), async (req, res) => {
  try {
    const { name, currentDescription, audience, tone, instructions, mode, storeId } = req.body;
    if (storeId) {
      const limit = await checkLimit(storeId);
      if (!limit.allowed) {
        return res.status(429).json({ error: `وصلت للحد الشهري (${limit.used}/${limit.limit} منتج).`, limitReached: true, plan: limit.plan, used: limit.used, limit: limit.limit });
      }
    }
    const toneMap = { professional:'احترافي ورسمي', youth:'شبابي وعصري', luxury:'فاخر وراقي', friendly:'ودي وقريب' };
    const catMap = {
      fashion:     { keywords:['فستان','بلوزة','قميص','بنطلون','جاكيت','عباءة','تيشيرت','ملابس','شنطة','حذاء','حقيبة'], focus:'القياسات، نوع القماش، المناسبة' },
      electronics: { keywords:['جوال','موبايل','لابتوب','تابلت','سماعة','شاشة','كاميرا','ساعة ذكية'], focus:'المواصفات التقنية، الأداء، البطارية، الضمان' },
      perfume:     { keywords:['عطر','بخور','دهن','ورد','عود','مسك','برفيوم'], focus:'العائلة العطرية، النوتات، الثبات، المناسبات' },
      food:        { keywords:['قهوة','شاي','تمر','عسل','زيت','مكسرات','شوكولاتة','حلوى'], focus:'الفوائد الصحية، المكونات الطبيعية، المصدر' },
      home:        { keywords:['أثاث','كنب','طاولة','كرسي','ديكور','سجادة','مطبخ'], focus:'الأبعاد، المواد، سهولة التنظيف' },
      jewelry:     { keywords:['خاتم','سوار','قلادة','أساور','مجوهرات','ذهب','فضة','ألماس'], focus:'نوع المعدن، العيار، المناسبة' },
    };
    let detectedCat = 'general', catFocus = 'الفوائد الرئيسية، المواصفات، المناسبة';
    const nameLower = name.toLowerCase();
    for (const [cat, data] of Object.entries(catMap)) {
      if (data.keywords.some(k => nameLower.includes(k) || (currentDescription||'').includes(k))) {
        detectedCat = cat; catFocus = data.focus; break;
      }
    }
    const message = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 2000,
      messages: [{ role: 'user', content:
`خبير محتوى تجارة إلكترونية. بالعربية فقط. بلا markdown.
المنتج: ${name}
${currentDescription ? `الوصف الحالي:\n${currentDescription}\n` : ''}الأسلوب: ${toneMap[tone]||'احترافي'}
تعليمات الفئة: ${catFocus}

###SEO_TITLE###
[عنوان SEO 50-60 حرف]
###SEO_DESC###
[وصف SEO 140-160 حرف]
###SHORT_DESC###
[وصف قصير جملتان]
###LONG_DESC###
[وصف كامل: فقرة + عنوان فرعي + مميزات بـ - + خاتمة]
###FEATURES###
[5 مميزات كل ميزة تبدأ بـ - ]
###TIKTOK_CAPTION###
[كابشن TikTok + 5 هاشتاقات]
###DETECTED_CATEGORY###
[${detectedCat}]` }]
    });
    const text = message.content[0].text;
    const longDesc = extractSection(text, 'LONG_DESC');
    const features = extractSection(text, 'FEATURES').split('\n').filter(f=>f.trim().startsWith('-')).map(f=>f.replace(/^-\s*/,'').trim());
    if (storeId) await incUsageCount(storeId);
    res.json({
      seoTitle: extractSection(text,'SEO_TITLE'), seoDescription: extractSection(text,'SEO_DESC'),
      shortDescription: extractSection(text,'SHORT_DESC'), description: longDesc,
      descriptionHtml: descriptionToHtml(longDesc), features,
      tiktokCaption: extractSection(text,'TIKTOK_CAPTION'),
      detectedCategory: extractSection(text,'DETECTED_CATEGORY')||detectedCat,
      oldDescription: currentDescription||''
    });
  } catch (e) { console.error('generate-description ERROR:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/improve-description', async (req, res) => {
  try {
    const { name, currentDescription, instructions } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 1500,
      messages: [{ role:'user', content:
`خبير تحسين محتوى. بالعربية بلا markdown.
المنتج: ${name}
الوصف الحالي: ${currentDescription||'لا يوجد'}
###SEO_TITLE###\n[عنوان]\n###SEO_DESC###\n[وصف SEO]\n###LONG_DESC###\n[وصف كامل محسّن]` }]
    });
    const text = msg.content[0].text;
    const longDesc = extractSection(text,'LONG_DESC');
    res.json({ seoTitle:extractSection(text,'SEO_TITLE'), seoDescription:extractSection(text,'SEO_DESC'), description:longDesc, descriptionHtml:descriptionToHtml(longDesc), oldDescription:currentDescription||'' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-seo', async (req, res) => {
  try {
    const { name, description, keywords } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 600,
      messages: [{ role:'user', content:`خبير SEO. بالعربية.\nالمنتج: ${name}\nالوصف: ${description||name}\n###SEO_TITLE###\n[50-60 حرف]\n###SEO_DESC###\n[150-160 حرف]\n###SEO_KEYWORDS###\n[15 كلمة مفصولة بفاصلة]` }]
    });
    const text = msg.content[0].text;
    res.json({ seoTitle:extractSection(text,'SEO_TITLE'), seoDescription:extractSection(text,'SEO_DESC'), seoKeywords:extractSection(text,'SEO_KEYWORDS') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-tags', rateLimit(20, 60000), async (req, res) => {
  try {
    const { name, description } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 200,
      messages: [{ role:'user', content:`10 وسوم للمنتج: ${name}. مفصولة بفاصلة. الوسوم فقط:` }]
    });
    res.json({ tags: msg.content[0].text.split(',').map(t=>t.trim()).filter(t=>t&&t.length<40) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/optimize-title', rateLimit(20, 60000), async (req, res) => {
  try {
    const { name, description, category } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 400,
      messages: [{ role:'user', content:`حسّن عنوان المنتج: ${name}، الفئة: ${category||'عام'}\n###TITLE1###\n[عنوان 1]\n###TITLE2###\n[عنوان 2]\n###TITLE3###\n[عنوان 3]` }]
    });
    const text = msg.content[0].text;
    res.json({ original:name, title1:extractSection(text,'TITLE1'), title2:extractSection(text,'TITLE2'), title3:extractSection(text,'TITLE3') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-social', async (req, res) => {
  try {
    const { name, description } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 800,
      messages: [{ role:'user', content:`محتوى سوشال للمنتج: ${name}\n###INSTAGRAM###\n[كابشن]\n###TIKTOK###\n[سكريبت]\n###TWITTER###\n[تغريدة]\n###HASHTAGS###\n[20 هاشتاق]` }]
    });
    const text = msg.content[0].text;
    res.json({ instagram:extractSection(text,'INSTAGRAM'), tiktok:extractSection(text,'TIKTOK'), twitter:extractSection(text,'TWITTER'), hashtags:extractSection(text,'HASHTAGS') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-blog', async (req, res) => {
  try {
    const { storeName, products, topic } = req.body;
    const msg = await anthropic.messages.create({
      model: AI_MODEL, max_tokens: 2500,
      messages: [{ role:'user', content:`مقالة SEO لمتجر "${storeName}". الموضوع: ${topic}. المنتجات: ${products.map(p=>p.name).join('، ')}\n###BLOG_TITLE###\n[عنوان]\n###BLOG_INTRO###\n[مقدمة]\n###BLOG_BODY###\n[جسم]\n###BLOG_CONCLUSION###\n[خاتمة]\n###BLOG_META###\n[وصف SEO]` }]
    });
    const text = msg.content[0].text;
    res.json({ title:extractSection(text,'BLOG_TITLE'), intro:extractSection(text,'BLOG_INTRO'), body:extractSection(text,'BLOG_BODY'), conclusion:extractSection(text,'BLOG_CONCLUSION'), meta:extractSection(text,'BLOG_META') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-product', rateLimit(30, 60000), async (req, res) => {
  try {
    const { productId, description, descriptionHtml, seoTitle, seoDescription, name, token } = req.body;
    if (!productId || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const updateData = {};
    if (descriptionHtml) updateData.description = descriptionHtml;
    else if (description) updateData.description = descriptionToHtml(description);
    if (seoTitle) updateData.metadata_title = seoTitle;
    if (seoDescription) updateData.metadata_description = seoDescription;
    if (name) updateData.name = name;
    const result = await sallaUpdate(productId, updateData, token);
    res.json({ success: true, product: result.data });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/api/add-tags', rateLimit(5, 60000), async (req, res) => {
  try {
    const { productId, tags, token } = req.body;
    if (!productId || !tags?.length || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const tagIds = [];
    try { const prod = await sallaGet(`products/${productId}`, token); (prod.data?.tags||[]).forEach(t=>{if(t.id)tagIds.push(t.id);}); } catch(e){}
    let allStoreTags = [];
    try { const list = await axios.get('https://api.salla.dev/admin/v2/products/tags',{headers:{Authorization:`Bearer ${token}`}}); allStoreTags=list.data?.data||[]; } catch(e){}
    for (const tagName of tags.slice(0,5)) {
      try {
        const existing = allStoreTags.find(t=>t.name?.toLowerCase().trim()===tagName.toLowerCase().trim());
        if (existing?.id) { if(!tagIds.includes(existing.id))tagIds.push(existing.id); continue; }
        const r = await axios.post(`https://api.salla.dev/admin/v2/products/tags?tag_name=${encodeURIComponent(tagName)}`,{},{headers:{Authorization:`Bearer ${token}`}});
        const newId=r.data?.data?.id;
        if(newId&&!tagIds.includes(newId)){tagIds.push(newId);allStoreTags.push({id:newId,name:tagName});}
      } catch(e){console.warn(`Tag "${tagName}" failed:`,e.message);}
    }
    await new Promise(r=>setTimeout(r,500));
    if(tagIds.length>0) await sallaUpdate(productId,{tags:tagIds},token);
    res.json({success:true,added:tagIds.length,tagIds});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/get-reviews', async (req, res) => {
  try {
    const { productId, token } = req.body;
    if (!productId||!token) return res.status(400).json({error:'بيانات ناقصة'});
    const r = await sallaGet(`products/${productId}/reviews`,token);
    const reviews=(r.data||[]).slice(0,10).map(rv=>({rating:rv.rating,comment:rv.comment||rv.body||'',author:rv.reviewer?.name||'عميل'})).filter(rv=>rv.comment&&rv.comment.length>5);
    res.json({reviews,count:reviews.length});
  } catch(e){res.status(500).json({error:e.message,reviews:[]});}
});

app.post('/api/generate-alt', async (req, res) => {
  try {
    const { productName, count } = req.body;
    const altTexts = [];
    for(let i=1;i<=(count||1);i++){
      const msg=await anthropic.messages.create({model:AI_MODEL,max_tokens:100,messages:[{role:'user',content:`Alt Text للصورة ${i}: ${productName}. 50-100 حرف بالعربية. النص فقط:`}]});
      altTexts.push(msg.content[0].text.trim());
    }
    res.json({altTexts});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/templates', (req, res) => {
  res.json({ templates: [
    { id:'fashion',     name:'👗 ملابس وأزياء',   tone:'youth',        instructions:'ركز على الأناقة والمقاسات' },
    { id:'electronics', name:'📱 إلكترونيات',      tone:'professional', instructions:'ركز على المواصفات والضمان' },
    { id:'perfume',     name:'🌸 عطور',            tone:'luxury',       instructions:'ركز على الرائحة والثبات' },
    { id:'food',        name:'🍃 غذاء وصحة',       tone:'friendly',     instructions:'ركز على الفوائد الصحية' },
    { id:'home',        name:'🏠 منزل وديكور',     tone:'professional', instructions:'ركز على الجودة والأبعاد' },
    { id:'jewelry',     name:'💍 مجوهرات',         tone:'luxury',       instructions:'ركز على المواد والمناسبات' }
  ]});
});

app.post('/api/generate-image', async (req, res) => {
  try {
    const { name, prompt, style } = req.body;
    if(!openai) return res.status(503).json({error:'خدمة الصور غير متاحة'});
    const r = await openai.images.generate({model:'dall-e-3',prompt:`Product photo of ${name}. ${prompt||''}. ${style}. High quality, no text.`,n:1,size:'1024x1024',quality:'standard'});
    res.json({imageUrl:r.data[0].url});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/translate', async (req, res) => {
  try {
    const { text, language } = req.body;
    const msg = await anthropic.messages.create({model:AI_MODEL,max_tokens:500,messages:[{role:'user',content:`ترجم إلى ${language} للتجارة الإلكترونية. الترجمة فقط:\n\n${text}`}]});
    res.json({translation:msg.content[0].text});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/webhook/salla', (req, res) => { res.json({success:true}); });

app.get('/api/debug', async (req, res) => {
  const result = { model:AI_MODEL, anthropic_key_set:!!process.env.ANTHROPIC_API_KEY, time:new Date().toISOString() };
  try {
    const msg = await anthropic.messages.create({model:AI_MODEL,max_tokens:10,messages:[{role:'user',content:'Say: OK'}]});
    result.anthropic_test = 'SUCCESS: '+msg.content[0].text;
  } catch(e) { result.anthropic_test = 'FAILED: '+e.message; }
  res.json(result);
});

// ─────────────────────────────────────────
// CATCH-ALL
// ─────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')||req.path.startsWith('/auth/')||req.path.startsWith('/webhook/')) {
    return res.status(404).json({error:'Not found'});
  }
  res.sendFile(path.join(publicPath, 'landing.html'));
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log('=== SERVER READY === port:'+PORT+' model:'+AI_MODEL);
});

// ─────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin2025';
function checkAdmin(req, res) {
  const pass = req.headers['x-admin-key']||req.query.key;
  if(pass!==ADMIN_PASS){res.status(401).json({error:'غير مصرح'});return false;}
  return true;
}

app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  if(!checkAdmin(req,res))return;
  try { const data=await dbQuery('GET','customers',null,'?order=created_at.desc'); res.json({customers:data,total:data.length}); }
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  if(!checkAdmin(req,res))return;
  try { const data=await dbQuery('PATCH','customers',req.body,`?id=eq.${req.params.id}`); res.json({success:true,customer:data}); }
  catch(e){res.status(500).json({error:e.message});}
});

app.delete('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  if(!checkAdmin(req,res))return;
  try { await dbQuery('DELETE','customers',null,`?id=eq.${req.params.id}`); res.json({success:true}); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  if(!checkAdmin(req,res))return;
  try {
    const customers=await dbQuery('GET','customers',null,'');
    const today=new Date().toISOString().split('T')[0];
    res.json({
      total:customers.length,
      today:customers.filter(c=>c.created_at?.startsWith(today)).length,
      this_month:customers.filter(c=>c.created_at?.startsWith(new Date().toISOString().substring(0,7))).length,
      latest:customers.slice(0,5)
    });
  } catch(e){res.status(500).json({error:e.message});}
});
