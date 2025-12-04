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

    const { image, text, mode, sourceLang, targetLang } = req.body;

    if (!image && !text) {
      return res.status(400).json({ error: 'No content provided' });
    }

    // ============================================================
    // 分支 A: 純文字輸入 (優先嘗試 Google Apps Script)
    // ============================================================
    if (text) {
        const gasApiUrl = process.env.GAS_API_URL;
        if (gasApiUrl) {
            try {
                const srcLangCode = sourceLang === 'zh' ? 'zh-TW' : 'th';
                const tgtLangCode = sourceLang === 'zh' ? 'th' : 'zh-TW';
                const translation = await translateWithGAS(text, gasApiUrl, srcLangCode, tgtLangCode);
                
                let item = {
                    id: Date.now(),
                    roman: "", 
                    category: "來源: Google Translate (GAS)", 
                    containsShellfish: false
                };

                if (sourceLang === 'zh') {
                    item.zh = text;
                    item.thai = translation;
                } else {
                    item.thai = text;
                    item.zh = translation;
                    const shellfishKeywords = ['กุ้ง', 'ปู', 'หอย', 'กั้ง', 'ล็อบสเตอร์'];
                    item.containsShellfish = shellfishKeywords.some(k => text.includes(k));
                }

                return res.status(200).json({ items: [item] });

            } catch (gasError) {
                console.warn("GAS Failed, falling back to Gemini:", gasError.message);
            }
        }
    }

    // ============================================================
    // 分支 B: Gemini AI (含自動降級機制)
    // ============================================================
    
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // 定義主要模型與備用模型
    const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash-lite";
    const FALLBACK_MODEL = "gemini-2.5-flash-lite-preview-09-2025"; // 1.5 Flash 通常比較穩定且額度較高

    let prompt = "";
    let contentParts = [];

    // 建構 Prompt (邏輯不變)
    if (text) {
        if (sourceLang === 'zh') {
            prompt = `你是一個專業的中泰翻譯助手。請將以下【中文】文字翻譯成【泰文】。任務要求：1. 將中文翻譯成自然的泰文。2. 提供該泰文翻譯結果的羅馬拼音 (RTGS 系統)。3. 嚴格輸出純 JSON 格式。JSON 結構：{ "items": [ { "id": 1, "zh": "${text}", "thai": "泰文翻譯結果", "roman": "泰文羅馬拼音", "category": "中翻泰 (Gemini)" } ] }`;
        } else {
            prompt = `你是一個專業的泰語翻譯助手。請翻譯使用者提供的【泰文】文字。任務要求：1. 翻譯成通順的繁體中文。2. 提供泰文原文的羅馬拼音。3. 分析是否含有「甲殼類海鮮」，若是請設定 containsShellfish: true。4. 嚴格輸出純 JSON 格式。JSON 結構：{ "items": [ { "id": 1, "thai": "${text}", "roman": "泰文羅馬拼音", "zh": "繁體中文翻譯", "containsShellfish": false, "category": "泰翻中 (Gemini)" } ] }`;
        }
        contentParts = [{ text: prompt }];
    } else {
        prompt = `你是一個專業的泰語翻譯助手。分析這張圖片。識別泰文、翻譯成繁體中文、提取價格、標記辣度(isSpicy)。若含有蝦蟹貝類請設定 containsShellfish: true。嚴格輸出純 JSON。JSON 結構範例：{ "items": [ { "id": 1, "thai": "泰文", "zh": "中文", "price": "100", "desc": "描述", "isSpicy": true, "containsShellfish": true, "tags": ["推薦"], "category": "AI 視覺分析" } ] }`;
        if (mode === 'general') {
            prompt = `識別路牌或標示上的泰文，翻譯成繁體中文。輸出純 JSON: {"items": [{"id": 1, "thai": "...", "zh": "...", "desc": "...", "price": "", "isSpicy": false, "containsShellfish": false, "category": "AI 視覺分析", "tags": []}]}`;
        }
        contentParts = [ { text: prompt }, { inlineData: { mimeType: "image/jpeg", data: image } } ];
    }

    // --- 呼叫 AI 的核心函數 (含重試) ---
    async function generateWithRetry(currentModelName, retrying = false) {
        try {
            console.log(`Using Gemini Model: ${currentModelName}`);
            const model = genAI.getGenerativeModel({ 
                model: currentModelName,
                generationConfig: { responseMimeType: "application/json" }
            });

            const result = await model.generateContent({
                contents: [{ role: 'user', parts: contentParts }]
            });

            const response = await result.response;
            return response.text();

        } catch (error) {
            // 如果是 429 (Quota Exceeded) 或 503 (Service Unavailable) 且還沒重試過
            if (!retrying && (error.message.includes('429') || error.message.includes('503'))) {
                console.warn(`Model ${currentModelName} overloaded or quota exceeded. Switching to fallback: ${FALLBACK_MODEL}`);
                return await generateWithRetry(FALLBACK_MODEL, true);
            }
            throw error; // 其他錯誤直接拋出
        }
    }

    // 執行生成
    let responseText = await generateWithRetry(PRIMARY_MODEL);
    
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

async function translateWithGAS(text, gasUrl, sourceLang, targetLang) {
    const response = await fetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, 
        body: JSON.stringify({ text: text, source: sourceLang, target: targetLang }),
        redirect: "follow" 
    });

    if (!response.ok) throw new Error(`GAS API Error: ${response.status}`);
    const data = await response.json();
    
    if (data.status === 'success') return data.translated;
    else throw new Error(data.message || "Unknown GAS Error");
}
