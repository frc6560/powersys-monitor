/*
 * Electrical / power constants for the Team 6560 web demo.
 * These mirror the Java project's Constants.java and PowerSubsystem enum so the
 * demo behaves like the real monitor (channel map, breaker ratings, current
 * limits, and the match power budget from the design document).
 */
window.PM = window.PM || {};

PM.Budget = {
  MAIN_BREAKER_AMPS: 120,        // §3.1 main breaker
  TOTAL_CURRENT_BUDGET_AMPS: 90, // §3.1 practical sustained ceiling
  TOTAL_CURRENT_CAUTION_AMPS: 70,// green/yellow boundary
  LOW_VOLTAGE_WARNING: 7.0,      // §4.3 low-voltage warning
  BROWNOUT_VOLTAGE: 6.8,         // §3.3 RoboRIO brownout threshold
  NOMINAL_VOLTAGE: 12.0,
};

/*
 * Logical subsystems, grouped by PDH channels (§2.2) with a load-shed priority
 * (§3.3). priority 0 = most critical, shed LAST (drivetrain). Higher = shed first.
 *
 * Current model per subsystem (amps), from the §3.2 consumption table:
 *   idle     — quiescent draw
 *   typical  — normal in-use draw
 *   peak     — brief peak (sustained cap while "on")
 *   inrush   — extra transient added on a rising demand edge (stall inrush)
 *   smart    — smart current limit set in code (§3.2)
 *   breaker  — group breaker capacity for the dashboard bar scale (§2.2)
 */
PM.SUBSYSTEMS = [
  { key: 'drivetrain', label: 'Drivetrain', channels: [0,1,2,3], priority: 0,
    idle: 2,  typical: 45, peak: 120, inrush: 150, smart: 240, breaker: 160, sheddable: false },
  { key: 'climber',    label: 'Climber',    channels: [9],       priority: 1,
    idle: 0,  typical: 5,  peak: 50,  inrush: 140, smart: 40,  breaker: 40,  sheddable: true },
  { key: 'shooter',    label: 'Shooter',    channels: [6,7],     priority: 2,
    idle: 0,  typical: 18, peak: 40,  inrush: 60,  smart: 35,  breaker: 80,  sheddable: true },
  { key: 'intake',     label: 'Intake',     channels: [4,5],     priority: 3,
    idle: 0,  typical: 10, peak: 25,  inrush: 40,  smart: 20,  breaker: 60,  sheddable: true },
  { key: 'indexer',    label: 'Indexer',    channels: [8],       priority: 4,
    idle: 0,  typical: 4,  peak: 10,  inrush: 12,  smart: 15,  breaker: 20,  sheddable: true },
  { key: 'turret',     label: 'Turret',     channels: [10,11],   priority: 5,
    idle: 0,  typical: 4,  peak: 10,  inrush: 12,  smart: 15,  breaker: 40,  sheddable: true },
];

// Warn when a subsystem exceeds this fraction of its breaker rating (§2.2).
PM.BREAKER_WARN_FRACTION = 0.90;

PM.LOOP_MS = 20; // 50 Hz, matching the robot loop period
