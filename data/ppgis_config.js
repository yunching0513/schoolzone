// PPGIS 後端設定（公民科學標註）
//
// anonKey 是 Supabase 的「anon public」金鑰，設計上就是公開的——
// 真正的防線是 supabase/migrations/0002 的 RLS 與 SECURITY DEFINER 寫入函式：
// 匿名身分連 participants 的 SELECT 權限都沒有，也不能直接 INSERT 任何資料表。
//
// 改動後記得把 sw.js 的 VERSION 加一，避免已安裝 PWA 的使用者拿到舊快取。
window.PPGIS_CONFIG = {
  url: 'https://jxfdgpvkecfnmzsugvaz.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4ZmRncHZrZWNmbm16c3VndmF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MTc5NDAsImV4cCI6MjEwNTI5Mzk0MH0.C1NbjgHRhkxBK0V5KYmISnLWldVQaQeIgWryIBak4bk',
};
