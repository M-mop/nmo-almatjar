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

// ─── SECURITY: CORS ───────────────────────
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '5mb' }));

const publicPath = path.join(__dirname, '../public');

// ════════════════════════════════════════════
// ✅ FIX: ROUTES قبل static — الترتيب مهم جداً
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
app.get('/about', (req, res) => {
  res.sendFile(path.join(publicPath, 'about.html'));
});
app.get('/about.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'about.html'));
});
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(publicPath, 'privacy.html'));
});
app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'privacy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(publicPath, 'terms.html'));
});
app.get('/terms.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'terms.html'));
});
app.get('/landing', (req, res) => {
  res.sendFile(path.join(publicPath, 'landing.html'));
});
app.get('/landing.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'landing.html'));
});

// ════════════════════════════════════════════
// ✅ STATIC — index:false يمنع index.html من الظهور تلقائياً
// ════════════════════════════════════════════
app.use(express.static(publicPath, { index: false }));

const openai  = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REDIRECT_URI = process.env.APP_URL ? process.env.APP_URL + '/auth/callback' : 'https://nmo-almatjar-production.up.railway.app/auth/callback';

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

const AI_MODEL = 'claude-haiku-4-5-20251001';

const PLANS = {
  free:       { limit: 2,      name: 'مجاني',      price: 0,   trialDays: 0  },
  pro:        { limit: 200,    name: 'Pro',         price: 99,  trialDays: 0  },
  enterprise: { limit: 99999,  name: 'Enterprise',  price: 299, trialDays: 0  }
};

function genReferralCode(storeId) {
  return 'REF' + Buffer.from(String(storeId)).toString('base64').slice(0,6).toUpperCase();
}

async function checkLimit(storeId) {
  try {
    const res = await dbQuery(
      `SELECT plan, products_count FROM customers WHERE store_id = $1`,
      [String(storeId)]
    );
    if (!res.rows.length) return { allowed: true, plan: 'free', used: 0, limit: 2 };
    const { plan, products_count } = res.rows[0];
    const limit = PLANS[plan]?.limit || 2;
    return { allowed: products_count < limit, plan, used: products_count, limit };
  } catch(e) {
    return { allowed: true, plan: 'free', used: 0, limit: 2 };
  }
}

async function incUsageCount(storeId) {
  try {
    await dbQuery(
      `UPDATE customers SET products_count = products_count + 1 WHERE store_id = $1`,
      [String(storeId)]
    );
  } catch(e) { console.warn('incUsage error:', e.message); }
}

app.post('/api/plan', async (req, res) => {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'غير مصرح' });
    const storeInfo = await sallaGet('store/info', token);
    const storeId = storeInfo.data?.id;
    const info = await checkLimit(storeId);
    res.json({ ...info, plans: PLANS });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/referral/apply', async (req, res) => {
  try {
    const { referralCode, token } = req.body;
    if (!referralCode || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const storeInfo = await sallaGet('store/info', token);
    const storeId = String(storeInfo.data?.id || '');
    const all = await dbQuery('SELECT store_id FROM customers', []);
    const referrer = all.rows.find(r => genReferralCode(r.store_id) === referralCode.toUpperCase());
    if (!referrer) return res.status(404).json({ error: 'كود الإحالة غير صحيح' });
    if (referrer.store_id === storeId) return res.status(400).json({ error: 'لا يمكن استخدام كودك الخاص' });
    const trialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await dbQuery('UPDATE customers SET plan=$1, trial_end=$2, products_count=0 WHERE store_id=$3', ['trial', trialEnd, storeId]);
    await dbQuery('UPDATE customers SET products_count = GREATEST(0, products_count - 50) WHERE store_id=$1', [referrer.store_id]);
    res.json({ success: true, message: 'تم تطبيق كود الإحالة — استمتع بشهر مجاني!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upgrade-plan', async (req, res) => {
  try {
    const { storeId, plan, adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'غير مصرح' });
    if (!PLANS[plan]) return res.status(400).json({ error: 'خطة غير صحيحة' });
    await dbQuery(
      `UPDATE customers SET plan = $1 WHERE store_id = $2`,
      [plan, String(storeId)]
    );
    res.json({ success: true, plan, limit: PLANS[plan].limit });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/excel/products', rateLimit(5, 60000), upload.single('file'), async (req, res) => {
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
      const rawDesc = String(row.getCell(9).value || '').replace(/<[^>]*>/g, '').substring(0, 400);
      products.push({ rowNum, id, name: String(name), cleanDesc: rawDesc });
    });

    if (!products.length) return res.status(400).json({ error: 'لا توجد منتجات في الملف' });

    const BATCH_SIZE = 10;
    const results = new Array(products.length).fill(null);

    const catFocusMap = [
      { kw:['فستان','بلوزة','قميص','بنطلون','جاكيت','ملابس','عباءة'], focus:'القماش والمقاسات والمناسبة المثالية للارتداء' },
      { kw:['عطر','بخور','دهن','زيت عطري','عود','مسك'],              focus:'العائلة العطرية والنوتات والثبات والمناسبات' },
      { kw:['جوال','لابتوب','سماعة','شاشة','كاميرا'],                focus:'المواصفات التقنية والأداء والضمان' },
      { kw:['قهوة','شاي','تمر','عسل','زيت','مكسرات'],               focus:'الفوائد الصحية والمكونات الطبيعية' },
    ];

    async function processProduct(p, idx) {
      let catFocus = 'المميزات الرئيسية وقيمة المنتج للعميل';
      for (const cat of catFocusMap) {
        if (cat.kw.some(k => p.name.includes(k) || p.cleanDesc.includes(k))) { catFocus = cat.focus; break; }
      }
      for(let attempt = 0; attempt < 3; attempt++) {
        try {
          if(attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
          const msg = await anthropic.messages.create({
            model: AI_MODEL, max_tokens: 800,
            messages: [{ role:'user', content:
`كاتب محتوى. اكتب بالعربية فقط. لا تستخدم ** أو markdown.
المنتج: ${p.name}
الوصف الحالي: ${p.cleanDesc || 'لا يوجد'}
الأسلوب: ${toneMap[tone]}
تعليمات: ${catFocus}
###NAME###
[اسم محسّن + كلمات مفتاحية]
###DESC###
[وصف HTML: فقرة + <h3>مميزات</h3> + <ul><li> + خاتمة]` }]
          });
          const text = msg.content[0].text;
          const ni = text.indexOf('###NAME###');
          const di = text.indexOf('###DESC###');
          const nm = (ni>=0&&di>=0) ? text.substring(ni+10,di).trim().split('\n')[0].trim() : p.name;
          const dc = (di>=0) ? text.substring(di+10).trim() : '';
          const row = ws.getRow(p.rowNum);
          if(nm) row.getCell(3).value = nm;
          if(dc) row.getCell(9).value = dc;
          row.commit();
          results[idx] = { status:'success', rowNum:p.rowNum, oldName:p.name, newName:nm, newDesc:dc.replace(/<[^>]*>/g,'').substring(0,150) };
          return;
        } catch(e) {
          if(attempt===2) results[idx] = { status:'error', rowNum:p.rowNum, oldName:p.name, error:e.message };
        }
      }
    }

    for(let i=0; i<products.length; i+=BATCH_SIZE) {
      const batch = products.slice(i, i+BATCH_SIZE);
      await Promise.all(batch.map((p,j) => processProduct(p, i+j)));
    }

    const buffer = await wb.xlsx.writeBuffer();
    res.json({
      success:true, total:products.length,
      enhanced:results.filter(r=>r.status==='success').length,
      failed:results.filter(r=>r.status==='error').length,
      results, file:Buffer.from(buffer).toString('base64'),
      filename:'nmo-products-enhanced.xlsx'
    });
  } catch(e) {
    console.error('excel/products:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/excel/seo', rateLimit(5, 60000), upload.single('file'), async (req, res) => {
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

    const BATCH_SEO = 10;
    const results = new Array(products.length).fill(null);

    async function processSeo(p, idx) {
      for(let attempt=0; attempt<3; attempt++) {
        try {
          if(attempt>0) await new Promise(r=>setTimeout(r, 1500*attempt));
          const msg = await anthropic.messages.create({
            model: AI_MODEL, max_tokens: 300,
            messages: [{ role:'user', content:
`خبير SEO. اكتب بالعربية فقط.
المنتج: ${p.name}
###TITLE###
[عنوان SEO: 50-60 حرف]
###DESC###
[وصف SEO: 140-160 حرف]` }]
          });
          const text = msg.content[0].text;
          const ti = text.indexOf('###TITLE###');
          const di = text.indexOf('###DESC###');
          const newTitle = (ti>=0&&di>=0) ? text.substring(ti+11,di).trim().split('\n')[0].trim() : '';
          const newDesc  = (di>=0) ? text.substring(di+10).trim().split('\n')[0].trim() : '';
          const row = ws.getRow(p.rowNum);
          if(newTitle) row.getCell(4).value = newTitle;
          if(newDesc)  row.getCell(5).value = newDesc;
          row.commit();
          results[idx] = { status:'success', name:p.name, newTitle, newDesc };
          return;
        } catch(e) {
          if(attempt===2) results[idx] = { status:'error', name:p.name, error:e.message };
        }
      }
    }

    for(let i=0; i<products.length; i+=BATCH_SEO) {
      const batch = products.slice(i, i+BATCH_SEO);
      await Promise.all(batch.map((p,j) => processSeo(p, i+j)));
    }
    const buffer = await wb.xlsx.writeBuffer();
    res.json({
      success:true, total:products.length,
      enhanced:results.filter(r=>r.status==='success').length,
      failed:results.filter(r=>r.status==='error').length,
      results, file:Buffer.from(buffer).toString('base64'),
      filename:'nmo-seo-enhanced.xlsx'
    });
  } catch(e) {
    console.error('excel/seo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const { email, source } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'بريد إلكتروني غير صحيح' });
    const cleanEmail = email.toLowerCase().trim();
    console.log('Saving lead:', cleanEmail);
    const url = SUPABASE_URL + '/rest/v1/leads';
    const headers = {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates'
    };
    try {
      const saveRes = await axios.post(url, { email: cleanEmail, source: source||'excel' }, { headers });
      console.log('Lead saved OK:', cleanEmail, saveRes.status);
    } catch(dbErr) {
      const code = dbErr.response?.data?.code || '';
      if (code === '23505' || dbErr.response?.status === 409) {
        console.log('Lead already exists:', cleanEmail);
      } else {
        console.error('DB error:', dbErr.response?.data);
      }
    }
    res.json({ success: true, message: 'تم التسجيل بنجاح' });
  } catch(e) {
    console.error('leads error:', e.message);
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

app.get('/api/admin/leads', requireAdmin, async (req, res) => {
  try {
    const url = SUPABASE_URL + '/rest/v1/leads?order=created_at.desc';
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };
    const r = await axios.get(url, { headers });
    const data = r.data;
    res.json({ leads: data || [], total: (data||[]).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
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
    if (!line) {
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('• ')) {
      if (!inList) {
        html += '<ul style="padding-right:20px;margin:10px 0;">';
        inList = true;
      }
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
      if (p.tags?.length > 0) score += 15;    else issues.push('لا توجد وسوم');
      if (p.images?.length > 0) score += 15;  else issues.push('لا توجد صور');
      if (p.metadata_title) score += 10;      else issues.push('عنوان SEO غير موجود');
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
    console.log('=== generate-description RAW (first 600) ===\n', text.substring(0, 600));

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
      seoTitle:    extractSection(text, 'SEO_TITLE'),
      seoDescription: extractSection(text, 'SEO_DESC'),
      seoKeywords: extractSection(text, 'SEO_KEYWORDS')
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

app.post('/api/update-product', rateLimit(30, 60000), async (req, res) => {
  try {
    const { productId, description, descriptionHtml, seoTitle, seoDescription, name, token } = req.body;
    if (!productId || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const updateData = {};
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

app.post('/api/add-tags', rateLimit(5, 60000), async (req, res) => {
  try {
    const { productId, tags, token } = req.body;
    if (!productId || !tags?.length || !token) return res.status(400).json({ error: 'بيانات ناقصة' });
    const tagIds = [];
    try {
      const prod = await sallaGet(`products/${productId}`, token);
      (prod.data?.tags || []).forEach(t => { if (t.id) tagIds.push(t.id); });
    } catch(e) {}
    let allStoreTags = [];
    try {
      const list = await axios.get('https://api.salla.dev/admin/v2/products/tags', {
        headers: { Authorization: `Bearer ${token}` }
      });
      allStoreTags = list.data?.data || [];
    } catch(e) {}
    for (const tagName of tags.slice(0, 5)) {
      try {
        const existing = allStoreTags.find(t =>
          t.name?.toLowerCase().trim() === tagName.toLowerCase().trim()
        );
        if (existing?.id) {
          if (!tagIds.includes(existing.id)) tagIds.push(existing.id);
          continue;
        }
        const r = await axios.post(
          `https://api.salla.dev/admin/v2/products/tags?tag_name=${encodeURIComponent(tagName)}`,
          {}, { headers: { Authorization: `Bearer ${token}` } }
        );
        const newId = r.data?.data?.id;
        if (newId && !tagIds.includes(newId)) {
          tagIds.push(newId);
          allStoreTags.push({ id: newId, name: tagName });
        }
      } catch(e) {
        console.warn(`Tag "${tagName}" failed:`, e.message);
      }
    }
    await new Promise(r => setTimeout(r, 500));
    if (tagIds.length > 0) await sallaUpdate(productId, { tags: tagIds }, token);
    res.json({ success: true, added: tagIds.length, tagIds });
  } catch (e) {
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

app.post('/api/generate-image', async (req, res) => {
  try {
    const { name, prompt, style } = req.body;
    if(!openai) return res.status(503).json({ error: 'خدمة توليد الصور غير متاحة حالياً' });
    const r = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `Professional product photo of ${name}. ${prompt || ''}. ${style}. High quality, commercial photography, no text.`,
      n: 1, size: '1024x1024', quality: 'standard'
    });
    res.json({ imageUrl: r.data[0].url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.post('/webhook/salla', (req, res) => {
  console.log('Webhook:', req.body?.event);
  res.json({ success: true });
});

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
  result.supabase_service_key_set = !!process.env.SUPABASE_SERVICE_KEY;
  result.supabase_key_prefix = SUPABASE_SERVICE_KEY.substring(0,20)+'...';
  try {
    const tUrl = SUPABASE_URL + '/rest/v1/leads';
    const tH = {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates'
    };
    const tr = await axios.post(tUrl, {email:'debug@test.com', source:'debug'}, {headers:tH});
    result.supabase_leads_test = 'SUCCESS: ' + tr.status;
  } catch(se) {
    result.supabase_leads_test = 'FAILED: ' + (se.response?.data?.message || se.response?.data?.code || se.message);
    result.supabase_error_detail = JSON.stringify(se.response?.data);
  }
  res.json(result);
});

// ════════════════════════════════════════════
// ✅ FIX: CATCH-ALL — أي رابط ما عنده route يرجع landing
// يجب أن يكون في آخر شيء قبل app.listen
// ════════════════════════════════════════════
app.get('*', (req, res) => {
  // إذا الطلب لـ API أو auth أرجع 404
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/webhook/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // أي صفحة ثانية غير معروفة ترجع landing
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
