/*
 * Main app: wires the DOM dashboard to the simulation + load-shedder, runs the
 * 50 Hz loop, draws the voltage/current history graph, emits rate-limited
 * driver-station alerts, and records a downloadable match log (the DataLog).
 */
(function () {
  const sim = new PM.Simulation();
  const shedder = new PM.LoadShedder();

  // Battery estimator, breaker thermal model, and the finance department that
  // allocates drive current from their forward projections.
  let battery, breaker, finance;
  function initModels() {
    battery = new PM.BatteryEstimator(18, 1.0, sim.batteryAge);
    breaker = new PM.BreakerThermalModel(PM.Budget.MAIN_BREAKER_AMPS, 40);
    finance = new PM.FinanceDepartment(battery, breaker);
    finance.enabled = $('toggle-finance') ? $('toggle-finance').checked : true;
  }

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const el = {
    clock: $('clock'), statusPill: $('status-pill'),
    voltage: $('voltage-value'), minVoltage: $('min-voltage'), soc: $('soc'),
    current: $('current-value'), currentFill: $('current-fill'),
    brownouts: $('brownouts'), peakCurrent: $('peak-current'),
    subsystems: $('subsystems'), driveChips: $('drive-chips'), alerts: $('alerts'),
    graph: $('graph'),
    socFill: $('soc-fill'), socText: $('soc-text'), ocv: $('ocv-val'), r0: $('r0-val'),
    predv: $('predv-val'), measv: $('measv-val'),
    thermalFill: $('thermal-fill'), thermalText: $('thermal-text'),
    permissible: $('permissible-val'), drivealloc: $('drivealloc-val'),
    timeline: $('timeline'), breakdownPie: $('breakdown-pie'), pieLegend: $('pie-legend'),
    scrubWhen: $('scrub-when'), scrubTotal: $('scrub-total'),
  };
  initModels();

  // Per-subsystem colors for the breakdown pie + legend.
  const SUB_COLORS = {
    drivetrain: '#4d7ab8', shooter: '#f2b705', intake: '#2ea043',
    climber: '#c9518a', indexer: '#8b5cf6', turret: '#e07a3f',
  };

  // ---- Build per-subsystem bars ----
  const subEls = {};
  for (const s of PM.SUBSYSTEMS) {
    const row = document.createElement('div');
    row.className = 'sub-row';
    row.dataset.key = s.key;
    row.innerHTML =
      `<span class="sub-name">${s.label}<span class="shed-badge">SHED</span></span>` +
      `<div class="sub-bar"><div class="sub-bar-fill"></div><div class="limit-tick"></div></div>` +
      `<span class="sub-amps">0.0 A</span>`;
    el.subsystems.appendChild(row);
    subEls[s.key] = {
      row, fill: row.querySelector('.sub-bar-fill'),
      tick: row.querySelector('.limit-tick'), amps: row.querySelector('.sub-amps'),
    };
  }

  // ---- Load chips: click to drive a subsystem at a sustained preset ----
  // Levels chosen so stacking a few pushes total over the 90 A budget and makes
  // the load-shedder engage (and stay engaged) so you can watch it work.
  const DRIVE_PRESET = {
    drivetrain: 0.6, climber: 1.0, shooter: 1.0, intake: 1.0, indexer: 1.0, turret: 1.0,
  };
  const chipEls = {};
  for (const s of PM.SUBSYSTEMS) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = s.label;
    chip.addEventListener('click', () => {
      const on = !chip.classList.contains('active');
      chip.classList.toggle('active', on);
      if (on && !running) btnStart.click();          // auto-start the match
      sim.setDemand(s.key, on ? DRIVE_PRESET[s.key] : 0);
    });
    el.driveChips.appendChild(chip);
    chipEls[s.key] = chip;
  }
  const clearChip = document.createElement('button');
  clearChip.className = 'chip chip-clear';
  clearChip.textContent = 'Clear all';
  clearChip.addEventListener('click', () => {
    for (const s of PM.SUBSYSTEMS) { sim.setDemand(s.key, 0); chipEls[s.key].classList.remove('active'); }
  });
  el.driveChips.appendChild(clearChip);

  // ---- Match clock / run state ----
  let running = false;
  let matchTimeMs = 0;
  const btnStart = $('btn-start');
  btnStart.addEventListener('click', () => {
    running = !running;
    btnStart.textContent = running ? 'Pause' : 'Start';
    btnStart.classList.toggle('btn-primary', !running);
  });
  $('btn-reset').addEventListener('click', () => {
    sim.reset(); shedder.reset(); initModels();
    matchTimeMs = 0; running = false;
    btnStart.textContent = 'Start'; btnStart.classList.add('btn-primary');
    for (const s of PM.SUBSYSTEMS) { sim.setDemand(s.key, 0); chipEls[s.key].classList.remove('active'); }
    logRows.length = 0; history.length = 0; matchHistory.length = 0;
    peakCurrent = 0; scrubIndex = null;
    el.alerts.innerHTML = '<li class="empty">No alerts.</li>';
  });

  // ---- Worst-case stress test (§5) ----
  $('btn-stress').addEventListener('click', () => {
    if (!running) btnStart.click();
    const burst = { drivetrain: 0.95, shooter: 1.0, intake: 0.9, climber: 1.0 };
    for (const k in burst) sim.setDemand(k, burst[k]);
    setTimeout(() => {
      for (const k in burst) sim.setDemand(k, 0);
    }, 1800);
  });

  $('toggle-shed').addEventListener('change', (e) => { shedder.enabled = e.target.checked; });
  $('toggle-finance').addEventListener('change', (e) => { finance.enabled = e.target.checked; });
  const ageSlider = $('battery-age');
  ageSlider.addEventListener('input', () => {
    sim.batteryAge = ageSlider.value / 100;
    battery.ageFactor = sim.batteryAge; // estimator tracks the same modeled age
    $('battery-age-val').textContent = (sim.batteryAge).toFixed(2);
  });
  $('btn-clear-alerts').addEventListener('click', () => { el.alerts.innerHTML = '<li class="empty">No alerts.</li>'; });
  $('btn-export').addEventListener('click', exportCsv);

  // ---- Alerts (rate-limited, like DriverStation.reportWarning throttling) ----
  const lastAlert = {};
  function alert(key, msg, level) {
    const now = performance.now();
    if (lastAlert[key] && now - lastAlert[key] < 1500) return;
    lastAlert[key] = now;
    const empty = el.alerts.querySelector('.empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = level;
    li.innerHTML = `<span class="t">${fmtClock(matchTimeMs)}</span>${msg}`;
    el.alerts.insertBefore(li, el.alerts.firstChild);
    while (el.alerts.children.length > 40) el.alerts.removeChild(el.alerts.lastChild);
  }

  // ---- History for graph + CSV log ----
  const history = [];      // {v, a} recent points for the rolling live graph
  const MAX_POINTS = 300;
  const logRows = [];      // full match log for CSV export
  let logDecim = 0;

  // ---- Full-match history for the timeline + scrubbable breakdown pie ----
  const matchHistory = [];   // {t, v, a, brown, subs:{key:amps}} for the whole match
  let peakCurrent = 0;
  let scrubIndex = null;     // hovered sample index, or null = live (latest)

  // ---- Main loop @ 50 Hz ----
  setInterval(tick, PM.LOOP_MS);

  function tick() {
    if (running) matchTimeMs += PM.LOOP_MS;

    const dt = PM.LOOP_MS / 1000;

    // Update the estimator + breaker model from last loop's measured values, then
    // let the finance department recompute the drivetrain's dynamic allocation.
    battery.update(sim.busVoltage, sim.totalCurrent, dt);
    breaker.update(sim.totalCurrent, dt);
    let driveLimit = null;
    if (finance.enabled) {
      let reserved = 0;
      for (const s of PM.SUBSYSTEMS) if (s.key !== 'drivetrain') reserved += sim.subsystemCurrent(s.key);
      driveLimit = finance.allocate(reserved);
    }

    shedder.update(sim.totalCurrent, PM.SUBSYSTEMS);
    const r = sim.step(shedder, driveLimit);

    render(r);
    renderEstimator(r);
    runAlerts(r);
    recordHistory(r);
  }

  function render(r) {
    el.clock.textContent = fmtClock(matchTimeMs);

    // Voltage readout + color.
    el.voltage.textContent = r.busVoltage.toFixed(1);
    el.voltage.className = 'value ' + voltClass(r.busVoltage);
    el.minVoltage.textContent = r.minVoltage.toFixed(1);
    el.soc.textContent = Math.round(r.soc * 100);

    // Total current readout + meter.
    el.current.textContent = Math.round(r.totalCurrent);
    el.current.className = 'value ' + currentClass(r.totalCurrent);
    const pct = Math.min(100, (r.totalCurrent / PM.Budget.MAIN_BREAKER_AMPS) * 100);
    el.currentFill.style.width = pct + '%';
    el.currentFill.style.background = colorFor(currentClass(r.totalCurrent));

    // Status pill.
    const st = overallStatus(r);
    el.statusPill.textContent = st.toUpperCase();
    el.statusPill.className = 'status-pill ' + (st === 'green' ? '' : st);

    // Tiles.
    el.brownouts.textContent = r.brownoutCount;
    el.brownouts.className = 'tile-value bad' + (r.brownoutCount > 0 ? ' hit' : '');
    el.peakCurrent.textContent = Math.round(peakCurrent) + ' A';
    el.peakCurrent.className = 'tile-value ' + currentClass(peakCurrent);

    // Per-subsystem bars.
    for (const s of PM.SUBSYSTEMS) {
      const cur = sim.subsystemCurrent(s.key);
      const e = subEls[s.key];
      const barPct = Math.min(100, (cur / s.breaker) * 100);
      e.fill.style.width = barPct + '%';
      const warn = cur > s.breaker * PM.BREAKER_WARN_FRACTION;
      const shed = shedder.shed.has(s.key);
      e.fill.style.background = warn ? 'var(--red)' : (cur > s.breaker * 0.6 ? 'var(--yellow)' : 'var(--green)');
      e.tick.style.left = Math.min(100, (shedder.effectiveLimit(s) / s.breaker) * 100) + '%';
      e.amps.textContent = cur.toFixed(1) + ' A';
      e.row.classList.toggle('shed', shed);
    }
  }

  // ---- Battery estimator + finance panel ----
  function renderEstimator(r) {
    const soc = battery.soc;
    el.socFill.style.width = (soc * 100) + '%';
    el.socText.textContent = Math.round(soc * 100) + '%';
    el.ocv.textContent = battery.ocv(soc).toFixed(2) + ' V';
    el.r0.textContent = battery.seriesResistance().toFixed(3) + ' Ω';
    el.predv.textContent = battery.predictedVoltage.toFixed(2) + ' V';
    el.measv.textContent = r.busVoltage.toFixed(2) + ' V';

    const theta = breaker.thermalState();
    el.thermalFill.style.width = Math.min(100, theta * 100) + '%';
    el.thermalText.textContent = Math.round(Math.min(100, theta * 100)) + '%';

    el.permissible.textContent = finance.enabled ? Math.round(finance.permissibleTotal) + ' A' : '—';
    el.drivealloc.textContent = finance.enabled ? Math.round(finance.driveAllocation) + ' A' : 'static 240 A';
  }

  // ---- Match timeline (full-match current + brownouts, hover to scrub) ----
  const tlCtx = el.timeline.getContext('2d');
  const pieCtx = el.breakdownPie.getContext('2d');
  const TL_MAX_A = 260;   // current axis top (covers inrush spikes)
  const TL_MAX_V = 13;

  function timeSpanMs() { return Math.max(matchTimeMs, 30000); } // grow window, min 30 s

  function drawTimeline() {
    const w = el.timeline.width = el.timeline.clientWidth;
    const h = el.timeline.height;
    tlCtx.clearRect(0, 0, w, h);
    const span = timeSpanMs();

    // gridlines + current axis labels
    tlCtx.fillStyle = '#5f6b7a'; tlCtx.font = '10px ui-monospace, monospace';
    tlCtx.strokeStyle = 'rgba(255,255,255,0.05)'; tlCtx.lineWidth = 1;
    [0, 60, 120, 180, 240].forEach((a) => {
      const y = h - (a / TL_MAX_A) * h;
      tlCtx.beginPath(); tlCtx.moveTo(30, y); tlCtx.lineTo(w, y); tlCtx.stroke();
      tlCtx.fillText(a + 'A', 2, y + 3);
    });

    if (matchHistory.length < 2) return;
    const xOf = (t) => 30 + (t / span) * (w - 30);

    // brownout bands (red verticals)
    tlCtx.fillStyle = 'rgba(248,81,73,0.22)';
    for (const p of matchHistory) if (p.brown) tlCtx.fillRect(xOf(p.t), 0, Math.max(1, (w - 30) / span * PM.LOOP_MS), h);

    // 90A budget line
    tlCtx.strokeStyle = 'rgba(248,81,73,0.45)'; tlCtx.setLineDash([4, 4]);
    const yB = h - (PM.Budget.TOTAL_CURRENT_BUDGET_AMPS / TL_MAX_A) * h;
    tlCtx.beginPath(); tlCtx.moveTo(30, yB); tlCtx.lineTo(w, yB); tlCtx.stroke();
    tlCtx.setLineDash([]);

    // bus voltage (faint blue, its own scale)
    tlCtx.strokeStyle = 'rgba(88,166,255,0.5)'; tlCtx.lineWidth = 1;
    tlCtx.beginPath();
    matchHistory.forEach((p, i) => { const x = xOf(p.t), y = h - (Math.min(TL_MAX_V, p.v) / TL_MAX_V) * h; i ? tlCtx.lineTo(x, y) : tlCtx.moveTo(x, y); });
    tlCtx.stroke();

    // total current (gold, prominent)
    tlCtx.strokeStyle = '#f2b705'; tlCtx.lineWidth = 1.6;
    tlCtx.beginPath();
    matchHistory.forEach((p, i) => { const x = xOf(p.t), y = h - (Math.min(TL_MAX_A, p.a) / TL_MAX_A) * h; i ? tlCtx.lineTo(x, y) : tlCtx.moveTo(x, y); });
    tlCtx.stroke();

    // scrub cursor
    const idx = activeIndex();
    if (idx != null && matchHistory[idx]) {
      const x = xOf(matchHistory[idx].t);
      tlCtx.strokeStyle = '#e6edf3'; tlCtx.lineWidth = 1;
      tlCtx.beginPath(); tlCtx.moveTo(x, 0); tlCtx.lineTo(x, h); tlCtx.stroke();
    }
  }

  function activeIndex() {
    if (scrubIndex != null && scrubIndex < matchHistory.length) return scrubIndex;
    return matchHistory.length ? matchHistory.length - 1 : null;
  }

  function drawBreakdown() {
    const idx = activeIndex();
    const sample = idx != null ? matchHistory[idx] : null;
    const cx = 90, cy = 90, rad = 74;
    pieCtx.clearRect(0, 0, 180, 180);

    const parts = PM.SUBSYSTEMS.map((s) => ({ key: s.key, label: s.label, a: sample ? sample.subs[s.key] : 0 }));
    const total = parts.reduce((sum, p) => sum + p.a, 0);

    // scrub readout
    if (sample) {
      el.scrubWhen.textContent = (scrubIndex != null ? '' : 'live · ') + fmtClock(sample.t);
      el.scrubTotal.textContent = Math.round(sample.a);
    } else {
      el.scrubWhen.textContent = 'live'; el.scrubTotal.textContent = 0;
    }

    if (total < 0.5) {
      pieCtx.strokeStyle = '#2a3240'; pieCtx.lineWidth = 2;
      pieCtx.beginPath(); pieCtx.arc(cx, cy, rad, 0, Math.PI * 2); pieCtx.stroke();
    } else {
      let ang = -Math.PI / 2;
      for (const p of parts) {
        if (p.a <= 0) continue;
        const slice = (p.a / total) * Math.PI * 2;
        pieCtx.beginPath(); pieCtx.moveTo(cx, cy);
        pieCtx.arc(cx, cy, rad, ang, ang + slice); pieCtx.closePath();
        pieCtx.fillStyle = SUB_COLORS[p.key]; pieCtx.fill();
        ang += slice;
      }
    }

    // legend
    el.pieLegend.innerHTML = parts
      .map((p) => `<li><span class="sw" style="background:${SUB_COLORS[p.key]}"></span>` +
        `<span class="nm">${p.label}</span>` +
        `<span class="amp">${p.a.toFixed(1)} A</span>` +
        `<span class="pct">${total > 0.5 ? Math.round((p.a / total) * 100) : 0}%</span></li>`)
      .join('');
  }

  // Hover the timeline to scrub; leave to return to live.
  el.timeline.addEventListener('mousemove', (e) => {
    if (matchHistory.length < 2) return;
    const rect = el.timeline.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, (x - 30) / (rect.width - 30)));
    const t = frac * timeSpanMs();
    // nearest sample by time
    let lo = 0, hi = matchHistory.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (matchHistory[mid].t < t) lo = mid + 1; else hi = mid; }
    scrubIndex = lo;
  });
  el.timeline.addEventListener('mouseleave', () => { scrubIndex = null; });

  function runAlerts(r) {
    if (r.brownedOut) alert('brownout', `BROWNOUT #${r.brownoutCount} — bus ${r.busVoltage.toFixed(1)} V`, 'error');
    if (r.busVoltage < PM.Budget.LOW_VOLTAGE_WARNING && !r.brownedOut)
      alert('lowv', `Low bus voltage ${r.busVoltage.toFixed(1)} V — brownout risk`, 'warn');
    if (r.totalCurrent > PM.Budget.TOTAL_CURRENT_BUDGET_AMPS)
      alert('budget', `Total current ${Math.round(r.totalCurrent)} A — approaching budget`, 'warn');
    for (const s of PM.SUBSYSTEMS) {
      const cur = sim.subsystemCurrent(s.key);
      if (cur > s.breaker * PM.BREAKER_WARN_FRACTION)
        alert('brk-' + s.key, `${s.label} ${cur.toFixed(0)} A near ${s.breaker} A breaker`, 'warn');
    }
    if (shedder.isShedding())
      alert('shed', `Load-shedding active: ${[...shedder.shed].map((k)=>PM.SUBSYSTEMS.find(s=>s.key===k).label).join(', ')}`, 'warn');
    const theta = breaker.thermalState();
    if (theta >= 1.0) alert('brk-trip', `MAIN BREAKER thermal ${Math.round(theta*100)}% — TRIP imminent`, 'error');
    else if (theta > 0.85) alert('brk-hot', `Main breaker thermal ${Math.round(theta*100)}% — trip risk`, 'warn');
  }

  function recordHistory(r) {
    history.push({ v: r.busVoltage, a: r.totalCurrent });
    if (history.length > MAX_POINTS) history.shift();
    drawGraph();

    // Full-match timeline sample (only while the match is running).
    if (running) {
      if (r.totalCurrent > peakCurrent) peakCurrent = r.totalCurrent;
      const subs = {};
      for (const s of PM.SUBSYSTEMS) subs[s.key] = sim.subsystemCurrent(s.key);
      matchHistory.push({ t: matchTimeMs, v: r.busVoltage, a: r.totalCurrent, brown: r.brownedOut, subs });
    }
    drawTimeline();
    drawBreakdown();

    if (running && (logDecim++ % 5 === 0)) { // ~10 Hz log
      const row = [(matchTimeMs / 1000).toFixed(2), r.busVoltage.toFixed(2), r.totalCurrent.toFixed(1)];
      for (const s of PM.SUBSYSTEMS) row.push(sim.subsystemCurrent(s.key).toFixed(1));
      row.push(battery.soc.toFixed(4), breaker.thermalState().toFixed(4),
               finance.permissibleTotal.toFixed(1), finance.driveAllocation.toFixed(1),
               r.brownedOut ? 1 : 0);
      logRows.push(row);
    }
  }

  // ---- Graph (dual axis: voltage 0-13, current 0-120) ----
  const ctx = el.graph.getContext('2d');
  function drawGraph() {
    const w = el.graph.width = el.graph.clientWidth;
    const h = el.graph.height;
    ctx.clearRect(0, 0, w, h);
    if (history.length < 2) return;

    // 90A budget line (mapped on current axis).
    ctx.strokeStyle = 'rgba(248,81,73,0.4)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    const yBudget = h - (PM.Budget.TOTAL_CURRENT_BUDGET_AMPS / 120) * h;
    ctx.beginPath(); ctx.moveTo(0, yBudget); ctx.lineTo(w, yBudget); ctx.stroke();
    // Dynamic finance permissible-total line (green) — the estimator's live budget.
    if (finance && finance.enabled) {
      ctx.strokeStyle = 'rgba(46,160,67,0.7)';
      const yPerm = h - (Math.min(120, finance.permissibleTotal) / 120) * h;
      ctx.beginPath(); ctx.moveTo(0, yPerm); ctx.lineTo(w, yPerm); ctx.stroke();
    }
    // 6.8V brownout line (voltage axis).
    ctx.strokeStyle = 'rgba(210,153,34,0.35)';
    const yBrown = h - (PM.Budget.BROWNOUT_VOLTAGE / 13) * h;
    ctx.beginPath(); ctx.moveTo(0, yBrown); ctx.lineTo(w, yBrown); ctx.stroke();
    ctx.setLineDash([]);

    const stepX = w / (MAX_POINTS - 1);
    const x0 = w - (history.length - 1) * stepX;

    // current (gold)
    ctx.strokeStyle = '#f2b705'; ctx.lineWidth = 1.5; ctx.beginPath();
    history.forEach((p, i) => {
      const x = x0 + i * stepX, y = h - Math.min(1, p.a / 120) * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();

    // voltage (blue)
    ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 2; ctx.beginPath();
    history.forEach((p, i) => {
      const x = x0 + i * stepX, y = h - Math.min(1, p.v / 13) * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  // ---- CSV export (the "DataLog") ----
  function exportCsv() {
    const header = ['time_s', 'busV', 'totalA', ...PM.SUBSYSTEMS.map((s) => s.key + '_A'),
      'soc', 'breakerThermal', 'permissibleA', 'driveAllocA', 'brownout'];
    const lines = [header.join(','), ...logRows.map((r) => r.join(','))];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `match-power-log-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- Helpers ----
  function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function voltClass(v) {
    if (v < PM.Budget.LOW_VOLTAGE_WARNING) return 'red';
    if (v < 9.0) return 'yellow';
    return 'green';
  }
  function currentClass(a) {
    if (a > PM.Budget.TOTAL_CURRENT_BUDGET_AMPS) return 'red';
    if (a > PM.Budget.TOTAL_CURRENT_CAUTION_AMPS) return 'yellow';
    return 'green';
  }
  function overallStatus(r) {
    if (r.busVoltage < PM.Budget.LOW_VOLTAGE_WARNING || r.totalCurrent > PM.Budget.TOTAL_CURRENT_BUDGET_AMPS) return 'red';
    if (r.totalCurrent > PM.Budget.TOTAL_CURRENT_CAUTION_AMPS) return 'yellow';
    return 'green';
  }
  function colorFor(cls) {
    return cls === 'red' ? 'var(--red)' : cls === 'yellow' ? 'var(--yellow)' : 'var(--green)';
  }

  // init
  $('battery-age-val').textContent = (sim.batteryAge).toFixed(2);
  el.alerts.innerHTML = '<li class="empty">No alerts.</li>';
})();
