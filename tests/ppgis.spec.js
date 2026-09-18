const { chromium } = require('/tmp/claude-0/node_modules/playwright');
const fs = require('fs');

const LEAFLET_JS  = fs.readFileSync('/tmp/claude-0/vendor/dist/leaflet.js', 'utf8');
const LEAFLET_CSS = fs.readFileSync('/tmp/claude-0/vendor/dist/leaflet.css', 'utf8');

const calls = [];          // 記錄所有打到「Supabase」的請求
const fail = [];
function check(name, cond, extra) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fail.push(name);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  page.on('pageerror', e => { console.log('  [pageerror]', e.message); fail.push('pageerror: ' + e.message); });
  page.on('console', m => { if (m.type()==='error' && !/ERR_FAILED|Unrecognized feature/.test(m.text())) console.log('  [console]', m.text()); });

  // Leaflet / 字型 / 圖磚 → 本地或空回應
  await page.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: LEAFLET_JS }));
  await page.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.css', r =>
    r.fulfill({ contentType: 'text/css', body: LEAFLET_CSS }));
  await page.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**://*.basemaps.cartocdn.com/**', r => r.abort());
  await page.route('**://*.tile.openstreetmap.org/**', r => r.abort());
  await page.route('**://maps.googleapis.com/**', r => r.abort());

  // 填入假的 PPGIS 設定
  await page.route('**/data/ppgis_config.js*', r => r.fulfill({
    contentType: 'application/javascript',
    body: `window.PPGIS_CONFIG={url:'https://test.supabase.co',anonKey:'anon-test-key'};`,
  }));

  // 模擬 Supabase
  await page.route('**://test.supabase.co/**', async (route, req) => {
    const url = req.url(); const body = req.postData();
    calls.push({ url, method: req.method(), body: body ? JSON.parse(body) : null });
    const json = (o) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('/rpc/join_workshop'))
      return json([{ token: '11111111-2222-3333-4444-555555555555', pseudonym: '石虎-A1B2',
                     workshop_id: 'ws-1', workshop_title: '中寮國小通學路工作坊',
                     school_code: 'abc123', school_name: '南投縣中寮鄉中寮國民小學' }]);
    if (url.includes('/rpc/record_consent'))    return json(null);
    if (url.includes('/rpc/submit_annotation')) return json('annot-uuid-1');
    if (url.includes('/rpc/submit_route'))      return json('route-uuid-1');
    if (url.includes('annotation_kinds'))
      return json([
        { key:'scary_crossing', valence:'negative', label_zh:'這個路口我不敢過', label_en:'Scary crossing', icon:'😨', sort_order:10 },
        { key:'no_sidewalk',    valence:'negative', label_zh:'沒有人行道',       label_en:'No sidewalk',    icon:'🚧', sort_order:20 },
        { key:'fun_place',      valence:'positive', label_zh:'這裡很好玩',       label_en:'Fun place',      icon:'🛝', sort_order:120 },
        { key:'idea',           valence:'idea',     label_zh:'我想把這裡改成…',  label_en:'My idea',        icon:'💡', sort_order:170 },
      ]);
    if (url.includes('v_annotations_public'))
      return json([{ id:'a1', lat:23.96, lon:120.77, kind:'scary_crossing', valence:'negative',
                     label_zh:'這個路口我不敢過', label_en:'Scary crossing', icon:'😨', severity:4,
                     body:'轉彎車不看人', road_name:'中寮路' }]);
    return json([]);
  });

  console.log('\n— 載入頁面 —');
  await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  check('PPGIS 客戶端已設定', await page.evaluate(() => !!(window.PPGIS && window.PPGIS.configured)));
  check('地圖掛勾已匯出',     await page.evaluate(() => !!(window.__mapHooks && window.__mapHooks.map)));
  check('公民科學工具列出現', await page.locator('#ppgisGroup').count() === 1);
  check('三個按鈕齊備',
        await page.locator('#ppgisAnnotate').count() === 1 &&
        await page.locator('#ppgisRoute').count() === 1 &&
        await page.locator('#ppgisShow').count() === 1);
  check('未加入時顯示提示', (await page.locator('#ppgisWho').innerText()).includes('尚未加入'));

  console.log('\n— 加入工作坊 —');
  await page.click('#ppgisAnnotate');
  await page.waitForTimeout(300);
  check('跳出加入工作坊彈窗', await page.locator('.ppgis-modal').count() === 1);

  await page.click('.ppgis-ok');   // 空白送出
  await page.waitForTimeout(200);
  check('未填代碼會擋下', (await page.locator('#ppgisErr').innerText()).includes('請輸入代碼'));

  await page.fill('#pjCode', 'ab12cd');
  await page.click('.ppgis-ok');
  await page.waitForTimeout(200);
  check('未勾同意會擋下', (await page.locator('#ppgisErr').innerText()).includes('同意'));

  await page.check('#pjConsent');
  await page.selectOption('#pjRole', 'student');
  await page.selectOption('#pjGrade', '4');
  await page.click('.ppgis-ok');
  await page.waitForTimeout(600);

  const join = calls.find(c => c.url.includes('join_workshop'));
  check('送出 join_workshop', !!join);
  check('代碼原樣送出（伺服器端不分大小寫）', join && join.body.p_join_code === 'ab12cd', join && join.body.p_join_code);
  check('角色與年級帶上',    join && join.body.p_role === 'student' && join.body.p_grade_year === 4);
  check('裝置雜湊為 SHA-256', join && /^[0-9a-f]{64}$/.test(join.body.p_device_hash || ''));
  check('未送出姓名或 email',
        join && !JSON.stringify(join.body).match(/name|email|@/i), join && JSON.stringify(join.body));
  check('記錄同意',          calls.some(c => c.url.includes('record_consent')));
  check('顯示化名',          (await page.locator('#ppgisWho').innerText()).includes('石虎-A1B2'));
  check('彈窗已關閉',        await page.locator('.ppgis-modal').count() === 0);
  check('標註模式已啟用',    await page.locator('#ppgisAnnotate.active').count() === 1);

  console.log('\n— 標註 —');
  const clickMap = (x, y) => page.locator('#segmap').click({ position: { x, y } });
  await clickMap(500, 300);
  await page.waitForTimeout(700);
  check('點地圖開出標註表單', await page.locator('.ppgis-modal').count() === 1);
  check('三種語彙分組都在',   await page.locator('.ppgis-kgroup').count() === 3);
  check('類別選項渲染出來',   await page.locator('.ppgis-kind').count() === 4);

  await page.click('.ppgis-ok');
  await page.waitForTimeout(200);
  check('未選類別會擋下', (await page.locator('#ppgisErr').innerText()).includes('選一個類別'));

  await page.click('.ppgis-kind[data-k="fun_place"]');
  await page.waitForTimeout(150);
  check('選正向時問法改變', (await page.locator('#ppSevLabel').innerText()).includes('喜歡'));

  await page.click('.ppgis-kind[data-k="scary_crossing"]');
  await page.fill('#ppBody', '轉彎車都不看人');
  await page.click('.ppgis-ok');
  await page.waitForTimeout(600);

  const sub = calls.find(c => c.url.includes('submit_annotation'));
  check('送出 submit_annotation', !!sub);
  check('帶上憑證而非參與者 id', sub && sub.body.p_token === '11111111-2222-3333-4444-555555555555');
  check('類別正確',   sub && sub.body.p_kind === 'scary_crossing');
  check('內文正確',   sub && sub.body.p_body === '轉彎車都不看人');
  check('座標在台灣範圍', sub && sub.body.p_lat > 21.5 && sub.body.p_lat < 26.5 &&
                          sub.body.p_lon > 118 && sub.body.p_lon < 122.5,
        sub && `${sub.body.p_lat}, ${sub.body.p_lon}`);
  check('標註彈窗已關閉', await page.locator('.ppgis-modal').count() === 0);

  console.log('\n— 顯示大家的標註 —');
  await page.click('#ppgisShow');
  await page.waitForTimeout(700);
  check('查詢已發布標註', calls.some(c => c.url.includes('v_annotations_public')));
  const q = calls.find(c => c.url.includes('v_annotations_public'));
  check('查詢帶上 bbox 範圍限制', q && q.url.includes('lat=gte.') && q.url.includes('lon=lte.'), q && decodeURIComponent(q.url.split('?')[1] || '').slice(0, 110));

  console.log('\n— 畫通學路徑 —');
  await page.click('#ppgisRoute');
  await page.waitForTimeout(300);
  for (let i = 0; i < 5; i++) {
    await clickMap(300 + i * 40, 200 + i * 30);
    await page.waitForTimeout(120);
  }
  check('路徑 HUD 出現', await page.locator('#ppgisRouteHud').count() === 1);
  check('點數計算正確', (await page.locator('#ppgisRouteHud').innerText()).includes('5'));

  await page.click('#ppgisRouteDone');
  await page.waitForTimeout(300);
  check('開出路徑表單', await page.locator('#prMode').count() === 1);
  await page.selectOption('#prAcc', 'alone');
  await page.selectOption('#prMode', 'walk');
  await page.fill('#prDur', '12');
  await page.click('.ppgis-ok');
  await page.waitForTimeout(600);

  const rt = calls.find(c => c.url.includes('submit_route'));
  check('送出 submit_route', !!rt);
  check('獨立性欄位帶上', rt && rt.body.p_accompany === 'alone');
  check('座標為 [lng,lat] 陣列', rt && Array.isArray(rt.body.p_coords) &&
        rt.body.p_coords[0].length === 2 && rt.body.p_coords[0][0] > 118);
  check('住家端已裁短（5 點 → 較少）', rt && rt.body.p_coords.length < 5,
        rt && `${rt.body.p_coords.length} 點`);

  console.log('\n— 離線佇列 —');
  await page.context().setOffline(true);
  await page.click('#ppgisAnnotate');
  await page.waitForTimeout(200);
  await clickMap(560, 340);
  await page.waitForTimeout(600);
  await page.click('.ppgis-kind[data-k="no_sidewalk"]');
  await page.click('.ppgis-ok');
  await page.waitForTimeout(600);
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('ppgis_queue_v1') || '[]'));
  check('離線時存入佇列', queued.length === 1 && queued[0].fn === 'submit_annotation',
        `佇列 ${queued.length} 筆`);
  check('工具列顯示待送數', (await page.locator('#ppgisWho').innerText()).includes('⏳'));

  const before = calls.length;
  await page.context().setOffline(false);
  await page.evaluate(() => window.PPGIS.flush());
  await page.waitForTimeout(800);
  check('恢復連線後自動補送', calls.length > before &&
        calls.slice(before).some(c => c.url.includes('submit_annotation')));
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('ppgis_queue_v1') || '[]'));
  check('佇列已清空', after.length === 0, `剩 ${after.length} 筆`);

  console.log('\n— 未設定後端時應完全靜默 —');
  const p2 = await browser.newPage();
  const errs2 = [];
  p2.on('pageerror', e => errs2.push(e.message));
  await p2.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: LEAFLET_JS }));
  await p2.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.css', r =>
    r.fulfill({ contentType: 'text/css', body: LEAFLET_CSS }));
  await p2.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await p2.route('**://*.basemaps.cartocdn.com/**', r => r.abort());
  await p2.route('**://maps.googleapis.com/**', r => r.abort());
  // 明確注入空設定（正式設定檔已填好真實後端，不能靠磁碟上的內容判斷）
  await p2.route('**/data/ppgis_config.js*', r => r.fulfill({
    contentType: 'application/javascript',
    body: `window.PPGIS_CONFIG={url:'',anonKey:''};`,
  }));
  await p2.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1200);
  check('未設定時不出現工具列', await p2.locator('#ppgisGroup').count() === 0);
  check('未設定時地圖仍正常',   await p2.evaluate(() => !!(window.__mapHooks && window.__mapHooks.map)));
  check('未設定時無 JS 錯誤',   errs2.length === 0, errs2.join(' | '));

  await browser.close();
  console.log(`\n${fail.length ? '✗ ' + fail.length + ' 項失敗:\n   - ' + fail.join('\n   - ') : '✓ 全部通過'}`);
  process.exit(fail.length ? 1 : 0);
})();
