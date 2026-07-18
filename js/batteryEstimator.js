/*
 * Battery state estimator — the observer (mirrors BatteryEstimator.java).
 *
 * Coulomb counting with a dynamic Peukert correction estimates SOC; a single-RC
 * Thevenin model predicts transient voltage sag:
 *     V_terminal = OCV(SOC) - I*R0 - V_rc
 *     dV_rc/dt   = I/C1 - V_rc/(R1*C1)
 * The measured terminal voltage is compared to the prediction and SOC is nudged
 * toward the measurement with a small noise-attenuated (Kalman-style) gain.
 */
window.PM = window.PM || {};

PM.BatteryEstimator = class {
  constructor(nominalCapacityAh, initialSoc, ageFactor) {
    this.nominalCapacityAh = nominalCapacityAh;
    this.r0Base = 0.012;
    this.r1 = 0.010;
    this.c1 = 500;          // tau1 = R1*C1 = 5 s
    this.peukertK = 1.08;
    this.iRef = 20;
    this.socGain = 0.02;    // Kalman-style innovation gain
    this.ageFactor = ageFactor;

    this.soc = clamp01(initialSoc);
    this.vRc = 0;
    this.predictedVoltage = this.ocv(this.soc);
  }

  ocv(s) {
    s = clamp01(s);
    return 11.6 + 1.0 * s + 0.30 * Math.tanh(6 * (s - 0.5)) + 0.15;
  }

  seriesResistance() {
    const socPenalty = 1 + 0.6 * (1 - this.soc);
    const agePenalty = 1 + 1.2 * this.ageFactor;
    return this.r0Base * socPenalty * agePenalty;
  }

  update(measuredVoltage, current, dt) {
    // 1) coulomb counting w/ dynamic Peukert correction
    const iEff = current * Math.pow(Math.max(current, 0.1) / this.iRef, this.peukertK - 1);
    this.soc = clamp01(this.soc - (iEff * dt) / (3600 * this.nominalCapacityAh));

    // 2) RC polarization branch (exact discrete step)
    const tau1 = this.r1 * this.c1;
    const decay = Math.exp(-dt / tau1);
    this.vRc = this.vRc * decay + current * this.r1 * (1 - decay);

    // 3) predicted terminal voltage
    this.predictedVoltage = this.ocv(this.soc) - current * this.seriesResistance() - this.vRc;

    // 4) Kalman-style SOC correction from the voltage innovation
    const innovation = measuredVoltage - this.predictedVoltage;
    const slope = this._ocvSlope(this.soc);
    if (slope > 1e-3) this.soc = clamp01(this.soc + this.socGain * innovation / slope);
  }

  _ocvSlope(s) {
    const h = 0.01;
    return (this.ocv(s + h) - this.ocv(s - h)) / (2 * h);
  }

  // Forward-project the minimum terminal voltage if held at totalCurrent for horizonSec.
  projectMinVoltage(totalCurrent, horizonSec, dt) {
    let s = this.soc, v = this.vRc;
    const tau1 = this.r1 * this.c1;
    const decay = Math.exp(-dt / tau1);
    let minV = Infinity;
    for (let t = 0; t < horizonSec; t += dt) {
      const iEff = totalCurrent * Math.pow(Math.max(totalCurrent, 0.1) / this.iRef, this.peukertK - 1);
      s = clamp01(s - (iEff * dt) / (3600 * this.nominalCapacityAh));
      v = v * decay + totalCurrent * this.r1 * (1 - decay);
      const r0 = this.r0Base * (1 + 0.6 * (1 - s)) * (1 + 1.2 * this.ageFactor);
      const vTerm = this.ocv(s) - totalCurrent * r0 - v;
      if (vTerm < minV) minV = vTerm;
    }
    return minV;
  }
};

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
