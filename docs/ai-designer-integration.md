# AI 街景生成器連動說明

「打造夢想街道」的街道改造相簿，每筆收藏都有「🎨 AI 改造」按鈕，會以下列格式開啟生成器：

```
https://ai-street-designer.onrender.com/?img=<街景圖網址>&lat=<緯度>&lng=<經度>&heading=<方位角>&road=<路名>
```

同時會把 `img` 的網址複製到剪貼簿。

## 現況（第 1 層，零改動）

生成器目前會忽略這些參數。使用者開啟後手動「貼上圖片網址」或上傳先前下載的街景圖即可，流程通順但需一步手動操作。

## 升級（第 2 層）：讓生成器自動載入傳來的街景

在生成器前端的初始化程式（頁面 load 時）加入約十行：

```js
// Auto-load a street view passed from the schoolzone map
// (https://github.com/yunching0513/schoolzone)
const params = new URLSearchParams(location.search);
const img = params.get('img');
if (img && /^https:\/\/maps\.googleapis\.com\/maps\/api\/streetview/.test(img)) {
  fetch(img)
    .then(r => r.blob())
    .then(blob => {
      const file = new File([blob], 'streetview.jpg', { type: 'image/jpeg' });
      // ↓ 依生成器的實作擇一：
      // A. 若以 <input type="file"> 收圖：
      //    const dt = new DataTransfer(); dt.items.add(file);
      //    fileInput.files = dt.files; fileInput.dispatchEvent(new Event('change'));
      // B. 若有自己的 loadImage(fileOrBlob) 函式，直接呼叫：
      //    loadImage(file);
    })
    .catch(() => {/* 圖片抓不到就維持手動上傳 */});
  // 可選：把 road / lat / lng 顯示在介面上，或帶進 prompt
  // const road = params.get('road');
}
```

注意：`img` 是 Google Street View Static API 網址，內含你的 Maps 金鑰。
金鑰已限制網域（github.io / localhost），在生成器（onrender.com）的**後端**抓圖不受
referrer 限制、前端 fetch 則可能被擋——若前端抓不到，把抓圖改到後端做即可
（生成器後端多半本來就要下載圖片送 AI 模型）。

## 第 3 層（可選）：共用資料庫，形成「改造前 → 改造後」閉環

目前相簿只存在使用者瀏覽器的 localStorage，生成器產出的「改造後」圖也不會回流。
若要達成：跨裝置同步相簿、生成結果自動回寫、Before/After 對照牆、公開分享——
就需要一個小後端。建議用 Supabase（免費層即可）：

- `album` 資料表：id, created_at, lat, lng, heading, pano, road, county, note, before_url
- `remakes` 資料表：album_id, created_at, after_url, prompt, model
- Storage bucket 存生成圖；RLS 設 anon 可讀、寫入用簡單 token
- 兩個前端（schoolzone 頁 + 生成器）各用 supabase-js 讀寫同一專案

在那之前，第 1、2 層完全不需要後端。
