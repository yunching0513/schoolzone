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

## 道路安全 × 國家所得

```bash
python3 tests/road_safety_mock.py /tmp/rs.json          # 以模擬 API 回應產生合成資料
RS_FIXTURE=/tmp/rs.json node tests/road-safety.spec.js
```

`road_safety_mock.py` 用模擬的 WHO／IMF／World Bank 回應跑完整的
`scripts/build_road_safety.py`，順便測到資料建置腳本本身（性別篩選、全球估計值、
台灣換算、缺資料國家的略過）。**產生的數值全是隨機合成的**，只用來測圖表行為，
絕不可放進 `data/`。固定亂數種子，結果可重現。

## 道路安全 × 所得分配

```bash
python3 tests/test_build_inequality.py      # 迴歸、等級相關、bootstrap 的單元測試
node tests/inequality.spec.js               # 頁面端對端測試（讀 data/road_safety_inequality.json）
```

`inequality.spec.js` 用真實資料檔，檢查頁面上的數字與資料檔一致、臺灣在對數軸上的位置正確、
臺灣與美國在兩張圖都有標籤且標籤不重疊、篩選與圖例同步兩張圖、表格排序，以及 320／390px
手機版不出界。資料檔由 `scripts/build_inequality.py` 產生（需先有 `data/road_safety_gdp.json`）。
