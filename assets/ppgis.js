/* 打造夢想街道 · PPGIS 客戶端
 *
 * 直接呼叫 Supabase 的 PostgREST／RPC，不載入 supabase-js（省 ~100 KB，
 * 也不必再多一個 CDN 依賴）。所有寫入都走 SECURITY DEFINER 函式，
 * 客戶端只持有 anon key 與參與者 token。
 *
 * 離線佇列：工作坊現場常常沒訊號，送不出去的標註先存 localStorage，
 * 恢復連線時自動補送——這是現場可用性的關鍵，不是加分項。
 */
(function () {
  'use strict';

  const CFG = window.PPGIS_CONFIG || {};
  const SESSION_KEY = 'ppgis_session_v1';
  const QUEUE_KEY = 'ppgis_queue_v1';
  const DEVICE_KEY = 'ppgis_device_v1';

  const configured = !!(CFG.url && CFG.anonKey);

  function lsGet(k, fallback) {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch (e) { return fallback; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  let session = lsGet(SESSION_KEY, null);
  let queue = lsGet(QUEUE_KEY, []);
  const listeners = [];

  function emit() { listeners.forEach(fn => { try { fn(); } catch (e) {} }); }

  // 裝置識別：本機隨機值的 SHA-256，用於「同一裝置續填」。
  // 不含任何硬體或個人資訊，也無法從雜湊回推。
  async function deviceHash() {
    let raw = lsGet(DEVICE_KEY, null);
    if (!raw) {
      raw = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()) + Date.now());
      lsSet(DEVICE_KEY, raw);
    }
    if (!crypto.subtle) return raw.slice(0, 32);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function headers(extra) {
    return Object.assign({
      'apikey': CFG.anonKey,
      'Authorization': 'Bearer ' + CFG.anonKey,
      'Content-Type': 'application/json',
    }, extra || {});
  }

  async function rpc(fn, args) {
    if (!configured) throw new Error('ppgis_not_configured');
    const res = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: headers(), body: JSON.stringify(args || {}),
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch (e) {}
      const err = new Error(msg || `rpc_failed_${res.status}`);
      err.status = res.status; err.pgMessage = msg;
      throw err;
    }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  async function select(path) {
    if (!configured) throw new Error('ppgis_not_configured');
    const res = await fetch(`${CFG.url}/rest/v1/${path}`, { headers: headers() });
    if (!res.ok) throw new Error(`select_failed_${res.status}`);
    return res.json();
  }

  // ------------------------------------------------------- 離線佇列
  function enqueue(fn, args) {
    queue.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), fn, args, at: Date.now() });
    lsSet(QUEUE_KEY, queue);
    emit();
  }

  let flushing = false;
  async function flush() {
    if (flushing || !configured || !queue.length || !navigator.onLine) return;
    flushing = true;
    try {
      while (queue.length) {
        const item = queue[0];
        try {
          await rpc(item.fn, item.args);
        } catch (e) {
          // 4xx（資料本身有問題）就丟掉，不要卡住整個佇列；5xx／斷線則留著重試
          if (e.status && e.status >= 400 && e.status < 500) {
            console.warn('[ppgis] dropping bad queued item', item.fn, e.pgMessage);
          } else {
            break;
          }
        }
        queue.shift();
        lsSet(QUEUE_KEY, queue);
        emit();
      }
    } finally { flushing = false; }
  }

  window.addEventListener('online', flush);
  setInterval(flush, 30000);

  // --------------------------------------------------------- 參與
  async function join(joinCode, role, meta) {
    const dh = await deviceHash();
    const rows = await rpc('join_workshop', {
      p_join_code: String(joinCode || '').trim(),
      p_role: role,
      p_device_hash: dh,
      p_age_band: (meta && meta.ageBand) || null,
      p_grade_year: (meta && meta.gradeYear) || null,
      p_home_band: (meta && meta.homeBand) || null,
    });
    const r = Array.isArray(rows) ? rows[0] : rows;
    if (!r || !r.token) throw new Error('join_failed');
    session = {
      token: r.token, pseudonym: r.pseudonym, role: role,
      workshopId: r.workshop_id, workshopTitle: r.workshop_title,
      schoolCode: r.school_code, schoolName: r.school_name,
      joinedAt: Date.now(),
    };
    lsSet(SESSION_KEY, session);
    emit();
    flush();
    return session;
  }

  function leave() { session = null; lsSet(SESSION_KEY, null); emit(); }

  // ----------------------------------------------------- 寫入操作
  // 有連線就直送；沒連線就排隊。呼叫端不必分辨。
  async function send(fn, args, opts) {
    if (!configured) throw new Error('ppgis_not_configured');
    if (!session) throw new Error('not_joined');
    if (!navigator.onLine) { enqueue(fn, args); return { queued: true }; }
    try {
      const out = await rpc(fn, args);
      return { queued: false, result: out };
    } catch (e) {
      if (!e.status || e.status >= 500) { enqueue(fn, args); return { queued: true }; }
      throw e;
    }
  }

  function submitAnnotation(a) {
    return send('submit_annotation', {
      p_token: session.token, p_kind: a.kind,
      p_lat: a.lat, p_lon: a.lng,
      p_severity: a.severity ?? null,
      p_body: a.body || null,
      p_pano_id: a.pano || null,
      p_heading: a.heading ?? null,
      p_image_url: a.imageUrl || null,
      p_road_name: a.road || null,
    });
  }

  function submitRoute(r) {
    return send('submit_route', {
      p_token: session.token,
      p_coords: r.coords,                 // [[lng,lat], …]，起點為學校端
      p_mode: r.mode, p_accompany: r.accompany,
      p_direction: r.direction || 'to_school',
      p_duration: r.durationMin ?? null,
      p_frequency: r.frequency || null,
    });
  }

  function submitLicences(wave, items) {
    return send('submit_licences', { p_token: session.token, p_wave: wave, p_items: items });
  }

  function recordConsent(kind, granted, docVer, guardian) {
    return send('record_consent', {
      p_token: session.token, p_kind: kind, p_granted: !!granted,
      p_document_ver: docVer || null, p_guardian_pseudonym: guardian || null,
    });
  }

  function saveAlbumItem(it) {
    return send('save_album_item', {
      p_token: session.token, p_lat: it.lat, p_lon: it.lng,
      p_heading: it.heading ?? null, p_pitch: it.pitch ?? 0,
      p_pano_id: it.pano || null, p_road_name: it.road || null,
      p_county_zh: it.county || null, p_note: it.note || null,
      p_before_url: it.beforeUrl || null, p_annotation_id: it.annotationId || null,
    });
  }

  function saveRemake(albumItemId, afterUrl, extra) {
    return send('save_remake', {
      p_token: session.token, p_album_item_id: albumItemId, p_after_url: afterUrl,
      p_prompt: (extra && extra.prompt) || null,
      p_model: (extra && extra.model) || null,
      p_resolution: (extra && extra.resolution) || null,
    });
  }

  // ----------------------------------------------------- 讀取操作
  let kindsCache = null;
  async function kinds() {
    if (kindsCache) return kindsCache;
    kindsCache = await select('annotation_kinds?select=*&order=sort_order');
    return kindsCache;
  }

  let licencesCache = null;
  async function licences() {
    if (licencesCache) return licencesCache;
    licencesCache = await select('licences?select=*&order=sort_order');
    return licencesCache;
  }

  // 取回已發布標註。有 bbox 就限制範圍，避免整包拉回來。
  function published(bbox, limit) {
    let q = `v_annotations_public?select=*&limit=${limit || 2000}&order=created_at.desc`;
    if (bbox) {
      q += `&lat=gte.${bbox.south}&lat=lte.${bbox.north}` +
           `&lon=gte.${bbox.west}&lon=lte.${bbox.east}`;
    }
    return select(q);
  }

  function schoolStats(code) {
    return select(`v_school_objective_vs_perceived?select=*&code=eq.${encodeURIComponent(code)}`);
  }

  window.PPGIS = {
    configured,
    get session() { return session; },
    get pending() { return queue.length; },
    onChange(fn) { listeners.push(fn); },
    join, leave, flush,
    submitAnnotation, submitRoute, submitLicences, recordConsent,
    saveAlbumItem, saveRemake,
    kinds, licences, published, schoolStats,
    _rpc: rpc,
  };
})();
