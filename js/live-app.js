/*
 * Live dashboard: connects to the robot's NT4 server, reads the PowerMonitor
 * topics the on-robot MotorCurrentMonitor publishes, and renders them with the
 * same visual language as the sim. Read-only viewer — it never commands the robot.
 */
(function () {
  const $ = (id) => document.getElementById(id);

  // Bar scale per subsystem (matches the robot's group capacities); fallback 80 A.
  const BAR_MAX = {
    'Swerve Drive': 160, 'Swerve Steer': 100, 'Shooter': 100,
    'Feeder': 120, 'Intake': 60, 'Hood': 40, 'Turret': 30,
  };
  const PALETTE = ['#1179ee', '#00baff', '#33becc', '#f5b13d', '#a06bff', '#ff6b8a', '#7fd4a8', '#e0a92b'];

  const BUDGET = 90, CAUTION = 70, BREAKER = 120, LOW_V = 7.0, BROWNOUT_V = 6.8;

  // ---- live state, fed by NT ----
  const st = {
    busVoltage: null, motorTotal: 0, pdhTotal: undefined,
    soc: null, thermal: null, permissible: null, driveAlloc: null,
    brownouts: 0, status: 'GREEN',
    subs: new Map(),            // name -> amps
    minVoltage: Infinity, peak: 0,
  };
  let lastBrownouts = 0;
  const history = [];           // {t, a, v, brown, subs:{}}
  const brownoutTimes = [];
  const MAX_POINTS = 600;
  let startT = null, scrubIndex = null;

  const subColor = new Map();
  function colorFor(name) {
    if (!subColor.has(name)) subColor.set(name, PALETTE[subColor.size % PALETTE.length]);
    return subColor.get(name);
  }

  // ---- NT topic routing ----
  function onValue(fullName, value) {
    const name = fullName.replace(/^\/PowerMonitor\//, '');
    if (typeof value === 'number') {
      switch (name) {
        case 'BusVoltage': st.busVoltage = value; if (value < st.minVoltage) st.minVoltage = value; return;
        case 'MotorTotalCurrent': st.motorTotal = value; return;
        case 'PdhTotalCurrent': st.pdhTotal = value; return;
        case 'estimator/SOC': st.soc = value; return;
        case 'estimator/BreakerThermal': st.thermal = value; return;
        case 'finance/PermissibleTotalA': st.permissible = value; return;
        case 'finance/DriveAllocationA': st.driveAlloc = value; return;
        case 'BrownoutCount': st.brownouts = value; return;
      }
      if (name.startsWith('motor/')) st.subs.set(name.slice(6), value);
    } else if (typeof value === 'string' && name === 'Status') {
      st.status = value;
    }
  }

  // ---- connection ----
  let nt = null;
  function resolveHost(input) {
    const s = input.trim();
    if (/^\d{1,5}$/.test(s)) { // team number -> 10.TE.AM.2
      const t = s.padStart(4, '0');
      return `10.${parseInt(t.slice(0, 2), 10)}.${parseInt(t.slice(2), 10)}.2`;
    }
    return s;
  }
  $('nt-connect').addEventListener('click', () => {
    if (nt) { nt.disconnect(); nt = null; setStatus('offline'); $('nt-connect').textContent = 'Connect'; return; }
    const host = resolveHost($('nt-addr').value);
    nt = new PM.NT4(host, '/PowerMonitor', onValue, setStatus);
    startT = null; history.length = 0; brownoutTimes.length = 0;
    nt.connect();
  });

  function setStatus(state) {
    const pill = $('conn-status');
    const btn = $('nt-connect');
    if (state === 'live') {
      pill.textContent = 'LIVE'; pill.className = 'status-pill';
      $('dash').hidden = false; $('conn-hint').hidden = true; btn.textContent = 'Disconnect';
    } else if (state === 'connecting') {
      pill.textContent = 'CONNECTING'; pill.className = 'status-pill yellow'; btn.textContent = 'Cancel';
    } else { // closed / offline
      pill.textContent = nt ? 'RECONNECTING' : 'OFFLINE';
      pill.className = 'status-pill ' + (nt ? 'yellow' : 'offline');
    }
  }

  // ---- render loop ----
  setInterval(tick, 100);
  function tick() {
    if (!nt || st.busVoltage === null) return;
    const total = (st.pdhTotal !== undefined) ? st.pdhTotal : st.motorTotal;
    if (total > st.peak) st.peak = total;

    // record history
    const now = performance.now();
    if (startT === null) startT = now;
    if (st.brownouts > lastBrownouts) { brownoutTimes.push(now - startT); lastBrownouts = st.brownouts; }
    const subsSnap = {}; st.subs.forEach((a, n) => subsSnap[n] = a);
    history.push({ t: now - startT, a: total, v: st.busVoltage, subs: subsSnap });
    if (history.length > MAX_POINTS) history.shift();

    render(total);
  }

  function render(total) {
    // voltage
    $('voltage-value').textContent = st.busVoltage.toFixed(1);
    $('voltage-value').className = 'value ' + voltClass(st.busVoltage);
    $('min-voltage').textContent = isFinite(st.minVoltage) ? st.minVoltage.toFixed(1) : '–';
    $('soc').textContent = st.soc != null ? Math.round(st.soc * 100) : '–';

    // total current
    $('current-value').textContent = Math.round(total);
    $('current-value').className = 'value ' + curClass(total);
    $('current-fill').style.width = Math.min(100, total / BREAKER * 100) + '%';
    $('current-fill').style.background = colorSem(curClass(total));
    $('brownouts').textContent = st.brownouts;
    $('brownouts').className = 'tile-value bad' + (st.brownouts > 0 ? ' hit' : '');
    $('peak-current').textContent = Math.round(st.peak) + ' A';
    $('motor-total').textContent = Math.round(st.motorTotal) + ' A';

    // status pill mirrors robot status if present
    // estimator + finance
    if (st.soc != null) { $('soc-fill').style.width = (st.soc * 100) + '%'; $('soc-text').textContent = Math.round(st.soc * 100) + '%'; }
    if (st.thermal != null) { $('thermal-fill').style.width = Math.min(100, st.thermal * 100) + '%'; $('thermal-text').textContent = Math.round(Math.min(100, st.thermal * 100)) + '%'; }
    $('permissible-val').textContent = st.permissible != null ? Math.round(st.permissible) + ' A' : '– A';
    $('drivealloc-val').textContent = st.driveAlloc != null ? Math.round(st.driveAlloc) + ' A' : '– A';

    renderSubsystems();
    drawGraph();
    drawTimeline();
    drawBreakdown();
  }

  // ---- per-subsystem bars (built dynamically as topics appear) ----
  const subEls = new Map();
  function renderSubsystems() {
    const container = $('subsystems');
    const names = [...st.subs.keys()].sort();
    for (const name of names) {
      let e = subEls.get(name);
      if (!e) {
        const row = document.createElement('div');
        row.className = 'sub-row';
        row.innerHTML = `<span class="sub-name"></span><div class="sub-bar"><div class="sub-bar-fill"></div></div><span class="sub-amps">0.0 A</span>`;
        row.querySelector('.sub-name').textContent = name;
        container.appendChild(row);
        e = { row, fill: row.querySelector('.sub-bar-fill'), amps: row.querySelector('.sub-amps') };
        subEls.set(name, e);
      }
      const a = st.subs.get(name);
      const max = BAR_MAX[name] || 80;
      e.fill.style.width = Math.min(100, a / max * 100) + '%';
      e.fill.style.background = a > max * 0.9 ? 'var(--red)' : (a > max * 0.6 ? 'var(--yellow)' : colorFor(name));
      e.amps.textContent = a.toFixed(1) + ' A';
    }
  }

  // ---- graphs (reuse the sim's visual approach) ----
  const gctx = $('graph').getContext('2d');
  function drawGraph() {
    const c = $('graph'), w = c.width = c.clientWidth, h = c.height;
    gctx.clearRect(0, 0, w, h);
    if (history.length < 2) return;
    const pts = history.slice(-300);
    const stepX = w / 299, x0 = w - (pts.length - 1) * stepX;
    gctx.setLineDash([4, 4]); gctx.strokeStyle = 'rgba(255,77,94,0.4)';
    const yB = h - BUDGET / BREAKER * h; gctx.beginPath(); gctx.moveTo(0, yB); gctx.lineTo(w, yB); gctx.stroke();
    gctx.setLineDash([]);
    line(gctx, pts, (p) => p.a / BREAKER, x0, stepX, h, '#00baff', 1.5);
    line(gctx, pts, (p) => p.v / 13, x0, stepX, h, '#1179ee', 2);
  }
  function line(ctx, pts, f, x0, stepX, h, color, lw) {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
    pts.forEach((p, i) => { const x = x0 + i * stepX, y = h - Math.min(1, f(p)) * h; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }

  const tctx = $('timeline').getContext('2d');
  const TL_MAX_A = 200, TL_MAX_V = 13;
  function span() { return Math.max(history.length ? history[history.length - 1].t : 0, 30000); }
  function drawTimeline() {
    const c = $('timeline'), w = c.width = c.clientWidth, h = c.height;
    tctx.clearRect(0, 0, w, h);
    tctx.fillStyle = '#5f6b7a'; tctx.font = '10px -apple-system, sans-serif';
    tctx.strokeStyle = 'rgba(255,255,255,0.05)';
    [0, 50, 100, 150, 200].forEach((a) => { const y = h - a / TL_MAX_A * h; tctx.beginPath(); tctx.moveTo(30, y); tctx.lineTo(w, y); tctx.stroke(); tctx.fillText(a + 'A', 2, y + 3); });
    if (history.length < 2) return;
    const sp = span(), xOf = (t) => 30 + t / sp * (w - 30);
    tctx.fillStyle = 'rgba(255,77,94,0.25)';
    for (const bt of brownoutTimes) tctx.fillRect(xOf(bt) - 1, 0, 3, h);
    tctx.setLineDash([4, 4]); tctx.strokeStyle = 'rgba(255,77,94,0.45)';
    const yB = h - BUDGET / TL_MAX_A * h; tctx.beginPath(); tctx.moveTo(30, yB); tctx.lineTo(w, yB); tctx.stroke(); tctx.setLineDash([]);
    tlLine((p) => Math.min(TL_MAX_V, p.v) / TL_MAX_V, 'rgba(17,121,238,0.6)', 1, xOf, w, h);
    tlLine((p) => Math.min(TL_MAX_A, p.a) / TL_MAX_A, '#00baff', 1.6, xOf, w, h);
    const idx = activeIdx();
    if (idx != null) { const x = xOf(history[idx].t); tctx.strokeStyle = '#e8f2fb'; tctx.beginPath(); tctx.moveTo(x, 0); tctx.lineTo(x, h); tctx.stroke(); }
  }
  function tlLine(f, color, lw, xOf, w, h) {
    tctx.strokeStyle = color; tctx.lineWidth = lw; tctx.beginPath();
    history.forEach((p, i) => { const x = xOf(p.t), y = h - f(p) * h; i ? tctx.lineTo(x, y) : tctx.moveTo(x, y); });
    tctx.stroke();
  }
  function activeIdx() { if (scrubIndex != null && scrubIndex < history.length) return scrubIndex; return history.length ? history.length - 1 : null; }
  $('timeline').addEventListener('mousemove', (e) => {
    if (history.length < 2) return;
    const r = e.target.getBoundingClientRect(), frac = Math.max(0, Math.min(1, (e.clientX - r.left - 30) / (r.width - 30)));
    const t = frac * span(); let lo = 0, hi = history.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (history[m].t < t) lo = m + 1; else hi = m; }
    scrubIndex = lo;
  });
  $('timeline').addEventListener('mouseleave', () => { scrubIndex = null; });

  const pctx = $('breakdown-pie').getContext('2d');
  function drawBreakdown() {
    const idx = activeIdx(), sample = idx != null ? history[idx] : null;
    pctx.clearRect(0, 0, 180, 180);
    const parts = sample ? Object.entries(sample.subs).map(([n, a]) => ({ n, a })) : [];
    const total = parts.reduce((s, p) => s + p.a, 0);
    $('scrub-when').textContent = sample ? (scrubIndex != null ? '' : 'live · ') + (sample.t / 1000).toFixed(1) + 's' : 'live';
    $('scrub-total').textContent = sample ? Math.round(sample.a) : '–';
    const cx = 90, cy = 90, rad = 74;
    if (total < 0.5) { pctx.strokeStyle = '#22314e'; pctx.lineWidth = 2; pctx.beginPath(); pctx.arc(cx, cy, rad, 0, 6.283); pctx.stroke(); }
    else {
      let ang = -Math.PI / 2;
      for (const p of parts) { if (p.a <= 0) continue; const slice = p.a / total * 6.283; pctx.beginPath(); pctx.moveTo(cx, cy); pctx.arc(cx, cy, rad, ang, ang + slice); pctx.closePath(); pctx.fillStyle = colorFor(p.n); pctx.fill(); ang += slice; }
    }
    $('pie-legend').innerHTML = parts.sort((a, b) => b.a - a.a).map((p) =>
      `<li><span class="sw" style="background:${colorFor(p.n)}"></span><span class="nm">${p.n}</span><span class="amp">${p.a.toFixed(1)} A</span><span class="pct">${total > 0.5 ? Math.round(p.a / total * 100) : 0}%</span></li>`).join('');
  }

  // ---- helpers ----
  function voltClass(v) { return v < LOW_V ? 'red' : v < 9 ? 'yellow' : 'green'; }
  function curClass(a) { return a > BUDGET ? 'red' : a > CAUTION ? 'yellow' : 'green'; }
  function colorSem(c) { return c === 'red' ? 'var(--red)' : c === 'yellow' ? 'var(--yellow)' : 'var(--green)'; }
})();
