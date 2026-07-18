/*
 * Physics-lite simulation of the robot's electrical system (the "truth" plant).
 *
 * The battery is a single-RC Thevenin cell: terminal voltage = OCV(SOC) - I*R0 -
 * V_rc, with SOC falling by Peukert-corrected coulomb counting. This gives the
 * estimator (js/batteryEstimator.js) realistic dynamics to track. Each subsystem
 * ramps between idle and peak with driver demand, is clipped by its (possibly
 * shed, or finance-allocated) current limit, and adds a brief stall-inrush
 * transient on rising demand edges. Below the brownout threshold the RIO browns
 * out and motor outputs cut for the dip.
 */
window.PM = window.PM || {};

PM.Simulation = class {
  constructor() {
    this.dt = PM.LOOP_MS / 1000;
    this.batteryAge = 0.3;
    this.capacityAh = 18;

    // Thevenin plant params (truth; deliberately a touch off from the estimator's
    // assumed values so the Kalman correction has something to do).
    this.r0Base = 0.014;
    this.r1 = 0.010;
    this.c1 = 500;
    this.peukertK = 1.08;
    this.iRef = 20;

    this.reset();
  }

  reset() {
    this.soc = 1.0;
    this.vRc = 0;
    this.energyJoules = 0;
    this.minVoltage = PM.Budget.NOMINAL_VOLTAGE;
    this.brownoutCount = 0;
    this._wasBrownedOut = false;
    this.brownoutHoldMs = 0;
    this.busVoltage = PM.Budget.NOMINAL_VOLTAGE;
    this.totalCurrent = 0;

    this.state = {};
    this.energyWh = {};
    for (const s of PM.SUBSYSTEMS) {
      this.state[s.key] = { demand: 0, prevDemand: 0, current: 0, transient: 0, atLimit: false };
      this.energyWh[s.key] = 0;
    }
    this.energyWh.other = 0.5; // radio/RIO/misc baseline
  }

  setDemand(key, value) { this.state[key].demand = Math.max(0, Math.min(1, value)); }

  ocv(s) {
    s = Math.max(0, Math.min(1, s));
    return 11.6 + 1.0 * s + 0.30 * Math.tanh(6 * (s - 0.5)) + 0.15;
  }
  seriesResistance() {
    return this.r0Base * (1 + 0.6 * (1 - this.soc)) * (1 + 1.2 * this.batteryAge);
  }

  /*
   * Advance one loop.
   *   loadShedder      — provides reduced limits for shed subsystems
   *   financeDriveLimit — dynamic drivetrain current cap from the finance dept,
   *                       or null to use the drivetrain's static smart limit.
   */
  step(loadShedder, financeDriveLimit) {
    const brownedOut = this.brownoutHoldMs > 0;

    let total = 0;
    for (const s of PM.SUBSYSTEMS) {
      const st = this.state[s.key];

      const rising = st.demand - st.prevDemand;
      if (rising > 0.05) st.transient = Math.max(st.transient, s.inrush * rising);
      st.transient *= 0.75;
      st.prevDemand = st.demand;

      let draw = s.idle + (s.peak - s.idle) * st.demand + st.transient;

      // Effective limit: finance gates the drivetrain; the load-shedder gates the rest.
      let limit;
      if (s.key === 'drivetrain') {
        limit = (financeDriveLimit != null) ? financeDriveLimit : s.smart;
      } else {
        limit = loadShedder.effectiveLimit(s);
      }
      st.atLimit = draw > limit && st.demand > 0.01;
      draw = Math.min(draw, limit);

      if (brownedOut) draw *= 0.15;
      st.current = draw;
      total += draw;
    }

    // Thevenin battery: SOC (Peukert coulomb counting) + RC polarization branch.
    const iEff = total * Math.pow(Math.max(total, 0.1) / this.iRef, this.peukertK - 1);
    this.soc = Math.max(0, this.soc - (iEff * this.dt) / (3600 * this.capacityAh));
    const tau1 = this.r1 * this.c1;
    const decay = Math.exp(-this.dt / tau1);
    this.vRc = this.vRc * decay + total * this.r1 * (1 - decay);

    let vTerm = this.ocv(this.soc) - total * this.seriesResistance() - this.vRc;
    const measured = Math.max(0, vTerm + (Math.random() - 0.5) * 0.05); // sensor noise
    this.busVoltage = measured;
    this.totalCurrent = total;

    // Brownout latch + hold.
    if (this.brownoutHoldMs > 0) this.brownoutHoldMs -= PM.LOOP_MS;
    else if (measured < PM.Budget.BROWNOUT_VOLTAGE) this.brownoutHoldMs = 350;
    const nowBrowned = this.brownoutHoldMs > 0;
    if (nowBrowned && !this._wasBrownedOut) this.brownoutCount++;
    this._wasBrownedOut = nowBrowned;

    // Accounting.
    if (measured < this.minVoltage) this.minVoltage = measured;
    this.energyJoules += measured * total * this.dt;
    for (const s of PM.SUBSYSTEMS) this.energyWh[s.key] += measured * this.state[s.key].current * this.dt / 3600;
    this.energyWh.other += measured * 1.0 * this.dt / 3600; // ~1A misc bus

    return {
      busVoltage: measured, trueVoltage: vTerm, totalCurrent: total,
      energyJoules: this.energyJoules, brownedOut: nowBrowned,
      brownoutCount: this.brownoutCount, minVoltage: this.minVoltage, soc: this.soc,
    };
  }

  subsystemCurrent(key) { return this.state[key].current; }
};
