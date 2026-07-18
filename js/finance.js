/*
 * The "finance department" (mirrors FinanceDepartment.java).
 *
 * Each loop it forward-projects the battery estimator and breaker thermal model
 * over a time budget and binary-searches the largest total bus current that keeps
 * projected voltage above brownout (+margin) AND projected breaker thermal below
 * trip (+margin). It then subtracts the non-drive subsystems' draw and hands the
 * remaining headroom to the drivetrain as its dynamic current limit — letting the
 * robot safely use the full battery instead of a fixed conservative cap.
 */
window.PM = window.PM || {};

PM.FinanceDepartment = class {
  constructor(battery, breaker) {
    this.battery = battery;
    this.breaker = breaker;
    this.enabled = true;

    this.batteryHorizon = 1.5;
    this.breakerHorizon = 3.0;
    this.projectionDt = 0.02;
    this.brownoutMargin = 0.3;   // keep projected V >= 6.8 + 0.3
    this.thetaMargin = 0.85;     // keep projected theta <= 0.85
    this.searchMax = 400;

    this.permissibleTotal = PM.Budget.MAIN_BREAKER_AMPS;
    this.driveAllocation = PM.Budget.MAIN_BREAKER_AMPS;
  }

  allocate(reservedNonDriveCurrent) {
    this.permissibleTotal = this._maxPermissibleTotal();
    this.driveAllocation = Math.max(0, this.permissibleTotal - reservedNonDriveCurrent);
    return this.driveAllocation;
  }

  _maxPermissibleTotal() {
    let lo = 0, hi = this.searchMax;
    for (let i = 0; i < 24; i++) {
      const mid = 0.5 * (lo + hi);
      if (this._feasible(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }

  _feasible(totalCurrent) {
    const minV = this.battery.projectMinVoltage(totalCurrent, this.batteryHorizon, this.projectionDt);
    if (minV < PM.Budget.BROWNOUT_VOLTAGE + this.brownoutMargin) return false;
    const maxTheta = this.breaker.projectMaxTheta(totalCurrent, this.breakerHorizon, this.projectionDt);
    return maxTheta <= this.thetaMargin;
  }
};
