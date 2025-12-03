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
        // 去除空格，避免因複製貼上導致的 key 錯誤
        const hfApiKey = process.env.HF_API_KEY ? process.env.HF_API_KEY.trim() : null;

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
                console.warn("NLLB Failed after retries, falling back to Gemini. Reason:", hfError.message);
                // 失敗後自動往下執行 Gemini 邏輯
            }
        } else {
            console.log("HF_API_KEY not found or empty.");
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

// --- 輔助函數：呼叫 Hugging Face NLLB-200 (含重試機制) ---
async function translateWithNLLB(text, apiKey) {
    const url = "[https://api-inference.huggingface.co/models/facebook/nllb-200-distilled-600M](https://api-inference.huggingface.co/models/facebook/nllb-200-distilled-600M)";
    
    // 最多重試 3 次
    for (let i = 0; i < 3; i++) {
        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            method: "POST",
            body: JSON.stringify({
                inputs: text,
                parameters: {
                    src_lang: "tha_Thai",
                    tgt_lang: "zho_Hant"
                }
            }),
        });

        // 處理模型載入中 (503) 的情況
        if (response.status === 503) {
            const errorData = await response.json();
            const waitTime = errorData.estimated_time || 5.0; // 預設等待 5 秒
            console.log(`NLLB Model loading, waiting ${waitTime}s... (Attempt ${i + 1}/3)`);
            
            // 等待指定時間
            await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            continue; // 重試迴圈
        }

        if (!response.ok) {
             const errText = await response.text();
             throw new Error(`HF API Error ${response.status}: ${errText}`);
        }

        const result = await response.json();
        if (Array.isArray(result) && result[0]?.translation_text) {
            return result[0].translation_text;
        }
        throw new Error("Unexpected HF response format");
    }
    throw new Error("NLLB Model unavailable after retries");
}
