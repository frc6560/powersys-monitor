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
    brownouts: $('brownouts'), energy: $('energy'), shedStatus: $('shed-status'),
    subsystems: $('subsystems'), alerts: $('alerts'), controls: $('controls'),
    graph: $('graph'),
    socFill: $('soc-fill'), socText: $('soc-text'), ocv: $('ocv-val'), r0: $('r0-val'),
    predv: $('predv-val'), measv: $('measv-val'),
    thermalFill: $('thermal-fill'), thermalText: $('thermal-text'),
    permissible: $('permissible-val'), drivealloc: $('drivealloc-val'),
    energyPie: $('energy-pie'), energyTotal: $('energy-total'),
  };
  initModels();

  // ---- Build per-subsystem bars + controls ----
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

    const ctrl = document.createElement('div');
    ctrl.className = 'ctrl';
    ctrl.innerHTML =
      `<label>${s.label} <b id="demand-${s.key}">0%</b></label>` +
      `<input type="range" min="0" max="100" value="0" id="ctrl-${s.key}" />`;
    el.controls.appendChild(ctrl);
    const slider = ctrl.querySelector('input');
    const readout = ctrl.querySelector('b');
    slider.addEventListener('input', () => {
      sim.setDemand(s.key, slider.value / 100);
      readout.textContent = slider.value + '%';
    });
    subEls[s.key].slider = slider;
    subEls[s.key].readout = readout;
  }

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
    for (const s of PM.SUBSYSTEMS) {
      sim.setDemand(s.key, 0);
      subEls[s.key].slider.value = 0;
      subEls[s.key].readout.textContent = '0%';
    }
    logRows.length = 0; history.length = 0;
    el.alerts.innerHTML = '<li class="empty">No alerts.</li>';
  });

  // ---- Worst-case stress test (§5) ----
  $('btn-stress').addEventListener('click', () => {
    if (!running) btnStart.click();
    const burst = { drivetrain: 0.95, shooter: 1.0, intake: 0.9, climber: 1.0 };
    for (const k in burst) {
      sim.setDemand(k, burst[k]);
      subEls[k].slider.value = burst[k] * 100;
      subEls[k].readout.textContent = Math.round(burst[k] * 100) + '%';
    }
    setTimeout(() => {
      for (const k in burst) {
        sim.setDemand(k, 0);
        subEls[k].slider.value = 0;
        subEls[k].readout.textContent = '0%';
      }
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
  const history = [];      // {v, a} recent points for the graph
  const MAX_POINTS = 300;
  const logRows = [];      // full match log for CSV export
  let logDecim = 0;

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
    el.energy.textContent = (r.energyJoules / 3600).toFixed(1) + ' Wh';
    const shedList = [...shedder.shed];
    el.shedStatus.textContent = shedList.length
      ? shedList.map((k) => PM.SUBSYSTEMS.find((s) => s.key === k).label).join(', ')
      : 'nominal';
    el.shedStatus.className = 'tile-value' + (shedList.length ? ' shedding' : '');

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

    el.energyTotal.textContent = (r.energyJoules / 3600).toFixed(1) + ' Wh';
    drawEnergyPie();
  }

  // Match-energy pie (mirrors the binder's "Typical Match Energy Usage").
  const pieCtx = el.energyPie.getContext('2d');
  const PIE_COLORS = ['#4d7ab8', '#8fb3de', '#1f3d6e', '#2f5c9e', '#6b95c9', '#0b1f3f', '#111827'];
  function drawEnergyPie() {
    const parts = [...PM.SUBSYSTEMS.map((s) => ({ label: s.label, wh: sim.energyWh[s.key] })),
                   { label: 'Other', wh: sim.energyWh.other }];
    const total = parts.reduce((a, p) => a + p.wh, 0) || 1;
    const cx = 75, cy = 75, rad = 62;
    pieCtx.clearRect(0, 0, 150, 150);
    let ang = -Math.PI / 2;
    parts.forEach((p, i) => {
      const slice = (p.wh / total) * Math.PI * 2;
      pieCtx.beginPath(); pieCtx.moveTo(cx, cy);
      pieCtx.arc(cx, cy, rad, ang, ang + slice);
      pieCtx.closePath();
      pieCtx.fillStyle = PIE_COLORS[i % PIE_COLORS.length];
      pieCtx.fill();
      ang += slice;
    });
  }

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
