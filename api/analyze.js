import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  // 1. 允許簡單的 CORS
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

    // 3. 初始化模型
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // 使用 Gemini 2.5 Flash Lite
    const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"; 
    
    const model = genAI.getGenerativeModel({ 
        model: modelName,
        // 強制設定 generationConfig 以確保 JSON 輸出
        generationConfig: {
            responseMimeType: "application/json"
        }
    });

    // 4. 設定 Prompt (加入羅馬拼音要求)
    let prompt = `
      你是一個專業的泰語翻譯助手，專門幫助旅客翻譯菜單或路牌。
      請分析這張圖片。
      
      任務要求：
      1. 識別圖中所有的泰文內容。
      2. 翻譯成繁體中文 (Traditional Chinese)。
      3. 請提供泰文的羅馬拼音 (RTGS 系統)，幫助使用者發音。
      4. 如果是菜單，請提取價格。
      5. 如果有辣椒圖示或紅色標記，請標記為辣 (isSpicy: true)。
      6. 嚴格輸出純 JSON 格式。
      
      JSON 結構如下：
      {
        "items": [
          {
            "id": 1,
            "thai": "泰文原文",
            "roman": "羅馬拼音 (例如: Tom Yum Kung)",
            "zh": "繁體中文翻譯",
            "price": "100",
            "desc": "簡短的菜色描述",
            "isSpicy": true,
            "tags": ["推薦"]
          }
        ]
      }
    `;

    if (mode === 'sign') {
        prompt = `識別路牌或標示上的泰文，翻譯成繁體中文並提供羅馬拼音。輸出純 JSON: {"items": [{"id": 1, "thai": "...", "roman": "...", "zh": "...", "desc": "...", "price": "", "isSpicy": false, "tags": []}]}`;
    }

    // 5. 呼叫 Gemini
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: image
              }
            }
          ]
        }
      ]
    });

    const response = await result.response;
    let text = response.text();
    
    // 6. 增強型清理 JSON
    if (text.includes("```")) {
        text = text.replace(/```json/g, '').replace(/```/g, '');
    }
    
    const jsonStartIndex = text.indexOf('{');
    const jsonEndIndex = text.lastIndexOf('}');
    
    if (jsonStartIndex !== -1 && jsonEndIndex !== -1) {
        text = text.substring(jsonStartIndex, jsonEndIndex + 1);
    }
    
    let parsedData;
    try {
        parsedData = JSON.parse(text);
    } catch (e) {
        console.error("JSON Parse Error. Cleaned text was:", text);
        return res.status(500).json({ 
            error: 'AI Response Error', 
            details: 'Failed to parse AI response as JSON', 
            raw: text.substring(0, 200) + "..." 
        });
    }

    res.status(200).json(parsedData);

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: 'Processing Failed', details: error.message });
  }
}
