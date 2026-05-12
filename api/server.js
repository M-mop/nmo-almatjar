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
app.get('/auth/salla', (req, res) => {
  const url = `https://accounts.salla.sa/oauth2/auth?client_id=${process.env.SALLA_CLIENT_ID}&redirect_uri=${process.env.APP_URL}/auth/callback&response_type=code&scope=offline_access`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const response = await axios.post('https://accounts.salla.sa/oauth2/token', {
      client_id: process.env.SALLA_CLIENT_ID,
      client_secret: process.env.SALLA_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${process.env.APP_URL}/auth/callback`
    });
    const token = response.data.access_token;
    res.redirect(`/?token=${token}`);
  } catch (e) {
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
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `اكتب وصفاً احترافياً لمنتج على متجر سلة بالعربية. لا تستخدم رموز markdown مثل ## أو ** أو * — اكتب نصاً عادياً فقط.

المنتج: ${name}
الميزات: ${features}
الفئة المستهدفة: ${audience}
السعر: ${price} ريال

اكتب بهذا الترتيب:

عنوان SEO:
[اكتب عنواناً جذاباً لا يتجاوز 60 حرفاً]

وصف المنتج:
[اكتب وصفاً مقنعاً من 150 إلى 200 كلمة يحفز على الشراء]

نقاط البيع الرئيسية:
- [نقطة 1]
- [نقطة 2]
- [نقطة 3]
- [نقطة 4]
- [نقطة 5]

كلمات البحث SEO:
[10 كلمات مفتاحية مفصولة بفاصلة]`
      }]
    });
    res.json({ description: message.content[0].text });
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

// ===== SALLA WEBHOOK =====
app.post('/webhook/salla', express.json(), (req, res) => {
  console.log('Salla webhook:', req.body);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
