import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  // 1. 允許簡單的 CORS (如果是在本地測試會用到，但在 Vercel 同網域通常不需要，加了保險)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 2. 檢查 API Key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Error: GEMINI_API_KEY is missing in environment variables.");
      return res.status(500).json({ 
        error: 'Configuration Error', 
        details: 'API Key not set on server. Please add GEMINI_API_KEY in Vercel Settings.' 
      });
    }

    const { image, mode } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // 3. 初始化模型 (改用最穩定的 1.5 Flash)
    const genAI = new GoogleGenerativeAI(apiKey);
    // 優先使用環境變數，否則使用 1.5 Flash
    const modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash"; 
    const model = genAI.getGenerativeModel({ model: modelName });

    // 4. 設定 Prompt
    let prompt = `
      你是一個專業的泰語翻譯助手，專門幫助旅客翻譯菜單或路牌。
      請分析這張圖片。
      
      任務要求：
      1. 識別圖中所有的泰文內容。
      2. 翻譯成繁體中文 (Traditional Chinese)。
      3. 如果是菜單，請提取價格。
      4. 如果有辣椒圖示或紅色標記，請標記為辣 (isSpicy: true)。
      5. 輸出純 JSON 格式。
      
      JSON 範例：
      {
        "items": [
          {
            "id": 1,
            "thai": "泰文",
            "zh": "中文",
            "price": "100",
            "desc": "描述",
            "isSpicy": true,
            "tags": ["推薦"]
          }
        ]
      }
    `;

    if (mode === 'sign') {
        prompt = `識別路牌或標示上的泰文，翻譯成繁體中文。輸出 JSON: {"items": [{"id": 1, "thai": "...", "zh": "...", "desc": "...", "price": "", "isSpicy": false, "tags": []}]}`;
    }

    // 5. 呼叫 Gemini
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: image
        }
      }
    ]);

    const response = await result.response;
    const text = response.text();
    
    // 清理 JSON
    let cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    
    // 嘗試解析，如果失敗則回傳原始文本以便除錯
    let parsedData;
    try {
        parsedData = JSON.parse(cleanJson);
    } catch (e) {
        console.error("JSON Parse Error:", text);
        return res.status(500).json({ error: 'AI Response Error', details: 'Failed to parse AI response as JSON', raw: text });
    }

    res.status(200).json(parsedData);

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: 'Processing Failed', details: error.message });
  }
}
