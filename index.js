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

// ===== Gemini Setup =====
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/analyze', async (req, res) => {
  const { products } = req.body;

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'Products array is required.' });
  }

  const primaryModel = 'models/gemini-2.5-flash-preview-09-2025';
  const fallbackModel = 'models/gemini-2.5-flash';

  let model;
  try {
    model = genAI.getGenerativeModel({ model: primaryModel });
    console.log(`🧠 Using primary model: ${primaryModel}`);
  } catch {
    model = genAI.getGenerativeModel({ model: fallbackModel });
    console.warn(`⚠️ Falling back to model: ${fallbackModel}`);
  }

  const prompt = `
You're a licensed esthetician and skincare formulator.
ONLY return a valid JSON object. Do NOT include markdown, comments, or extra text.

User products:
${products.map((p, i) => `${i + 1}. ${p.name} (${p.type})`).join('\n')}

Return JSON in this format:

{
  "products": [],
  "recommendedRoutine": { "AM": [], "PM": [] },
  "conflicts": []
}
`;

  try {
    let result;
    try {
      result = await model.generateContent(prompt);
    } catch {
      const fallback = genAI.getGenerativeModel({ model: fallbackModel });
      result = await fallback.generateContent(prompt);
    }

    let text = (await result.response.text()).trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(\w*)\n/, '').replace(/```$/, '');
    }

    console.log("🧠 Raw Gemini response:\n", text);

    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      console.error("❌ JSON parse error:", err.message);
      return res.status(500).json({ error: 'Gemini returned invalid JSON.' });
    }

    // ===== Normalize Products =====
    json.products = (json.products || []).map(p => ({
      name: p.name || "Unnamed Product",
      description: p.description || "",
      usageTime: Array.isArray(p.usageTime) ? p.usageTime : [],
      frequency: p.frequency || "",
      conflictsWith: Array.isArray(p.conflictsWith) ? p.conflictsWith : []
    }));

    // ===== Normalize Conflicts (FIXED) =====
    json.conflicts = (json.conflicts || [])
      .map(conflict => {
        let products = [];

        if (Array.isArray(conflict.products)) {
          products = conflict.products;
        } else if (Array.isArray(conflict.items)) {
          products = conflict.items;
        } else if (conflict.productA && conflict.productB) {
          products = [conflict.productA, conflict.productB];
        }

        const cleanReason =
          typeof conflict.reason === "string" && conflict.reason.trim()
            ? conflict.reason
            : typeof conflict.explanation === "string" && conflict.explanation.trim()
            ? conflict.explanation
            : typeof conflict.description === "string" && conflict.description.trim()
            ? conflict.description
            : "unspecified";

        return {
          products,
          reason: cleanReason
        };
      })
    
      .filter(c => Array.isArray(c.products) && c.products.length >= 2);

    // ===== Ensure Routine Exists =====
    if (!json.recommendedRoutine) json.recommendedRoutine = { AM: [], PM: [] };
    if (!Array.isArray(json.recommendedRoutine.AM)) json.recommendedRoutine.AM = [];
    if (!Array.isArray(json.recommendedRoutine.PM)) json.recommendedRoutine.PM = [];

    console.log(
      "📤 Conflicts sent to frontend:",
      JSON.stringify(json.conflicts, null, 2)
    );

    res.json(json);

  } catch (error) {
    console.error('❌ Gemini Error:', error);
    res.status(500).json({ error: 'Failed to process the request.' });
  }
});

// ===== Send Email =====
app.post('/send-email', async (req, res) => {
  const { email, analysisResult } = req.body;

  if (!email || !analysisResult) {
    return res.status(400).json({ error: 'Email and analysisResult are required.' });
  }

  const formatAnalysisToText = (result) => {
    let text = "🧴 Your Skincare Analysis Results:\n\n";

    result.products?.forEach(p => {
      text += `- ${p.name}\n  ${p.description}\n\n`;
    });

    if (result.conflicts?.length) {
      text += "⚠️ Conflicts:\n";
      result.conflicts.forEach(c => {
        text += `- ${c.products.join(" & ")}: ${c.reason}\n`;
      });
    }

    return text;
  };

  try {
    await sgMail.send({
      to: email,
      from: process.env.EMAIL_FROM,
      subject: 'Your Skincare Products Analysis ✨',
      text: formatAnalysisToText(analysisResult),
    });

    res.json({ message: 'Email sent successfully!' });
  } catch (err) {
    console.error('❌ SendGrid error:', err.message);
    res.status(500).json({ error: 'Failed to send email.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
