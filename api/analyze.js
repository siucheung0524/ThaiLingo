const { GoogleGenerativeAI } = require("@google/generative-ai");

export default async function handler(req, res) {
  // 1. 基本安全檢查
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. 獲取 API Key (這是環境變數，只有伺服器端看得到)
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    return res.status(500).json({ error: 'Server Config Error: Missing API Key' });
  }

  try {
    const { image, mode } = req.body; // mode 可能是 'menu' (菜單) 或 'sign' (路牌)

    if (!image) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // 3. 初始化 Gemini 模型
    // 修改點：優先從環境變數讀取模型名稱，如果沒設定，才使用預設值
    // 這樣您可以在 Vercel 後台隨時切換模型 (例如: gemini-1.5-flash, gemini-1.5-pro)
    const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash-exp";
    
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    // 4. 設定 Prompt
    let prompt = `
      你是一個專業的泰語翻譯助手，專門幫助旅客翻譯菜單或路牌。
      請分析這張圖片。
      
      任務要求：
      1. 識別圖中所有的泰文內容。
      2. 請按照圖片上原本的視覺順序（從上到下）排列。
      3. 翻譯成繁體中文 (Traditional Chinese)。
      4. 如果是菜單，請提取價格。
      5. 如果有辣椒圖示或紅色標記，請標記為辣 (isSpicy: true)。
      6. 輸出格式必須是純 JSON，不要包含 markdown 標籤。
      
      JSON 格式範例：
      {
        "items": [
          {
            "id": 1,
            "thai": "泰文原文",
            "zh": "繁體中文翻譯",
            "price": "100", // 如果沒有價格則留空或填寫 "N/A"
            "desc": "簡短的菜色描述 (例如：酸辣湯)",
            "isSpicy": true, // 或 false
            "tags": ["推薦", "熱門"] // 根據圖片上的 "Best Seller" 或拇指圖示判斷，若無則為空陣列
          }
        ]
      }
    `;

    if (mode === 'sign') {
        prompt = `
        你是一個專業的泰語翻譯助手。
        這是一張路牌或標示。
        請識別上面的泰文，並翻譯成繁體中文。
        輸出格式為 JSON:
        {
            "items": [
                { "id": 1, "thai": "原文", "zh": "翻譯", "desc": "這是路名/警告標語/商店名...", "price": "", "isSpicy": false, "tags": [] }
            ]
        }
        `;
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

    const responseText = result.response.text();

    // 6. 清理與解析 JSON (Gemini 有時會包在 ```json ... ``` 裡)
    let cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedData = JSON.parse(cleanJson);

    // 7. 回傳結果
    res.status(200).json(parsedData);

  } catch (error) {
    console.error("Gemini API Error:", error);
    // 增加一點錯誤訊息的細節，方便除錯 (例如配額不足 429 Error)
    res.status(500).json({ error: 'AI Processing Failed', details: error.message });
  }
}