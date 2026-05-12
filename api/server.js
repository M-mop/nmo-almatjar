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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const REDIRECT_URI = 'https://salla-ai-app-indol.vercel.app/auth/callback';

// ===== HELPERS =====
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

function textToHtml(text) {
  return text.split('\n\n').filter(p => p.trim()).map(p => {
    const t = p.trim();
    if (t.startsWith('- ') || t.includes('\n- ')) {
      const items = t.split('\n').filter(l => l.trim().startsWith('- '));
      return `<ul>${items.map(i => `<li>${i.replace(/^-\s*/, '')}</li>`).join('')}</ul>`;
    }
    return `<p>${t}</p>`;
  }).join('\n');
}

// ===== AUTH =====
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
    res.redirect(`/?token=${r.data.access_token}`);
  } catch (e) {
    console.error('Auth error:', e.response?.data || e.message);
    res.redirect('/?error=auth_failed');
  }
});

// ===== PRODUCTS =====
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
  } catch (e) {
    res.json({ products: [] });
  }
});

// ===== SEO SCORE =====
app.post('/api/seo-score', async (req, res) => {
  try {
    const { products } = req.body;
    const scored = products.map(p => {
      let score = 0;
      const issues = [];
      const desc = p.description || '';
      const name = p.name || '';

      if (desc.length > 100) score += 25; else issues.push('الوصف قصير جداً أو غير موجود');
      if (desc.length > 300) score += 15;
      if (name.length > 20) score += 20; else issues.push('العنوان قصير — أضف تفاصيل');
      if (p.tags?.length > 0) score += 15; else issues.push('لا توجد وسوم (Tags)');
      if (p.images?.length > 0) score += 15; else issues.push('لا توجد صور');
      if (p.metadata_title) score += 10; else issues.push('عنوان SEO غير موجود');

      let grade = 'F';
      if (score >= 90) grade = 'A+';
      else if (score >= 80) grade = 'A';
      else if (score >= 70) grade = 'B';
      else if (score >= 60) grade = 'C';
      else if (score >= 40) grade = 'D';

      return { id: p.id, name: p.name, score, grade, issues };
    });
    res.json({ results: scored });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE DESCRIPTION (FULL FEATURED) =====
app.post('/api/generate-description', async (req, res) => {
  try {
    const { name, currentDescription, audience, tone, instructions, mode, platform } = req.body;

    const toneMap = {
      professional: 'احترافي ورسمي',
      youth: 'شبابي وعصري',
      luxury: 'فاخر وراقي',
      friendly: 'ودي وقريب'
    };

    const platformMap = {
      salla: 'متجر سلة',
      google: 'Google Shopping',
      tiktok: 'TikTok Shop',
      all: 'جميع المنصات'
    };

    const currentDesc = currentDescription ? `الوصف الحالي:\n${currentDescription}\n\n` : '';
    const modeInst = mode === 'improve' ? 'حسّن الوصف الحالي' : mode === 'renew' ? 'اكتب وصفاً جديداً كلياً' : 'اكتب وصفاً احترافياً';

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `أنت كاتب محتوى للتجارة الإلكترونية. اكتب بالعربية بدون markdown.

المنتج: ${name}
${currentDesc}الفئة المستهدفة: ${audience || 'العملاء السعوديين'}
الأسلوب: ${toneMap[tone] || 'احترافي'}
المنصة: ${platformMap[platform] || 'متجر سلة'}
التعليمات: ${instructions || modeInst}

اكتب بهذا الترتيب بالضبط:

SEO_TITLE:
[عنوان منتج قوي ومحسّن لمحركات البحث — 50-60 حرف — يتضمن الكلمة الرئيسية وميزة مهمة]

SEO_DESC:
[وصف محركات البحث — 150-160 حرف — يحفز النقر]

SHORT_DESC:
[وصف قصير للمنتج — جملتين فقط — مناسب لبطاقة المنتج]

LONG_DESC:
[وصف طويل مقنع — 3 فقرات — يصف تجربة الاستخدام ويحفز الشراء]

FEATURES:
- [ميزة 1 مع فائدتها]
- [ميزة 2 مع فائدتها]
- [ميزة 3 مع فائدتها]
- [ميزة 4 مع فائدتها]
- [ميزة 5 مع فائدتها]

TIKTOK_CAPTION:
[كابشن TikTok جذاب — جملة أو جملتين + هاشتاقات]

GOOGLE_TITLE:
[عنوان Google Shopping — 70 حرف كحد أقصى]`
      }]
    });

    const text = message.content[0].text;
    const extract = (key) => {
      const m = text.match(new RegExp(`${key}:\\n([\\s\\S]+?)(?=\\n[A-Z_]+:|$)`));
      return m ? m[1].trim() : '';
    };

    const features = extract('FEATURES').split('\n').filter(f => f.trim().startsWith('-')).map(f => f.replace(/^-\s*/, '').trim());

    res.json({
      seoTitle: extract('SEO_TITLE'),
      seoDescription: extract('SEO_DESC'),
      shortDescription: extract('SHORT_DESC'),
      description: extract('LONG_DESC'),
      features,
      tiktokCaption: extract('TIKTOK_CAPTION'),
      googleTitle: extract('GOOGLE_TITLE'),
      oldDescription: currentDescription || ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== IMPROVE DESCRIPTION =====
app.post('/api/improve-description', async (req, res) => {
  try {
    const { name, currentDescription, instructions } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `أنت خبير تحسين محتوى للتجارة الإلكترونية. اكتب بالعربية بدون markdown.

المنتج: ${name}
الوصف الحالي: ${currentDescription || 'لا يوجد'}
تعليمات: ${instructions || 'حسّن الوصف وارفع جودته'}

SEO_TITLE:
[عنوان محسّن]

SEO_DESC:
[وصف SEO محسّن 150 حرف]

DESCRIPTION:
[الوصف المحسّن — فقرتان + نقاط مميزات + خاتمة]`
      }]
    });

    const text = message.content[0].text;
    const extract = (key) => {
      const m = text.match(new RegExp(`${key}:\\n([\\s\\S]+?)(?=\\n[A-Z_]+:|$)`));
      return m ? m[1].trim() : '';
    };

    res.json({
      seoTitle: extract('SEO_TITLE'),
      seoDescription: extract('SEO_DESC'),
      description: extract('DESCRIPTION'),
      oldDescription: currentDescription || ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE SEO =====
app.post('/api/generate-seo', async (req, res) => {
  try {
    const { name, description, keywords } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `خبير SEO للتجارة الإلكترونية. بالعربية فقط بدون markdown.

المنتج: ${name}
الوصف: ${description || name}
كلمات إضافية: ${keywords || ''}

SEO_TITLE:
[عنوان SEO 50-60 حرف]

SEO_DESC:
[وصف SEO 150-160 حرف يحفز النقر]

SEO_KEYWORDS:
[15 كلمة مفتاحية بالعربية مفصولة بفاصلة]`
      }]
    });

    const text = message.content[0].text;
    const extract = (key) => {
      const m = text.match(new RegExp(`${key}:\\n([^\\n]+)`));
      return m ? m[1].trim() : '';
    };

    res.json({
      seoTitle: extract('SEO_TITLE'),
      seoDescription: extract('SEO_DESC'),
      seoKeywords: extract('SEO_KEYWORDS')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE TAGS =====
app.post('/api/generate-tags', async (req, res) => {
  try {
    const { name, description } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `وسوم (tags) للمنتج: ${name}. الوصف: ${description || ''}.
أعطني 10 وسوم قصيرة (1-3 كلمات) مفصولة بفاصلة. عربية وإنجليزية. فقط الوسوم بدون شرح:`
      }]
    });

    const tags = message.content[0].text.split(',').map(t => t.trim()).filter(t => t && t.length < 40);
    res.json({ tags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE SOCIAL CONTENT =====
app.post('/api/generate-social', async (req, res) => {
  try {
    const { name, description, platform } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `اكتب محتوى سوشال ميديا لمنتج: ${name}
الوصف: ${description || ''}
المنصة: ${platform || 'عام'}

INSTAGRAM:
[كابشن انستغرام جذاب + هاشتاقات]

TIKTOK:
[سكريبت TikTok قصير 15-30 ثانية]

TWITTER:
[تغريدة مقنعة 280 حرف]

HASHTAGS:
[20 هاشتاق مناسب]`
      }]
    });

    const text = message.content[0].text;
    const extract = (key) => {
      const m = text.match(new RegExp(`${key}:\\n([\\s\\S]+?)(?=\\n[A-Z]+:|$)`));
      return m ? m[1].trim() : '';
    };

    res.json({
      instagram: extract('INSTAGRAM'),
      tiktok: extract('TIKTOK'),
      twitter: extract('TWITTER'),
      hashtags: extract('HASHTAGS')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE BLOG POST =====
app.post('/api/generate-blog', async (req, res) => {
  try {
    const { storeName, products, topic } = req.body;
    const productNames = products.map(p => p.name).join('، ');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `اكتب مقالة SEO احترافية بالعربية لمتجر "${storeName}".
الموضوع: ${topic}
المنتجات المرتبطة: ${productNames}

BLOG_TITLE:
[عنوان المقالة — جذاب ومحسّن لـ SEO]

BLOG_INTRO:
[مقدمة قوية — 2 فقرة]

BLOG_BODY:
[جسم المقالة — 4-5 فقرات تتضمن معلومات مفيدة وربط طبيعي بالمنتجات]

BLOG_CONCLUSION:
[خاتمة تحفز على الشراء]

BLOG_META:
[وصف SEO للمقالة — 150 حرف]`
      }]
    });

    const text = message.content[0].text;
    const extract = (key) => {
      const m = text.match(new RegExp(`${key}:\\n([\\s\\S]+?)(?=\\n[A-Z_]+:|$)`));
      return m ? m[1].trim() : '';
    };

    res.json({
      title: extract('BLOG_TITLE'),
      intro: extract('BLOG_INTRO'),
      body: extract('BLOG_BODY'),
      conclusion: extract('BLOG_CONCLUSION'),
      meta: extract('BLOG_META')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== UPDATE PRODUCT =====
app.post('/api/update-product', async (req, res) => {
  try {
    const { productId, description, seoTitle, seoDescription, name, token } = req.body;
    if (!productId || !token) return res.status(400).json({ error: 'بيانات ناقصة' });

    const updateData = {};
    if (description) updateData.description = textToHtml(description);
    if (seoTitle) updateData.metadata_title = seoTitle;
    if (seoDescription) updateData.metadata_description = seoDescription;
    if (name) updateData.name = name;

    const result = await sallaUpdate(productId, updateData, token);
    res.json({ success: true, product: result.data });
  } catch (e) {
    console.error('Update error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ===== ADD TAGS =====
app.post('/api/add-tags', async (req, res) => {
  try {
    const { productId, tags, token } = req.body;
    const created = [];
    for (const tag of tags) {
      try {
        const r = await axios.post('https://api.salla.dev/admin/v2/products/tags',
          { name: tag },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        if (r.data?.data?.id) created.push(r.data.data.id);
      } catch (e) {}
    }
    if (created.length) {
      await sallaUpdate(productId, { tags: created }, token);
    }
    res.json({ success: true, added: created.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE IMAGE =====
app.post('/api/generate-image', async (req, res) => {
  try {
    const { name, prompt, style } = req.body;
    const fullPrompt = `Professional product photo of ${name}. ${prompt || ''}. ${style}. High quality, commercial photography, sharp details, no text.`;
    const r = await openai.images.generate({ model: 'dall-e-3', prompt: fullPrompt, n: 1, size: '1024x1024', quality: 'standard' });
    res.json({ imageUrl: r.data[0].url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== EDIT IMAGE =====
app.post('/api/edit-image', upload.single('image'), async (req, res) => {
  try {
    const { prompt } = req.body;
    const base64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
          { type: 'text', text: `خبير تحرير صور. المطلوب: "${prompt}". أنشئ prompt إنجليزي احترافي لـ DALL-E لإنشاء صورة مشابهة مع التعديل. أعطني الـ prompt فقط.` }
        ]
      }]
    });

    const editPrompt = msg.content[0].text.slice(0, 900);
    const r = await openai.images.generate({ model: 'dall-e-3', prompt: editPrompt, n: 1, size: '1024x1024', quality: 'standard' });
    res.json({ imageUrl: r.data[0].url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== TRANSLATE =====
app.post('/api/translate', async (req, res) => {
  try {
    const { text, language } = req.body;
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `ترجم هذا النص إلى ${language} بشكل احترافي مناسب للتجارة الإلكترونية. الترجمة فقط بدون شرح:\n\n${text}`
      }]
    });
    res.json({ translation: msg.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== WEBHOOK =====
app.post('/webhook/salla', (req, res) => {
  console.log('Webhook:', req.body?.event);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
