import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';


dotenv.config();


const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: 'https://skindexanalyzer.com',
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

app.post('/analyze', async (req, res) => {
  const { products } = req.body;

  const model = genAI.getGenerativeModel({ model: "models/gemini-2.5-flash-preview-05-20" });

  const prompt = `
You're a licensed esthetician and skincare formulator. A user entered the following skincare products:

${products.map((p, i) => `${i + 1}. ${p.name} (${p.type})`).join('\n')}

Please return a JSON response that includes:

1. A description of what each product does.
2. Whether it should be used in the AM, PM, or both.
3. How often it should be used (e.g., daily, 2-3x/week).
4. Any ingredients or product types that should not be used together.
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
    },
    ...
  ],
  "recommendedRoutine": {
    "AM": ["CeraVe Cleanser", "Vitamin C Serum", "Moisturizer", "Sunscreen"],
    "PM": ["CeraVe Cleanser", "BHA Exfoliant", "Niacinamide Serum", "Moisturizer"]
  },
  "conflicts": [
    {
      "products": ["Retinol", "Vitamin C"],
      "reason": "These ingredients can cause irritation when used together."
    }
  ]
}
`;

  try {
    const result = await model.generateContent(prompt);
    let text = await result.response.text();

    text = text.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(\w*)\n/, '');
      text = text.replace(/```$/, '');
    }

    console.log("Raw Gemini response:\n", text);

    
    const json = JSON.parse(text);
    res.json(json);
  } catch (error) {
    console.error('Gemini Error:', error);
    res.status(500).json({ error: 'failed to process the request.' });
  }
});

app.post('/send-email', async (req, res) => {
  const { email, analysisResult } = req.body;

  if (!email || !analysisResult) {
    return res.status(400).json({ error: 'Email and analysisResult are required.' });
  }

  function formatAnalysisToText(result) {
    let text = "🧴 Your Skincare Analysis Results:\n\n";

    if (result.products) {
      text += "📦 Products Analysis:\n";
      result.products.forEach((p) => {
        text += `- ${p.name} ${p.description}\n  Usage Time: ${p.usageTime.join(', ')}\n  Frequency: ${p.frequency}\n\n`;
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
        text += `- ${conflict.products.join(" & ")} ${conflict.reason}\n`;
      });
    }

    return text;
  }

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your Skincare Products Analysis ✨',
    text: formatAnalysisToText(analysisResult),
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ message: 'Email sent successfully!' });
  } catch (err) {
    console.error('Email sending error:', err);
    res.status(500).json({ error: 'Failed to send email.' });
  }
});


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
