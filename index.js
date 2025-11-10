import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sgMail from '@sendgrid/mail';


dotenv.config();


const app = express();
const PORT = process.env.PORT || 4000;


app.use(cors({
  origin: 'https://skindexanalyzer.com',
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// ===== SendGrid Setup =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/analyze', async (req, res) => {
  const { products } = req.body;

  if (!products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'Products array is required.' });
  }

  const primaryModel = 'models/gemini-2.5-flash-preview-09-2025';
  const fallbackModel = 'models/gemini-2.5-flash';

  let model;
  try {
    model = genAI.getGenerativeModel({ model: primaryModel });
    console.log(`🧠 Using primary model: ${primaryModel}`);
  } catch {
    console.warn(`⚠️ Primary model failed. Using fallback: ${fallbackModel}`);
    model = genAI.getGenerativeModel({ model: fallbackModel });
  }

  const prompt = `
You're a licensed esthetician and skincare formulator.
ONLY return a valid JSON object. Do NOT include markdown, comments, or extra text.
A user entered the following skincare products:

${products.map((p, i) => `${i + 1}. ${p.name} (${p.type})`).join('\n')}

Please return a JSON response that includes:

1. A description of what each product does.
2. Whether it should be used in the AM, PM, or both.
3. How often it should be used (e.g., daily, 2-3x/week).
4. Any ingredients or product types that should not be used together. 
   - **If there are no conflicts, explicitly return "none" in the conflicts array for that product.**
5. A recommended usage order for AM and PM routines, skipping products that should not be used at that time.

Return your answer in this JSON format:

{
  "products": [
    {
      "name": "CeraVe Cleanser",
      "description": "Gently cleanses without stripping skin barrier.",
      "usageTime": ["AM", "PM"],
      "frequency": "daily",
      "conflictsWith": [] 
    }
  ],
  "recommendedRoutine": {
    "AM": [],
    "PM": []
  },
  "conflicts": []
}
`;

  try {
    let result;
    try {
      result = await model.generateContent(prompt);
    } catch {
      console.warn(`⚠️ Error using primary model. Retrying with fallback: ${fallbackModel}`);
      const fallback = genAI.getGenerativeModel({ model: fallbackModel });
      result = await fallback.generateContent(prompt);
    }

    let text = (await result.response.text()).trim();
    if (text.startsWith("```")) text = text.replace(/^```(\w*)\n/, '').replace(/```$/, '');

    console.log("Raw Gemini response:\n", text);

    let json;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      console.error("JSON parsing error:", parseErr.message);
      return res.status(500).json({ error: 'Gemini returned invalid JSON.' });
    }

    // SAFETY: Ensure every product has conflictsWith
    json.products = json.products.map(p => ({
      name: p.name || "Unnamed Product",
      description: p.description || "",
      usageTime: Array.isArray(p.usageTime) ? p.usageTime : [],
      frequency: p.frequency || "",
      conflictsWith: Array.isArray(p.conflictsWith) ? p.conflictsWith : []
    }));

    // Ensure conflicts array exists and normalize conflicts.products to strings
    json.conflicts = (json.conflicts || []).map(conflict => {
      let productsStr = [];

      if (Array.isArray(conflict.products)) {
        productsStr = conflict.products.map(p => {
          if (typeof p === 'string') return p;
          if (p && p.product) return p.product;
          return JSON.stringify(p);
        });
      } else if (typeof conflict.products === 'string') {
        productsStr = [conflict.products];
      }

      return {
        products: productsStr,
        reason: conflict.reason || "unspecified"
      };
    });

    // Ensure recommendedRoutine exists
    if (!json.recommendedRoutine) json.recommendedRoutine = { AM: [], PM: [] };
    if (!Array.isArray(json.recommendedRoutine.AM)) json.recommendedRoutine.AM = [];
    if (!Array.isArray(json.recommendedRoutine.PM)) json.recommendedRoutine.PM = [];

    res.json(json);

  } catch (error) {
    console.error('❌ Gemini Error:', error);
    res.status(500).json({ error: 'Failed to process the request.' });
  }
});

// ===== Send Email with SendGrid =====
app.post('/send-email', async (req, res) => {
  const { email, analysisResult } = req.body;
  console.log("📨 Email request received:", req.body);

  if (!email || !analysisResult) {
    return res.status(400).json({ error: 'Email and analysisResult are required.' });
  }


  function formatAnalysisToText(result) {
  let text = "🧴 Your Skincare Analysis Results:\n\n";

  if (result.products) {
    text += "📦 Products Analysis:\n";
    result.products.forEach((p) => {
      const usageTime = Array.isArray(p.usageTime) ? p.usageTime.join(', ') : "unspecified";
      const frequency = p.frequency || "unspecified";
      text += `- ${p.name} ${p.description}\n  Usage Time: ${usageTime}\n  Frequency: ${frequency}\n\n`;
    });
  }

  if (result.recommendedRoutine) {
    text += "🌅 Recommended AM Routine:\n";
    (result.recommendedRoutine.AM || []).forEach((item, i) => {
      text += `${i + 1}. ${item}\n`;
    });

    text += "\n🌙 Recommended PM Routine:\n";
    (result.recommendedRoutine.PM || []).forEach((item, i) => {
      text += `${i + 1}. ${item}\n`;
    });
  }

  if (result.conflicts && result.conflicts.length > 0) {
    text += "\n⚠️ Conflicts:\n";
    result.conflicts.forEach((conflict) => {
      const products = Array.isArray(conflict.products) ? conflict.products.join(" & ") : "unknown";
      const reason = conflict.reason || "unspecified";
      text += `- ${products} ${reason}\n`;
    });
  }

  return text;
}


  
  const msg = {
    to: email,
    from: process.env.EMAIL_FROM, 
    subject: 'Your Skincare Products Analysis ✨',
    text: formatAnalysisToText(analysisResult),
  };

  try {
    await sgMail.send(msg);
    console.log("✅ Email sent via SendGrid");
    res.json({ message: 'Email sent successfully! Please check your spam folder if you do not see it.' });
  } catch (err) {
    console.error('❌ SendGrid error:', err.response?.body || err.message);
    res.status(500).json({ error: 'Failed to send email.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
