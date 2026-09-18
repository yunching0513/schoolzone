// PPGIS 後端設定（公民科學標註）
//
// 未填 = 平台維持目前的唯讀行為，標註功能不會出現，其他功能完全不受影響。
// 填好後把 sw.js 的 VERSION 加一，避免使用者拿到舊快取。
//
// anonKey 是 Supabase 的「anon public」金鑰，設計上就是公開的；
// 真正的防線是 0002 migration 裡的 RLS 與 SECURITY DEFINER 寫入函式。
window.PPGIS_CONFIG = {
  url: '',        // 例：'https://xxxxxxxx.supabase.co'
  anonKey: '',    // 例：'eyJhbGciOi...'
};
