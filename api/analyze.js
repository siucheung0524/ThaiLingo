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

    // --- 分支 A: 純文字輸入 (優先嘗試 NLLB-200) ---
    if (text) {
        // 檢查是否有設定 Hugging Face API Key
        const hfApiKey = process.env.HF_API_KEY;

        if (hfApiKey) {
            try {
                console.log("Using NLLB-200 for text translation...");
                const translation = await translateWithNLLB(text, hfApiKey);
                
                // 手動組裝符合前端需求的 JSON 結構
                const responseData = {
                    items: [
                        {
                            id: Date.now(),
                            thai: text,
                            zh: translation,
                            roman: "", // 前端會自動生成
                            category: "NLLB 翻譯", // 標記來源
                            containsShellfish: false // NLLB 無法判斷過敏原，預設 false
                        }
                    ]
                };
                return res.status(200).json(responseData);
            } catch (hfError) {
                console.error("NLLB Translation Failed, falling back to Gemini:", hfError);
                // 如果 NLLB 失敗，繼續往下走，使用 Gemini 作為備案
            }
        } else {
            console.log("HF_API_KEY not found, using Gemini for text translation.");
        }
    }

    // --- 分支 B: Gemini AI (處理圖片 或 NLLB 失敗/未設定時的文字) ---
    
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
        // 純文字模式 (Gemini)
        prompt = `
          你是一個專業的泰語翻譯助手。請翻譯使用者提供的泰文文字。
          
          任務要求：
          1. 翻譯成通順的繁體中文 (Traditional Chinese)。
          2. 提供羅馬拼音 (RTGS 系統)。
          3. 【安全警示】若文字描述了含有「甲殼類海鮮」的食物，請設定 containsShellfish: true。
          4. 嚴格輸出純 JSON 格式。
          
          JSON 結構：
          {
            "items": [
              {
                "id": 1,
                "thai": "泰文原文",
                "roman": "羅馬拼音",
                "zh": "繁體中文翻譯",
                "containsShellfish": true,
                "category": "文字翻譯"
              }
            ]
          }
          
          待翻譯文字：
          "${text}"
        `;
        contentParts = [{ text: prompt }];
    } else {
        // 圖片模式
        prompt = `
          你是一個專業的泰語翻譯助手。請分析這張圖片。
          
          任務要求：
          1. 識別圖中所有的泰文內容。
          2. 翻譯成繁體中文 (Traditional Chinese)。
          3. 提取價格。
          4. 標記辣度 (isSpicy: true/false)。
          5. 【安全警示】若菜色可能含有「甲殼類海鮮」，請設定 containsShellfish: true。
          6. 嚴格輸出純 JSON 格式。
          
          JSON 結構：
          {
            "items": [
              {
                "id": 1,
                "thai": "泰文原文",
                "zh": "繁體中文翻譯",
                "price": "100",
                "desc": "簡短描述",
                "isSpicy": true,
                "containsShellfish": true,
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

// --- 輔助函數：呼叫 Hugging Face NLLB-200 ---
async function translateWithNLLB(text, apiKey) {
    // 使用 facebook/nllb-200-distilled-600M 模型，速度快且效果不錯
    const response = await fetch(
        "[https://api-inference.huggingface.co/models/facebook/nllb-200-distilled-600M](https://api-inference.huggingface.co/models/facebook/nllb-200-distilled-600M)",
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            method: "POST",
            body: JSON.stringify({
                inputs: text,
                parameters: {
                    src_lang: "tha_Thai", // NLLB 的泰文代碼
                    tgt_lang: "zho_Hant"  // NLLB 的繁體中文代碼
                }
            }),
        }
    );

    if (!response.ok) {
        throw new Error(`HF API Error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    // Hugging Face Inference API 回傳格式通常為: [{ "translation_text": "..." }]
    if (Array.isArray(result) && result[0]?.translation_text) {
        return result[0].translation_text;
    } else {
        throw new Error("Unexpected HF response format");
    }
}
