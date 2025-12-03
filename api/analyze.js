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
        const hfApiKey = process.env.HF_API_KEY;

        if (hfApiKey) {
            try {
                console.log("Attempting NLLB-200 translation...");
                const translation = await translateWithNLLB(text, hfApiKey);
                
                const responseData = {
                    items: [
                        {
                            id: Date.now(),
                            thai: text,
                            zh: translation,
                            roman: "", // 前端會自動補上
                            category: "來源: Meta NLLB-200", // 明確標示來源
                            containsShellfish: false // NLLB 無法判斷，預設 false
                        }
                    ]
                };
                return res.status(200).json(responseData);
            } catch (hfError) {
                console.warn("NLLB Failed, falling back to Gemini:", hfError.message);
                // 失敗後自動往下執行 Gemini 邏輯
            }
        }
    }

    // --- 分支 B: Gemini AI (處理圖片 或 NLLB 失敗後的文字) ---
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Error: GEMINI_API_KEY is missing.");
      return res.status(500).json({ error: 'Configuration Error', details: 'API Key missing.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    // 使用較快且穩定的 Flash Lite 模型
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
          你是一個專業的泰語翻譯助手。請翻譯以下泰文。
          
          任務：
          1. 翻譯成繁體中文。
          2. 提供羅馬拼音。
          3. 判斷是否含甲殼類 (containsShellfish)。
          4. 輸出 JSON。
          
          JSON 結構：
          {
            "items": [
              {
                "id": 1,
                "thai": "${text}",
                "roman": "拼音",
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
        
        // 如果是 General 模式，簡化 Prompt
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
    
    // JSON 清理
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
    // facebook/nllb-200-distilled-600M 是一個輕量且效果好的多語言翻譯模型
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
                    src_lang: "tha_Thai", // NLLB 泰文代碼
                    tgt_lang: "zho_Hant"  // NLLB 繁體中文代碼
                }
            }),
        }
    );

    if (!response.ok) {
        throw new Error(`HF API Error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    // HF 回傳格式通常是陣列
    if (Array.isArray(result) && result[0]?.translation_text) {
        return result[0].translation_text;
    } else if (result.error) {
        throw new Error(result.error);
    } else {
        throw new Error("Unexpected HF response format");
    }
}
