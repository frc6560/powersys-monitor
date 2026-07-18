/*
 * Automatic load-shedding routine (design doc §3.3 priority strategy, §6).
 * Mirrors LoadShedder.java: when total bus current stays above the budget ceiling
 * for a short window, reduce the smart-current limit of the least-critical
 * subsystem first, then the next, etc. The drivetrain is never auto-shed.
 * Limits restore once draw drops below a hysteresis threshold.
 */
window.PM = window.PM || {};

PM.LoadShedder = class {
  constructor() {
    this.shedAbove = PM.Budget.TOTAL_CURRENT_BUDGET_AMPS;   // start shedding above 90A
    this.restoreBelow = PM.Budget.TOTAL_CURRENT_CAUTION_AMPS;// restore below 70A (hysteresis)
    this.sustainedLoops = 5;                                 // ~100ms @ 20ms
    this.reductionFraction = 0.5;                            // shed to 50% of normal limit
    this.enabled = true;

    this._overBudgetLoops = 0;
    this.shed = new Set(); // keys of currently-shed subsystems
  }

  reset() {
    this._overBudgetLoops = 0;
    this.shed.clear();
  }

  /*
   * Advance the state machine one loop. `subsystems` is the array of subsystem
   * defs sorted by priority. Returns the set of shed keys.
   */
  update(totalCurrent, subsystems) {
    if (!this.enabled) { this.shed.clear(); return this.shed; }

    if (totalCurrent > this.shedAbove) this._overBudgetLoops++;
    else this._overBudgetLoops = 0;

    if (this._overBudgetLoops >= this.sustainedLoops) {
      this._shedNextLeastCritical(subsystems);
    } else if (totalCurrent < this.restoreBelow && this.shed.size > 0) {
      this.shed.clear();
      this._overBudgetLoops = 0;
    }
    return this.shed;
  }

  _shedNextLeastCritical(subsystems) {
    // Walk from least critical (highest priority number) to most critical.
    const ordered = [...subsystems].sort((a, b) => b.priority - a.priority);
    for (const sub of ordered) {
      if (!sub.sheddable) continue;        // never shed the drivetrain
      if (!this.shed.has(sub.key)) {
        this.shed.add(sub.key);
        return sub;                        // shed one per event
      }
    }
    return null; // everything sheddable already shed
  }

  isShedding() { return this.shed.size > 0; }

  // Effective smart-current limit for a subsystem given shed state.
  effectiveLimit(sub) {
    return this.shed.has(sub.key) ? sub.smart * this.reductionFraction : sub.smart;
  }
};
