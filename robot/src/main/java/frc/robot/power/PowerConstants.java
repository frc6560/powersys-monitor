package frc.robot.power;

/**
 * Self-contained power thresholds for the portable {@code power} package, so it drops into any
 * robot project without depending on that project's own {@code Constants}. Tune to taste.
 */
public final class PowerConstants {
  private PowerConstants() {}

  /** REV PDH CAN ID (REV default is 1). */
  public static final int PDH_CAN_ID = 1;

  /** Robot loop period (s). */
  public static final double LOOP_PERIOD_SECONDS = 0.020;

  // ---- Budget / brownout thresholds ----
  public static final double MAIN_BREAKER_AMPS = 120.0;
  public static final double TOTAL_CURRENT_BUDGET_AMPS = 90.0;   // practical sustained ceiling
  public static final double TOTAL_CURRENT_CAUTION_AMPS = 70.0;  // green/yellow boundary
  public static final double LOW_VOLTAGE_WARNING = 7.0;          // brownout-risk warning
  public static final double BROWNOUT_VOLTAGE = 6.8;             // RoboRIO brownout threshold
  public static final double NOMINAL_VOLTAGE = 12.0;
}
