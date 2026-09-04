# 全國人行道資料 · Taiwan National Sidewalk Inventory

互動式人行道地圖頁面（`index.html`），呈現全國各縣市 2026 年 6 月人行道路網的淨寬健檢、
街景比對、A1 死亡事故點位與電線桿障礙圖層。

此頁面自 [`taiwan-mobility-atlas`](https://github.com/yunching0513/taiwan-mobility-atlas)
擷取而來，連同其執行所需的資料與資源檔一併複製為獨立頁面。

線上原始版本：<https://yunching0513.github.io/taiwan-mobility-atlas/sidewalk.html>

## 內容結構

| 路徑 | 說明 |
| --- | --- |
| `index.html` | 主頁面（原 `sidewalk.html`） |
| `data/sidewalks26/*.geojson` | 各縣市人行道路網（2026 年 6 月，依需載入） |
| `data/poles/*.json` | 台電電線桿圖層（依需載入） |
| `data/national_points.js` | A1 死亡事故點位圖層 |
| `data/sidewalk_national.js` | 全國人行道統計摘要 |
| `data/cities.js`, `data/townships_en.js` | 縣市／鄉鎮對照 |
| `data/gmaps_key.js` | Google Maps API 金鑰（街景比對用；受網域限制） |
| `data/tiles/living_streets.pmtiles` | 全台生活街道候選（≤15 m，估算路寬分級 A/B/C）向量圖磚，來自 [Taiwanwonnerf](https://github.com/yunching0513/202609---Taiwanwonnerf) |
| `data/tiles/hierarchy.pmtiles` | 道路功能層級（Sustainable Safety：Through／Distributor）向量圖磚 |
| `data/tiles/*_stats.json`, `living_streets_summary.json` | 上述圖層之長度統計（圖例用） |
| `assets/protomaps-leaflet.js` | protomaps-leaflet 4.0.1（在 Leaflet 上繪製 PMTiles 向量圖磚） |
| `districts.geojson`, `populations.json` | 行政區界與人口 |
| `assets/`, `manifest.webmanifest`, `sw.js` | 圖示、PWA manifest 與 service worker |

## 生活街道與道路層級圖層

「Advocacy」列新增三個切換：**🛣 生活街道候選 ≤12 m**（≤8 m 巷弄、8–12 m 社區街道）、**＋12–15 m 邊界**、**🧭 道路層級 Sustainable Safety**（Through＝國道／快速公路、Distributor＝省／縣／鄉道與市區幹道、Access＝其餘市區道路）。
路寬為 OSM 路網推估（width 標籤→lanes→路名慣例→道路等級預設），點擊路段可見估算值與依據。資料處理流程與各縣市 Shapefile 見 Taiwanwonnerf repo；更新圖磚時直接覆蓋 `data/tiles/*.pmtiles` 與統計 JSON 即可。

## 本地預覽

```bash
python3 -m http.server 8848   # PMTiles 需 HTTP Range；若圖層不顯示請改用 `pip install rangehttpserver && python3 -m RangeHTTPServer 8848`
# 開啟 http://127.0.0.1:8848/
```

> 地圖圖磚、Leaflet 與 Google 街景由外部 CDN 載入，預覽時需要對外網路連線。

## 授權

見 [`LICENSE`](./LICENSE)。
