const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// Serve static files
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// Serve index.html for root
app.get('/', (req, res) => {
  const indexPath = path.join(publicPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send('<h1>مصمم المنتجات AI</h1><p>جاري التحميل...</p>');
  }
});

// Init AI clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ===== SALLA OAUTH =====
const REDIRECT_URI = 'https://salla-ai-app-indol.vercel.app/auth/callback';

app.get('/auth/salla', (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  const url = `https://accounts.salla.sa/oauth2/auth?client_id=${process.env.SALLA_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=offline_access&state=${state}`;
  res.redirect(url);
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
    const response = await axios.post('https://accounts.salla.sa/oauth2/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const token = response.data.access_token;
    res.redirect(`/?token=${token}`);
  } catch (e) {
    console.error('Auth error:', e.response?.data || e.message);
    res.redirect('/?error=auth_failed');
  }
});

// ===== GET PRODUCTS FROM SALLA =====
app.get('/api/products', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || token === 'demo') {
      return res.json({ products: [
        { id: 1, name: 'منتج تجريبي', price: 99 },
        { id: 2, name: 'منتج آخر', price: 149 }
      ]});
    }
    const response = await axios.get('https://api.salla.dev/admin/v2/products', {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json({ products: response.data.data || [] });
  } catch (e) {
    res.json({ products: [] });
  }
});

// ===== GET SINGLE PRODUCT =====
app.get('/api/product/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const response = await axios.get(`https://api.salla.dev/admin/v2/products/${req.params.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json({ product: response.data.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== IMPROVE EXISTING DESCRIPTION =====
app.post('/api/improve-description', async (req, res) => {
  try {
    const { name, currentDescription, instructions } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `أنت خبير تحسين محتوى للتجارة الإلكترونية. اكتب بالعربية فقط بدون markdown.

المنتج: ${name}
الوصف الحالي: ${currentDescription || 'لا يوجد وصف'}
تعليمات إضافية: ${instructions || 'حسّن الوصف الحالي'}

المطلوب:
SEO_TITLE:
[عنوان محسّن 50-60 حرف]

SEO_DESC:
[وصف SEO محسّن 150 حرف]

DESCRIPTION:
[وصف محسّن مقنع يحافظ على روح الوصف الأصلي مع تحسينه — فقرتين + نقاط مميزات + خاتمة]`
      }]
    });
    const fullText = message.content[0].text;
    const seoTitleMatch = fullText.match(/SEO_TITLE:\n([^\n]+)/);
    const seoDescMatch = fullText.match(/SEO_DESC:\n([^\n]+)/);
    const descMatch = fullText.match(/DESCRIPTION:\n([\s\S]+)/);
    res.json({
      description: descMatch ? descMatch[1].trim() : fullText,
      seoTitle: seoTitleMatch ? seoTitleMatch[1].trim() : '',
      seoDescription: seoDescMatch ? seoDescMatch[1].trim() : ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE SEO ONLY =====
app.post('/api/generate-seo', async (req, res) => {
  try {
    const { name, description, keywords } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `أنت خبير SEO للتجارة الإلكترونية السعودية. اكتب بالعربية فقط بدون markdown.

المنتج: ${name}
الوصف: ${description || name}
كلمات مفتاحية مقترحة: ${keywords || ''}

اكتب:
SEO_TITLE:
[عنوان SEO جذاب 50-60 حرف يحتوي الكلمة المفتاحية]

SEO_DESC:
[وصف SEO دقيق 150-160 حرف يحفز النقر]

SEO_KEYWORDS:
[15 كلمة مفتاحية مفصولة بفاصلة — قصيرة ومتنوعة]`
      }]
    });
    const fullText = message.content[0].text;
    const titleMatch = fullText.match(/SEO_TITLE:\n([^\n]+)/);
    const descMatch = fullText.match(/SEO_DESC:\n([^\n]+)/);
    const kwMatch = fullText.match(/SEO_KEYWORDS:\n([^\n]+)/);
    res.json({
      seoTitle: titleMatch ? titleMatch[1].trim() : '',
      seoDescription: descMatch ? descMatch[1].trim() : '',
      seoKeywords: kwMatch ? kwMatch[1].trim() : ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/generate-image', async (req, res) => {
  try {
    const { name, prompt, style } = req.body;
    const fullPrompt = `Professional product photo of ${name}. ${prompt}. ${style}. High quality, commercial photography, sharp details, no text.`;

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: fullPrompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard'
    });

    const imageUrl = response.data[0].url;
    res.json({ imageUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ===== GENERATE DESCRIPTION =====
app.post('/api/generate-description', async (req, res) => {
  try {
    const { name, features, audience, price } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `أنت كاتب محتوى للتجارة الإلكترونية. اكتب بالعربية فقط بدون markdown.

المنتج: ${name}
الميزات: ${features || name}
الفئة: ${audience || 'الجميع'}
السعر: ${price} ريال

اكتب بهذا الترتيب بالضبط:

SEO_TITLE:
[عنوان جذاب 50-60 حرف]

SEO_DESC:
[وصف محركات البحث 150 حرف بالضبط]

DESCRIPTION:
[فقرة افتتاحية مقنعة - 3 أسطر]

[فقرة تصف تجربة الاستخدام - 3 أسطر]

المميزات:
- [ميزة 1 مع فائدتها]
- [ميزة 2 مع فائدتها]
- [ميزة 3 مع فائدتها]
- [ميزة 4 مع فائدتها]
- [ميزة 5 مع فائدتها]

[خاتمة تحفز الشراء بسعر ${price} ريال - سطرين]`
      }]
    });

    const fullText = message.content[0].text;
    const seoTitleMatch = fullText.match(/SEO_TITLE:\n([^\n]+)/);
    const seoTitle = seoTitleMatch ? seoTitleMatch[1].trim() : '';
    const seoDescMatch = fullText.match(/SEO_DESC:\n([^\n]+)/);
    const seoDescription = seoDescMatch ? seoDescMatch[1].trim() : '';
    const descMatch = fullText.match(/DESCRIPTION:\n([\s\S]+)/);
    const description = descMatch ? descMatch[1].trim() : fullText;

    res.json({ description, seoTitle, seoDescription });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== EDIT IMAGE =====
app.post('/api/edit-image', upload.single('image'), async (req, res) => {
  try {
    const { prompt } = req.body;
    const imageBuffer = req.file.buffer;
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: `أنت خبير تحرير صور. المستخدم يريد: "${prompt}". صف بالتفصيل كيف تبدو الصورة بعد التعديل، ثم أنشئ prompt احترافي بالإنجليزي لـ DALL-E لإنشاء صورة مشابهة مع التعديل المطلوب.` }
        ]
      }]
    });

    const editPrompt = message.content[0].text;
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: editPrompt.slice(0, 1000),
      n: 1,
      size: '1024x1024',
      quality: 'standard'
    });

    res.json({ imageUrl: response.data[0].url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== TRANSLATE =====
app.post('/api/translate', async (req, res) => {
  try {
    const { text, language } = req.body;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `ترجم النص التالي إلى ${language} بشكل احترافي مناسب للتجارة الإلكترونية. أعطني الترجمة فقط بدون شرح:\n\n${text}`
      }]
    });
    res.json({ translation: message.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== UPDATE PRODUCT IN SALLA =====
app.post('/api/update-product', async (req, res) => {
  try {
    const { productId, description, seoTitle, seoDescription, token } = req.body;
    if (!productId || !token) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }

    const updateData = {};

    // Add description if provided
    if (description) {
      const htmlDescription = description
        .split('\n\n')
        .filter(p => p.trim())
        .map(p => {
          const trimmed = p.trim();
          if (trimmed.startsWith('- ') || trimmed.includes('\n- ')) {
            const items = trimmed.split('\n').filter(l => l.trim().startsWith('- '));
            return `<ul>${items.map(i => `<li>${i.replace(/^-\s*/,'')}</li>`).join('')}</ul>`;
          }
          return `<p>${trimmed}</p>`;
        }).join('\n');
      updateData.description = htmlDescription;
    }

    // Add SEO fields using correct Salla API field names
    if (seoTitle || seoDescription) {
      updateData.metadata_title = seoTitle || '';
      updateData.metadata_description = seoDescription || '';
    }

    const response = await axios.put(
      `https://api.salla.dev/admin/v2/products/${productId}`,
      updateData,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, product: response.data.data });
  } catch (e) {
    console.error('Update product error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});


app.post('/webhook/salla', express.json(), (req, res) => {
  console.log('Salla webhook:', req.body);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
