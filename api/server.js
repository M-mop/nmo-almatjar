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
app.use(express.static('public'));

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

// ===== GENERATE IMAGE =====
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
    if (!productId || !description || !token) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }

    // Convert plain text to HTML
    const htmlDescription = description
      .split('\n\n')
      .filter(p => p.trim())
      .map(p => {
        const trimmed = p.trim();
        if (trimmed.includes(':') && trimmed.length < 60) {
          return `<h3>${trimmed}</h3>`;
        }
        if (trimmed.startsWith('- ')) {
          const items = trimmed.split('\n').filter(l => l.startsWith('- '));
          return `<ul>${items.map(i => `<li>${i.replace('- ','')}</li>`).join('')}</ul>`;
        }
        return `<p>${trimmed}</p>`;
      }).join('\n');

    const updateData = {
      description: htmlDescription,
      metadata: {
        title: seoTitle || '',
        description: seoDescription || ''
      }
    };

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
