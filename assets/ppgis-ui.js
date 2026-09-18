/* 打造夢想街道 · PPGIS 介面
 *
 * 在既有地圖上加三件事：
 *   1. 標註模式 —— 點地圖任一處，用兒童聽得懂的語彙留下一則標註
 *   2. 通學路徑 —— 畫出「我怎麼走去學校」，含是否有大人陪同（CIM 的核心測量）
 *   3. 已發布標註圖層 —— 讓參與者看見彼此的標註，這是共創的前提
 *
 * 未設定後端（data/ppgis_config.js 留空）時整個模組靜默停用，
 * 地圖的其他功能完全不受影響。
 */
(function () {
  'use strict';

  const P = window.PPGIS;
  if (!P || !P.configured) return;

  let H = null;                       // 來自 index.html 的地圖掛勾
  let mode = null;                    // null | 'annotate' | 'route'
  let kinds = [];
  let layer = null;                   // 已發布標註圖層
  let routePts = [], routeLine = null, routeMarks = null;

  const T = (zh, en) => (window.TT ? window.TT(zh, en) : zh);   // TT 可能晚一步定義
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------ 介面骨架
  function buildBar() {
    const bar = document.querySelector('.filter-bar');
    if (!bar || document.getElementById('ppgisGroup')) return;
    const g = document.createElement('div');
    g.className = 'filter-group';
    g.id = 'ppgisGroup';
    g.innerHTML =
      `<span class="filter-group-label">${T('公民科學', 'Citizen science')}</span>` +
      `<span class="cat-pill" id="ppgisAnnotate">✏️ <span>${T('標註模式', 'Annotate')}</span></span>` +
      `<span class="cat-pill" id="ppgisRoute">🗺 <span>${T('畫通學路', 'Draw route')}</span></span>` +
      `<span class="cat-pill" id="ppgisShow">👁 <span>${T('看大家的標註', 'Show marks')}</span></span>` +
      `<span class="ppgis-who" id="ppgisWho"></span>`;
    // 插在 Advocacy 那一組後面，排行／計數那組之前
    const last = bar.querySelector('.filter-group[style*="margin-left"]');
    bar.insertBefore(g, last || null);

    document.getElementById('ppgisAnnotate').addEventListener('click', () => setMode('annotate'));
    document.getElementById('ppgisRoute').addEventListener('click', () => setMode('route'));
    document.getElementById('ppgisShow').addEventListener('click', toggleLayer);
    renderWho();
  }

  function renderWho() {
    const el = document.getElementById('ppgisWho');
    if (!el) return;
    const s = P.session;
    if (!s) { el.innerHTML = `<span class="ppgis-anon">${T('尚未加入工作坊', 'not joined')}</span>`; return; }
    const q = P.pending ? ` <span class="ppgis-q" title="${T('待補送', 'queued')}">⏳${P.pending}</span>` : '';
    el.innerHTML = `<span class="ppgis-me" title="${esc(s.workshopTitle)}">🙋 ${esc(s.pseudonym)}</span>${q}` +
      ` <span class="ppgis-leave" id="ppgisLeave">${T('離開', 'leave')}</span>`;
    const lv = document.getElementById('ppgisLeave');
    if (lv) lv.addEventListener('click', () => {
      if (confirm(T('離開工作坊？已送出的標註會保留，此裝置的身分會清除。',
                    'Leave the workshop? Submitted marks stay; this device forgets its identity.'))) {
        P.leave(); setMode(null);
      }
    });
  }
  P.onChange(renderWho);

  // ------------------------------------------------------------ 模式切換
  function setMode(m) {
    if (m && !P.session) { openJoin(() => setMode(m)); return; }
    if (mode === 'route' && m !== 'route') clearRoute();
    mode = (mode === m) ? null : m;
    document.getElementById('ppgisAnnotate').classList.toggle('active', mode === 'annotate');
    document.getElementById('ppgisRoute').classList.toggle('active', mode === 'route');
    const mc = H.map.getContainer();
    mc.style.cursor = mode ? 'crosshair' : '';
    if (mode === 'annotate') H.toast(T('✏️ 點地圖上任何地方留下標註', '✏️ Tap anywhere on the map to leave a mark'));
    if (mode === 'route') H.toast(T('🗺 從學校開始，沿著你走的路一路點下去', '🗺 Start at school and tap along the way you walk'));
  }

  // ------------------------------------------------------------ 加入工作坊
  function openJoin(after) {
    modal(
      T('加入工作坊', 'Join a workshop'),
      `<p class="ppgis-lede">${T('請輸入主持人給你的代碼。你不需要帳號，也不會留下姓名。',
                                 'Enter the code your facilitator gave you. No account, no name.')}</p>` +
      `<label class="ppgis-f"><span>${T('工作坊代碼', 'Workshop code')}</span>` +
        `<input id="pjCode" autocapitalize="characters" autocomplete="off" placeholder="AB12CD"></label>` +
      `<label class="ppgis-f"><span>${T('你是', 'You are')}</span><select id="pjRole">` +
        `<option value="student">${T('學生', 'Student')}</option>` +
        `<option value="parent">${T('家長', 'Parent')}</option>` +
        `<option value="teacher">${T('老師', 'Teacher')}</option>` +
        `<option value="resident">${T('社區居民', 'Resident')}</option>` +
      `</select></label>` +
      `<label class="ppgis-f" id="pjGradeWrap"><span>${T('年級', 'Grade')}</span><select id="pjGrade">` +
        `<option value="">${T('不想說', 'prefer not to say')}</option>` +
        Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('') +
      `</select></label>` +
      `<label class="ppgis-f"><span>${T('家到學校大概多遠', 'Home to school')}</span><select id="pjHome">` +
        `<option value="">${T('不想說', 'prefer not to say')}</option>` +
        `<option value="&lt;300m">${T('走路 5 分鐘內', 'under 5 min walk')}</option>` +
        `<option value="300-800m">${T('走路 5–10 分鐘', '5–10 min walk')}</option>` +
        `<option value="800m-2km">${T('走路 10–25 分鐘', '10–25 min walk')}</option>` +
        `<option value="&gt;2km">${T('更遠', 'further')}</option>` +
      `</select></label>` +
      `<label class="ppgis-check"><input type="checkbox" id="pjConsent">` +
        `<span>${T('我已閱讀並同意參與這項研究；我知道我留下的標註會用於研究與倡議，且不會記錄我的姓名。',
                   'I have read and agree to take part; my marks may be used for research and advocacy, and my name is not recorded.')}</span></label>` +
      `<p class="ppgis-note">${T('若你未滿 18 歲，請確認家長或監護人已同意。',
                                 'If you are under 18, please make sure a guardian has agreed.')}</p>`,
      T('加入', 'Join'),
      async () => {
        const code = document.getElementById('pjCode').value.trim();
        const role = document.getElementById('pjRole').value;
        if (!code) { return T('請輸入代碼', 'Please enter the code'); }
        if (!document.getElementById('pjConsent').checked) {
          return T('請先勾選同意參與', 'Please tick the consent box');
        }
        const grade = document.getElementById('pjGrade').value;
        try {
          await P.join(code, role, {
            gradeYear: grade ? +grade : null,
            ageBand: grade ? gradeToBand(+grade) : null,
            homeBand: document.getElementById('pjHome').value || null,
          });
          await P.recordConsent(role === 'student' ? 'child_assent' : 'adult_consent', true).catch(() => {});
          H.toast(T(`🙋 歡迎，${P.session.pseudonym}`, `🙋 Welcome, ${P.session.pseudonym}`));
          if (after) after();
        } catch (e) {
          const m = String(e.pgMessage || e.message || '');
          if (m.includes('workshop_not_found')) return T('找不到這個代碼', 'No workshop with that code');
          if (m.includes('workshop_closed')) return T('這場工作坊已經結束了', 'That workshop has closed');
          return T('加入失敗，請再試一次', 'Could not join — please try again');
        }
      });
    setTimeout(() => {
      const r = document.getElementById('pjRole'), w = document.getElementById('pjGradeWrap');
      const sync = () => { w.style.display = r.value === 'student' ? '' : 'none'; };
      r.addEventListener('change', sync); sync();
    }, 0);
  }

  function gradeToBand(g) {
    return g <= 2 ? '6-8' : g <= 4 ? '9-11' : g <= 6 ? '9-11' : g <= 9 ? '12-14' : '15-17';
  }

  // ------------------------------------------------------------ 標註表單
  async function openAnnotation(latlng) {
    if (!kinds.length) { try { kinds = await P.kinds(); } catch (e) { kinds = []; } }
    if (!kinds.length) { H.toast(T('標註語彙載入失敗', 'Could not load categories')); return; }

    const groups = [
      ['negative', T('讓我不敢自己走的', 'What stops me walking alone')],
      ['positive', T('讓我喜歡的', 'What I like')],
      ['idea',     T('我的改造提案', 'My idea')],
    ];
    const chips = groups.map(([v, label]) => {
      const items = kinds.filter(k => k.valence === v);
      if (!items.length) return '';
      return `<div class="ppgis-kgroup"><div class="ppgis-klabel">${label}</div><div class="ppgis-kchips">` +
        items.map(k => `<span class="ppgis-kind" data-k="${esc(k.key)}" data-v="${esc(k.valence)}">` +
          `${k.icon || ''} ${esc(window.__LANG === 'en' ? k.label_en : k.label_zh)}</span>`).join('') +
        `</div></div>`;
    }).join('');

    const sv = H.svPoint();
    const near = sv && Math.abs(sv.lat - latlng.lat) < 3e-4 && Math.abs(sv.lng - latlng.lng) < 3e-4;

    modal(
      T('留下一則標註', 'Leave a mark'),
      `<p class="ppgis-lede">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</p>` +
      chips +
      `<label class="ppgis-f" id="ppSevWrap"><span id="ppSevLabel">${T('有多嚴重？', 'How bad is it?')}</span>` +
        `<input type="range" id="ppSev" min="1" max="5" value="3"><output id="ppSevOut">3</output></label>` +
      `<label class="ppgis-f"><span>${T('想說什麼？（可不填）', 'Anything to add? (optional)')}</span>` +
        `<textarea id="ppBody" rows="3" maxlength="500" placeholder="${T('例如：這裡的車轉彎都不看人', 'e.g. cars turn here without looking')}"></textarea></label>` +
      (near ? `<label class="ppgis-check"><input type="checkbox" id="ppSv" checked>` +
              `<span>${T('附上目前的街景畫面', 'Attach the current Street View')}</span></label>` : ''),
      T('送出', 'Submit'),
      async () => {
        const sel = document.querySelector('.ppgis-kind.on');
        if (!sel) return T('請先選一個類別', 'Please pick a category');
        const kind = sel.dataset.k;
        const useSv = near && document.getElementById('ppSv') && document.getElementById('ppSv').checked;
        const seg = H.svSelLayer && H.svSelLayer();
        const pano = H.svPano && H.svPano();
        const a = {
          kind, lat: latlng.lat, lng: latlng.lng,
          severity: +document.getElementById('ppSev').value,
          body: document.getElementById('ppBody').value,
          heading: useSv ? Math.round(H.svHeading()) : null,
          pano: useSv && pano ? (pano.getPano() || null) : null,
          road: seg && seg.feature ? (seg.feature.properties.n || '') : null,
        };
        if (useSv && H.svStaticUrl) {
          a.imageUrl = H.svStaticUrl({ lat: a.lat, lng: a.lng, heading: a.heading || 0, pano: a.pano }, '640x480');
        }
        try {
          const r = await P.submitAnnotation(a);
          H.toast(r.queued
            ? T('📥 已存在這台裝置，恢復連線後自動送出', '📥 Saved on this device — will send when back online')
            : T('✅ 謝謝你！標註已送出', '✅ Thank you — mark submitted'));
          if (layer) refreshLayer();
        } catch (e) {
          const m = String(e.pgMessage || e.message || '');
          if (m.includes('rate_limited')) return T('慢一點，喘口氣再標', 'Slow down a moment');
          if (m.includes('quota_exceeded')) return T('這場的標註額度用完了', 'You have reached this workshop\'s limit');
          return T('送出失敗，請再試一次', 'Submit failed — please try again');
        }
      });

    // 類別選取 + 依正負向調整「嚴重度」的問法
    setTimeout(() => {
      document.querySelectorAll('.ppgis-kind').forEach(c => c.addEventListener('click', () => {
        document.querySelectorAll('.ppgis-kind').forEach(x => x.classList.remove('on'));
        c.classList.add('on');
        const v = c.dataset.v;
        const wrap = document.getElementById('ppSevWrap');
        document.getElementById('ppSevLabel').textContent =
          v === 'positive' ? T('有多喜歡？', 'How much do you like it?')
          : v === 'idea' ? T('有多想改？', 'How keen are you?')
          : T('有多嚴重？', 'How bad is it?');
        wrap.style.display = '';
      }));
      const sev = document.getElementById('ppSev'), out = document.getElementById('ppSevOut');
      sev.addEventListener('input', () => { out.textContent = sev.value; });
    }, 0);
  }

  // ------------------------------------------------------------ 通學路徑
  function addRoutePt(latlng) {
    routePts.push(latlng);
    if (!routeMarks) { routeMarks = L.layerGroup().addTo(H.map); }
    L.circleMarker(latlng, { radius: 4, color: '#0D9488', fillColor: '#fff', fillOpacity: 1, weight: 2 })
      .addTo(routeMarks);
    if (routeLine) routeLine.setLatLngs(routePts);
    else routeLine = L.polyline(routePts, { color: '#0D9488', weight: 4, dashArray: '6 4' }).addTo(H.map);
    showRouteHud();
  }

  function clearRoute() {
    routePts = [];
    if (routeLine) { H.map.removeLayer(routeLine); routeLine = null; }
    if (routeMarks) { H.map.removeLayer(routeMarks); routeMarks = null; }
    const hud = document.getElementById('ppgisRouteHud');
    if (hud) hud.remove();
  }

  function showRouteHud() {
    let hud = document.getElementById('ppgisRouteHud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'ppgisRouteHud';
      document.querySelector('.map-wrap').appendChild(hud);
    }
    hud.innerHTML =
      `<span>${T('已點', 'points')} ${routePts.length}</span>` +
      `<button id="ppgisRouteUndo">${T('退一步', 'Undo')}</button>` +
      `<button id="ppgisRouteDone" ${routePts.length < 2 ? 'disabled' : ''}>${T('完成', 'Done')}</button>` +
      `<button id="ppgisRouteCancel">${T('取消', 'Cancel')}</button>`;
    document.getElementById('ppgisRouteUndo').onclick = () => {
      routePts.pop();
      if (routeMarks) { routeMarks.clearLayers(); routePts.forEach(p =>
        L.circleMarker(p, { radius: 4, color: '#0D9488', fillColor: '#fff', fillOpacity: 1, weight: 2 }).addTo(routeMarks)); }
      if (routeLine) routeLine.setLatLngs(routePts);
      showRouteHud();
    };
    document.getElementById('ppgisRouteCancel').onclick = () => { clearRoute(); setMode(null); };
    document.getElementById('ppgisRouteDone').onclick = openRouteForm;
  }

  function openRouteForm() {
    modal(
      T('這是我上學的路', 'This is how I get to school'),
      `<p class="ppgis-lede">${T('最後幾步會自動省略，保護你家的位置。',
                                 'The last stretch is trimmed automatically to protect your home location.')}</p>` +
      `<label class="ppgis-f"><span>${T('我怎麼去', 'How I travel')}</span><select id="prMode">` +
        `<option value="walk">${T('走路', 'Walk')}</option>` +
        `<option value="bike">${T('騎腳踏車', 'Bicycle')}</option>` +
        `<option value="scooter_pax">${T('坐機車後座', 'Pillion on a scooter')}</option>` +
        `<option value="car">${T('坐汽車', 'Car')}</option>` +
        `<option value="bus">${T('公車', 'Bus')}</option>` +
        `<option value="metro">${T('捷運／火車', 'Metro / train')}</option>` +
        `<option value="mixed">${T('好幾種', 'Mixed')}</option>` +
      `</select></label>` +
      `<label class="ppgis-f"><span>${T('有誰跟我一起', 'Who is with me')}</span><select id="prAcc">` +
        `<option value="alone">${T('我自己一個人', 'On my own')}</option>` +
        `<option value="with_peers">${T('跟同學', 'With classmates')}</option>` +
        `<option value="with_sibling">${T('跟兄弟姊妹', 'With a sibling')}</option>` +
        `<option value="with_adult">${T('有大人陪', 'With an adult')}</option>` +
        `<option value="driven">${T('大人接送', 'Driven by an adult')}</option>` +
      `</select></label>` +
      `<label class="ppgis-f"><span>${T('大概要多久（分鐘）', 'Roughly how long (min)')}</span>` +
        `<input type="number" id="prDur" min="1" max="120" placeholder="15"></label>` +
      `<label class="ppgis-f"><span>${T('多常這樣走', 'How often')}</span><select id="prFreq">` +
        `<option value="daily">${T('每天', 'Every day')}</option>` +
        `<option value="most_days">${T('大部分日子', 'Most days')}</option>` +
        `<option value="sometimes">${T('有時候', 'Sometimes')}</option>` +
        `<option value="rarely">${T('很少', 'Rarely')}</option>` +
      `</select></label>`,
      T('送出路徑', 'Submit route'),
      async () => {
        // 住家端最後 150 公尺裁掉：路徑起點是學校，所以從尾端往回裁
        const pts = trimTail(routePts, 150);
        if (pts.length < 2) return T('路徑太短了', 'Route is too short');
        try {
          const r = await P.submitRoute({
            coords: pts.map(p => [+p.lng.toFixed(6), +p.lat.toFixed(6)]),
            mode: document.getElementById('prMode').value,
            accompany: document.getElementById('prAcc').value,
            durationMin: +document.getElementById('prDur').value || null,
            frequency: document.getElementById('prFreq').value,
          });
          H.toast(r.queued ? T('📥 已存在這台裝置，稍後自動送出', '📥 Saved — will send later')
                           : T('✅ 謝謝你的通學路徑！', '✅ Thank you for your route!'));
          clearRoute(); setMode(null);
        } catch (e) { return T('送出失敗，請再試一次', 'Submit failed — please try again'); }
      });
  }

  // 從尾端（住家端）往回裁掉 metres 公尺
  function trimTail(pts, metres) {
    const out = pts.slice();
    let acc = 0;
    while (out.length > 2) {
      const a = out[out.length - 1], b = out[out.length - 2];
      acc += H.map.distance(a, b);
      out.pop();
      if (acc >= metres) break;
    }
    return out;
  }

  // ------------------------------------------------------------ 標註圖層
  async function toggleLayer() {
    const pill = document.getElementById('ppgisShow');
    if (layer) { H.map.removeLayer(layer); layer = null; pill.classList.remove('active'); return; }
    pill.classList.add('active');
    await refreshLayer();
  }

  async function refreshLayer() {
    try {
      const b = H.map.getBounds();
      const rows = await P.published({
        south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast(),
      }, 1500);
      if (layer) H.map.removeLayer(layer);
      layer = L.layerGroup();
      rows.forEach(r => {
        const col = r.valence === 'positive' ? '#16A34A' : r.valence === 'idea' ? '#4338CA' : '#DC2626';
        L.circleMarker([r.lat, r.lon], {
          radius: 5 + (r.severity || 3), color: '#fff', weight: 2,
          fillColor: col, fillOpacity: 0.85,
        }).bindTooltip(
          `<b>${r.icon || ''} ${esc(window.__LANG === 'en' ? r.label_en : r.label_zh)}</b>` +
          (r.body ? `<br>${esc(r.body)}` : '') +
          (r.road_name ? `<br><i>${esc(r.road_name)}</i>` : ''),
          { direction: 'top' }
        ).addTo(layer);
      });
      layer.addTo(H.map);
      H.toast(T(`👁 顯示 ${rows.length} 則標註`, `👁 ${rows.length} marks shown`));
    } catch (e) {
      H.toast(T('標註載入失敗', 'Could not load marks'));
    }
  }

  // ------------------------------------------------------------ 通用彈窗
  function modal(title, bodyHtml, okLabel, onOk) {
    const back = document.createElement('div');
    back.className = 'ppgis-modal-back';
    back.innerHTML =
      `<div class="ppgis-modal" role="dialog" aria-modal="true">` +
        `<div class="ppgis-modal-h"><b>${esc(title)}</b>` +
          `<button class="ppgis-x" aria-label="${T('關閉', 'Close')}">✕</button></div>` +
        `<div class="ppgis-modal-b">${bodyHtml}</div>` +
        `<div class="ppgis-modal-f"><span class="ppgis-err" id="ppgisErr"></span>` +
          `<button class="ppgis-ok">${esc(okLabel)}</button></div>` +
      `</div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector('.ppgis-x').addEventListener('click', close);
    back.addEventListener('click', e => { if (e.target === back) close(); });
    const ok = back.querySelector('.ppgis-ok');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      const err = await onOk();
      if (err) { document.getElementById('ppgisErr').textContent = err; ok.disabled = false; }
      else close();
    });
    return back;
  }

  // ------------------------------------------------------------ 進入點
  window.__ppgisInit = function (hooks) {
    H = hooks;
    buildBar();
    P.flush();
  };

  // 由 index.html 的地圖點擊路由呼叫；回傳 true = 已處理，不要再開街景
  window.__ppgisClick = function (e) {
    if (mode === 'annotate') { openAnnotation(e.latlng); return true; }
    if (mode === 'route') { addRoutePt(e.latlng); return true; }
    return false;
  };

  window.__ppgisRender = function () {
    const g = document.getElementById('ppgisGroup');
    if (g) { g.remove(); buildBar(); }
  };
})();
