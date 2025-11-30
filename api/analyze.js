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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Error: GEMINI_API_KEY is missing.");
      return res.status(500).json({ error: 'Configuration Error', details: 'API Key missing.' });
    }

    // 接收 image 或 text
    const { image, text, mode } = req.body;
    
    if (!image && !text) {
      return res.status(400).json({ error: 'No content provided' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash-lite"; 
    
    const model = genAI.getGenerativeModel({ 
    // 4. 設定 Prompt
    let prompt = "";
    let contentParts = [];

    // --- 分支 A: 純文字翻譯模式 ---
    if (text) {
        prompt = `
          你是一個專業的泰語翻譯助手。請翻譯使用者提供的泰文文字。
          
          任務要求：
          1. 翻譯成通順的繁體中文 (Traditional Chinese)。
          2. 提供羅馬拼音 (RTGS 系統) 方便發音。
          3. 【安全警示】請分析這段文字是否描述了含有「甲殼類海鮮」（如蝦、蟹、龍蝦、貝類）的食物。這對過敏者至關重要。如果是，請設定 containsShellfish: true。
          4. 嚴格輸出純 JSON 格式。
          
          JSON 結構：
          {
            "items": [
              {
                "id": 1,
                "thai": "泰文原文",
                "roman": "羅馬拼音",
                "zh": "繁體中文翻譯",
                "containsShellfish": true, // 若含有甲殼類
                "category": "文字翻譯"
              }
            ]
          }
          
          待翻譯文字：
          "${text}"
        `;
        contentParts = [{ text: prompt }];
    } 
    // --- 分支 B: 圖片分析模式 ---
    else {
        prompt = `
          你是一個專業的泰語翻譯助手，專門幫助旅客翻譯菜單或路牌。
          請分析這張圖片。
          
          任務要求：
          1. 識別圖中所有的泰文內容。
          2. 翻譯成繁體中文 (Traditional Chinese)。
          3. 如果是菜單，請提取價格。
          4. 如果有辣椒圖示或紅色標記，請標記為辣 (isSpicy: true)。
          5. 【安全警示】請根據菜名或圖片內容，判斷該菜色是否可能含有「甲殼類海鮮」（如蝦、蟹、貝類、蝦米等）。這對過敏者至關重要。若有嫌疑請設定 containsShellfish: true。
          6. 嚴格輸出純 JSON 格式。
          
          JSON 結構：
          {
            "items": [
              {
                "id": 1,
                "thai": "泰文原文",
                "zh": "繁體中文翻譯",
                "price": "100",
                "desc": "簡短的菜色描述",
                "isSpicy": true,
                "containsShellfish": true, // 若含有甲殼類
                "tags": ["推薦"]
              }
            ]
          }
        `;

        if (mode === 'general') {
            prompt = `識別路牌或標示上的泰文，翻譯成繁體中文。輸出純 JSON: {"items": [{"id": 1, "thai": "...", "zh": "...", "desc": "...", "price": "", "isSpicy": false, "containsShellfish": false, "tags": []}]}`;
        }

        contentParts = [
            { text: prompt },
            { inlineData: { mimeType: "image/jpeg", data: image } }
        ];
    }

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: contentParts }]
    });

    const response = await result.response;
    let responseText = response.text();
    
    // 清理 JSON
    if (responseText.includes("```")) {
        responseText = responseText.replace(/```json/g, '').replace(/```/g, '');
    }
    const jsonStartIndex = responseText.indexOf('{');
    const jsonEndIndex = responseText.lastIndexOf('}');
    if (jsonStartIndex !== -1 && jsonEndIndex !== -1) {
        responseText = responseText.substring(jsonStartIndex, jsonEndIndex + 1);
    }
    
    let parsedData;
    try {
        parsedData = JSON.parse(responseText);
    } catch (e) {
        return res.status(500).json({ error: 'AI Response Error', details: 'Failed to parse JSON', raw: responseText });
    }

    res.status(200).json(parsedData);

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: 'Processing Failed', details: error.message });
  }
}
