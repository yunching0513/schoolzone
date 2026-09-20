/* 造訪人次
 *
 * 伺服器端只存每日彙總計數（見 supabase/migrations/0004_site_visits.sql）——
 * 沒有 IP、沒有 user agent、沒有指紋、沒有每人一列的紀錄。
 * 「不重複訪客」完全由這支程式在瀏覽器端判斷：第一次來才把 new=true 送上去，
 * 伺服器收到的只是「請加一」。清除瀏覽器資料就會被重新算成新訪客，
 * 所以這是個約略值，不是分析工具——本來也只是要讓訪客看見這個站有人在用。
 *
 * 同一個分頁重新整理不重複計數（sessionStorage 旗標）。
 */
(function () {
  'use strict';

  const CFG = window.PPGIS_CONFIG || {};
  if (!CFG.url || !CFG.anonKey) return;      // 沒設定後端就完全不出現

  const SEEN_KEY = 'vzt_visitor_seen';       // localStorage：這個瀏覽器來過
  const COUNTED_KEY = 'vzt_visit_counted';   // sessionStorage：這個分頁已計數

  const T = (zh, en) => (window.TT ? window.TT(zh, en) : zh);
  let stats = null;

  function lsGet(store, k) { try { return store.getItem(k); } catch (e) { return null; } }
  function lsSet(store, k, v) { try { store.setItem(k, v); } catch (e) {} }

  function rpc(fn, args) {
    return fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'apikey': CFG.anonKey,
        'Authorization': 'Bearer ' + CFG.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args || {}),
    }).then(r => (r.ok ? r.json() : Promise.reject(new Error('http_' + r.status))));
  }

  function render() {
    if (!stats) return;
    let el = document.getElementById('visitCount');
    if (!el) {
      const footer = document.querySelector('footer');
      if (!footer) return;
      el = document.createElement('div');
      el.id = 'visitCount';
      // 插在版權與標籤之間
      footer.insertBefore(el, footer.querySelector('.tags'));
    }
    const n = v => Number(v || 0).toLocaleString('en-US');
    el.innerHTML =
      `<span title="${T('累計造訪次數', 'total visits')}">👣 ${n(stats.total_visits)} ` +
        `<span class="vc-l">${T('次造訪', 'visits')}</span></span>` +
      `<span class="vc-sep">·</span>` +
      `<span title="${T('約略不重複訪客數（以瀏覽器計）', 'approximate unique visitors, counted per browser')}">${n(stats.total_visitors)} ` +
        `<span class="vc-l">${T('位訪客', 'visitors')}</span></span>` +
      (stats.today_visits > 0
        ? `<span class="vc-sep">·</span><span title="${T('今日（台灣時間）', 'today, Taiwan time')}">${T('今日', 'today')} ${n(stats.today_visits)}</span>`
        : '');
  }

  function take(rows) {
    const r = Array.isArray(rows) ? rows[0] : rows;
    if (r) { stats = r; render(); }
  }

  function start() {
    // 同一分頁重新整理 → 只讀不累加
    if (lsGet(sessionStorage, COUNTED_KEY)) {
      rpc('get_visit_stats').then(take).catch(() => {});
      return;
    }
    const isNew = !lsGet(localStorage, SEEN_KEY);
    rpc('record_visit', { p_new: isNew })
      .then(rows => {
        lsSet(sessionStorage, COUNTED_KEY, '1');
        lsSet(localStorage, SEEN_KEY, '1');
        take(rows);
      })
      .catch(() => {/* 連不上就不顯示，不要在頁尾留一個壞掉的數字 */});
  }

  window.__visitsRender = render;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
