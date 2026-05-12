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
    const response = await axios.post('https://accounts.salla.sa/oauth2/token', {
      client_id: process.env.SALLA_CLIENT_ID,
      client_secret: process.env.SALLA_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI
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
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `أنت كاتب محتوى تجاري محترف متخصص في التجارة الإلكترونية السعودية. مهمتك كتابة وصف منتج استثنائي يجعل العميل يقول "واو" ويضغط زر الشراء فوراً. لا تستخدم رموز markdown مثل ## أو ** أو * — اكتب نصاً عادياً فقط.

المنتج: ${name}
الميزات: ${features}
الفئة المستهدفة: ${audience}
السعر: ${price} ريال

اكتب وصفاً طويلاً ومتكاملاً بهذا الترتيب:

عنوان SEO:
اكتب عنواناً مثيراً وجذاباً لا يتجاوز 60 حرفاً يحتوي على الكلمة المفتاحية الرئيسية

افتتاحية مشوّقة:
اكتب فقرة افتتاحية قوية من 3 أسطر تخلق فضولاً وتجذب القارئ من الكلمة الأولى، استخدم أسلوب قصصي أو سؤال مثير

قصة المنتج وتجربة الاستخدام:
اكتب 3 فقرات طويلة تصف تجربة استخدام المنتج بشكل حي وواقعي، كأنك تحكي قصة. اجعل العميل يتخيل نفسه يستخدم المنتج ويشعر بالفرق قبل وبعد. استخدم مشاعر وحواس وتفاصيل دقيقة.

لماذا هذا المنتج الأفضل في فئته:
اكتب فقرتين تشرح فيهما ما يميز هذا المنتج عن المنافسين وما الذي يجعله استثماراً ذكياً

المواصفات والتفاصيل الكاملة:
- ميزة 1 مع شرح مفصل لفائدتها
- ميزة 2 مع شرح مفصل لفائدتها
- ميزة 3 مع شرح مفصل لفائدتها
- ميزة 4 مع شرح مفصل لفائدتها
- ميزة 5 مع شرح مفصل لفائدتها
- ميزة 6 مع شرح مفصل لفائدتها
- ميزة 7 مع شرح مفصل لفائدتها

لمن هذا المنتج:
اكتب فقرة تصف بالتفصيل الشخص المثالي الذي سيستفيد من هذا المنتج، اجعله يشعر أن المنتج صُنع خصيصاً له

الضمان والثقة:
فقرة تبني الثقة وتزيل أي تردد لدى العميل

الدعوة للشراء:
اكتب خاتمة قوية ومحفزة تدفع العميل لإضافة المنتج للسلة الآن مع التركيز على قيمة السعر ${price} ريال

كلمات البحث SEO:
15 كلمة مفتاحية مفصولة بفاصلة تشمل الكلمات الأكثر بحثاً`
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
