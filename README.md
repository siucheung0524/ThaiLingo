ThaiLingo 泰譯通 🇹🇭

這是一個專為泰國旅遊設計的即時翻譯 Web App，結合了 Vercel Serverless Function 與 Google Gemini AI。

如何部署到 Vercel (Deployment)

準備檔案：
確保您的資料夾中有以下檔案：

index.html (前端介面)

api/analyze.js (後端 API)

package.json (套件設定)

上傳至 Vercel：

您可以使用 Vercel CLI：在資料夾中執行 vercel。

或者將這個資料夾推送到 GitHub，然後在 Vercel 後台匯入。

設定環境變數 (Environment Variables)：
這是最重要的一步！ 為了讓 AI 功能運作，您必須在 Vercel 專案設定中加入 API Key。

進入 Vercel 專案儀表板 -> Settings -> Environment Variables

Key: GEMINI_API_KEY

Value: 您的_Google_Gemini_API_Key (可以去 Google AI Studio 免費申請)

完成！
部署完成後，打開網址，相機權限允許後即可開始掃描翻譯。

功能特色

隱私安全：API Key 儲存在伺服器端，前端只傳送圖片。

泰奶科技風：獨特的泰國奶茶配色 UI。

硬體變焦：支援手機原生的光學變焦控制。

AI 智能排版：Gemini 會嘗試還原菜單的視覺順序。
