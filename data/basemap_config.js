// 底圖設定
//
// CARTO 自 2026 年起要求 API 金鑰；沒有金鑰的圖磚會被印上「API KEY REQUIRED」。
// 金鑰免費（非商業用途每月 500 萬次圖磚），在 https://carto.com/basemaps/apikey
// 填 email 即寄到，不需要 CARTO 帳號。填入後即恢復原本的 CARTO 淺色底圖。
//
// 留空時改用內政部國土測繪中心「臺灣通用電子地圖」（灰階化），免金鑰；
// 若國土測繪中心連不上，會再自動改用 OpenStreetMap（灰階化）。
//
// 改動後記得把 sw.js 的 VERSION 加一，否則已安裝 PWA 的使用者會拿到舊快取。
window.BASEMAP_CONFIG = {
  cartoKey: '',
};
