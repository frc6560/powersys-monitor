/*
 * Main-breaker thermal model (mirrors BreakerThermalModel.java).
 *
 * A thermal-magnetic breaker trips on accumulated heat, not instantaneous
 * current. Track a normalized thermal state theta (0 = cold, 1 = trip) whose
 * steady state is (I/I_rated)^2:
 *     dTheta/dt = ((I/I_rated)^2 - theta) / tau
 * Heat accumulates during high-current draws and exponentially decays during
 * cooldowns (Miner's-rule-style damage), so brief overcurrent is tolerated.
 */
window.PM = window.PM || {};

PM.BreakerThermalModel = class {
  constructor(ratedAmps, tauSeconds) {
    this.ratedAmps = ratedAmps;
    this.tau = tauSeconds;
    this.theta = 0;
  }

  update(totalCurrent, dt) {
    const drive = Math.pow(totalCurrent / this.ratedAmps, 2);
    this.theta += (drive - this.theta) * (dt / this.tau);
    this.theta = Math.max(0, this.theta);
  }

  thermalState() { return this.theta; }
  isTripped() { return this.theta >= 1; }

  // Forward-project peak theta if held at totalCurrent for horizonSec.
  projectMaxTheta(totalCurrent, horizonSec, dt) {
    const drive = Math.pow(totalCurrent / this.ratedAmps, 2);
    let th = this.theta;
    for (let t = 0; t < horizonSec; t += dt) th += (drive - th) * (dt / this.tau);
    return th;
  }
};
