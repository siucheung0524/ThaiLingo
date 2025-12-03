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
    const { image, text, mode } = req.body;

    if (!image && !text) {
      return res.status(400).json({ error: 'No content provided' });
    }

    // --- 分支 A: 純文字輸入 (優先嘗試 Google Apps Script) ---
    if (text) {
        // 從環境變數讀取 GAS URL
        const gasApiUrl = process.env.GAS_API_URL;

        if (gasApiUrl) {
            try {
                console.log("Attempting Google Apps Script translation...");
                
                const translation = await translateWithGAS(text, gasApiUrl);
                
                // 本地過敏原關鍵字偵測
                const shellfishKeywords = ['กุ้ง', 'ปู', 'หอย', 'กั้ง', 'ล็อบสเตอร์'];
                const hasShellfish = shellfishKeywords.some(keyword => text.includes(keyword));

                const responseData = {
                    items: [
                        {
                            id: Date.now(),
                            thai: text,
                            zh: translation,
                            roman: "", // 前端會自動補上拼音
                            category: "來源: Google Translate (GAS)", 
                            containsShellfish: hasShellfish
                        }
                    ]
                };
                return res.status(200).json(responseData);

            } catch (gasError) {
                console.warn("GAS Failed, falling back to Gemini:", gasError.message);
                // 失敗後自動往下執行 Gemini 邏輯
            }
        }
    }

    // --- 分支 B: Gemini AI (圖片模式 或 GAS 失敗後的文字模式) ---
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Error: GEMINI_API_KEY is missing.");
      return res.status(500).json({ error: 'Configuration Error', details: 'API Key missing.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || "gemini-2.0-flash-lite"; 
    
    const model = genAI.getGenerativeModel({ 
        model: modelName,
        generationConfig: { responseMimeType: "application/json" }
    });

    let prompt = "";
    let contentParts = [];

    if (text) {
        // 純文字模式 (Gemini Fallback)
        prompt = `
          你是一個專業的泰語翻譯助手。請翻譯使用者提供的泰文文字。
          
          任務：
          1. 翻譯成繁體中文。
          3. 判斷是否含甲殼類 (containsShellfish)。
          4. 輸出 JSON。
          
          JSON 結構：
          {
            "items": [
              {
                "id": 1,
                "thai": "${text}",
                "zh": "翻譯結果",
                "containsShellfish": false,
                "category": "來源: Google Gemini"
              }
            ]
          }
        `;
        contentParts = [{ text: prompt }];
    } else {
        // 圖片模式
        prompt = `
          你是一個專業的泰語翻譯助手。分析這張圖片。
          識別泰文、翻譯成繁體中文、提取價格、標記辣度(isSpicy)。
          若含有蝦蟹貝類請設定 containsShellfish: true。
          嚴格輸出純 JSON。
          
          JSON 結構範例：
          {
            "items": [
              {
                "id": 1,
                "thai": "泰文",
                "zh": "中文",
                "price": "100",
                "desc": "描述",
                "isSpicy": true,
                "containsShellfish": true,
                "tags": ["推薦"],
                "category": "AI 視覺分析"
              }
            ]
          }
        `;
        
        if (mode === 'general') {
             prompt = `識別圖片中的泰文，翻譯成繁體中文。輸出 JSON: {"items": [{"id": 1, "thai": "...", "zh": "...", "desc": "...", "price": "", "isSpicy": false, "containsShellfish": false, "category": "AI 視覺分析", "tags": []}]}`;
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

// --- 輔助函數：呼叫 Google Apps Script ---
async function translateWithGAS(text, gasUrl) {
    // Google Apps Script 在 POST 時需要 follow redirect
    const response = await fetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // GAS 特性：有時用 text/plain 比較穩
        body: JSON.stringify({ text: text }),
        redirect: "follow" 
    });

    if (!response.ok) {
        throw new Error(`GAS API Error: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.status === 'success') {
        return data.translated;
    } else {
        throw new Error(data.message || "Unknown GAS Error");
    }
}
