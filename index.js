import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();


const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/analyze', async (req, res) => {
  const { products } = req.body;

  const model = genAI.getGenerativeModel({ model: "models/gemini-2.5-flash-preview-05-20" });

  const prompt = `
You're a skincare expert. A user entered the following skincare products:

${products.map((p, i) => `${i + 1}. ${p.name} (${p.type})`).join('\n')}

Please describe what each product does and in what order they should be used.
Return your answer in JSON:
{
  "products": [ { "name": "...", "description": "..." }, ... ],
  "recommendedOrder": ["Product 1", "Product 2", ...]
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

const json = JSON.parse(text);
res.json(json);
  } catch (error) {
    console.error('Gemini Error:', error);
    res.status(500).json({ error: 'failed to process the request.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
