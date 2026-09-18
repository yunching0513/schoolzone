# 端對端測試

`ppgis.spec.js` 用 Playwright 驅動 Chromium，把 Supabase 與 Leaflet 都攔截成
本地模擬，驗證公民科學標註的完整流程：加入工作坊 → 標註 → 畫通學路徑 →
顯示圖層 → 離線佇列 → 未設定後端時靜默停用。

不需要真的後端，也不會寫到任何資料庫。

```bash
npm install playwright                     # 只需要模組，瀏覽器用系統既有的
npm pack leaflet@1.9.4 && tar xzf leaflet-1.9.4.tgz   # 測試會讀 package/dist/leaflet.js
python3 -m http.server 8765 &
node tests/ppgis.spec.js
```

腳本裡的 Leaflet 與 Chromium 路徑寫死在最上方，依環境調整。
