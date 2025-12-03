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
    const { image, text, mode, sourceLang } = req.body;

    if (!image && !text) {
      return res.status(400).json({ error: 'No content provided' });
    }

    // ============================================================
    // 分支 A: 純文字輸入 (優先嘗試 Google Apps Script 免費翻譯)
    // ============================================================
    if (text) {
        const gasApiUrl = process.env.GAS_API_URL;

        if (gasApiUrl) {
            try {
                console.log("Attempting Google Apps Script translation...");
                
                // 設定語言方向
                // 如果來源是中文(zh)，目標就是泰文(th)
                // 如果來源是泰文(th)，目標就是繁體中文(zh-TW)
                const srcLangCode = sourceLang === 'zh' ? 'zh-TW' : 'th';
                const tgtLangCode = sourceLang === 'zh' ? 'th' : 'zh-TW';

                const translation = await translateWithGAS(text, gasApiUrl, srcLangCode, tgtLangCode);
                
                // 組裝回傳資料
                let item = {
                    id: Date.now(),
                    roman: "", // 前端會自動生成羅馬拼音
                    category: "來源: Google Translate (GAS)", 
                    containsShellfish: false
                };

                if (sourceLang === 'zh') {
                    // 中 -> 泰
                    item.zh = text;
                    item.thai = translation;
                } else {
                    // 泰 -> 中
                    item.thai = text;
                    item.zh = translation;
                    
                    // 簡單的本地關鍵字偵測 (甲殼類)
                    const shellfishKeywords = ['กุ้ง', 'ปู', 'หอย', 'กั้ง', 'ล็อบสเตอร์'];
                    item.containsShellfish = shellfishKeywords.some(k => text.includes(k));
                }

                const responseData = {
                    items: [item]
                };
                return res.status(200).json(responseData);

            } catch (gasError) {
                console.warn("GAS Failed, falling back to Gemini:", gasError.message);
                // 若 GAS 失敗，程式會繼續往下執行，使用 Gemini
            }
        }
    }

    // ============================================================
    // 分支 B: Gemini AI (處理圖片 或 GAS 失敗後的文字)
    // ============================================================
    
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
        if (sourceLang === 'zh') {
            // 中 -> 泰
            prompt = `
              你是一個專業的中泰翻譯助手。請將以下【中文】文字翻譯成【泰文】。
              
              任務要求：
              1. 將中文翻譯成自然的泰文。
              2. 嚴格輸出純 JSON 格式。
              
              JSON 結構：
              {
                "items": [
                  {
                    "id": 1,
                    "zh": "${text}",
                    "thai": "泰文翻譯結果",
                    "category": "中翻泰 (Gemini)"
                  }
                ]
              }
            `;
        } else {
            // 泰 -> 中
            prompt = `
              你是一個專業的泰語翻譯助手。請翻譯使用者提供的【泰文】文字。
              
              任務要求：
              1. 翻譯成通順的繁體中文 (Traditional Chinese)。
              2. 【安全警示】請分析這段文字是否描述了含有「甲殼類海鮮」的食物，若是請設定 containsShellfish: true。
              3. 嚴格輸出純 JSON 格式。
              
              JSON 結構：
              {
                "items": [
                  {
                    "id": 1,
                    "thai": "${text}",
                    "roman": "泰文羅馬拼音",
                    "zh": "繁體中文翻譯",
                    "containsShellfish": false,
                    "category": "泰翻中 (Gemini)"
                  }
                ]
              }
            `;
        }
        contentParts = [{ text: prompt }];
    } else {
        // 圖片模式 (維持不變)
        prompt = `
          你是一個專業的泰語翻譯助手。請分析這張圖片。
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
            prompt = `識別路牌或標示上的泰文，翻譯成繁體中文。輸出純 JSON: {"items": [{"id": 1, "thai": "...", "zh": "...", "desc": "...", "price": "", "isSpicy": false, "containsShellfish": false, "category": "AI 視覺分析", "tags": []}]}`;
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

// --- 輔助函數：呼叫 Google Apps Script ---
async function translateWithGAS(text, gasUrl, sourceLang, targetLang) {
    // GAS 需要支援 POST 並解析 JSON body
    const response = await fetch(gasUrl, {
        method: "POST",
        // 使用 no-cors 模式可能會導致無法讀取回應，GAS 必須部署為 Web App 且權限為 "Anyone"
        // 這裡使用標準 fetch，GAS 那邊必須正確處理 OPTIONS 請求或單純接收 POST
        // 但為了避免 CORS 問題，最簡單的方式是讓 Vercel 後端 (Serverless) 去打 GAS，這就不會有 CORS 問題
        headers: { "Content-Type": "text/plain;charset=utf-8" }, 
        body: JSON.stringify({ 
            text: text,
            source: sourceLang,
            target: targetLang
        }),
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
