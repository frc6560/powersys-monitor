package frc.robot;

/**
 * Central electrical / power-management constants for Team 6560.
 *
 * <p>This is the single source of truth for PDH channel allocation, breaker ratings,
 * smart-current limits, and the match power budget. Section references below map to the
 * "Power Draw &amp; Electrical Systems Monitor" design document.
 *
 * <p>RULE: Every physical PDH channel that has a label on the robot must have a matching
 * constant here. If you re-wire a channel, change it here first.
 */
public final class Constants {

  private Constants() {}

  /** REV PDH CAN ID. The PDH ships defaulted to CAN ID 1. */
  public static final int PDH_CAN_ID = 1;

  /**
   * PDH output-channel map (design doc &sect;2.2).
   *
   * <p>Channel numbers are the physical PDH output ports. Breaker ratings are documented
   * alongside each channel so wiring/breaker selection stays traceable from code.
   */
  public static final class Channels {
    private Channels() {}

    // 0-3: Drivetrain (Falcon 500 / Kraken) - 40A breakers each. Highest sustained + peak.
    public static final int DRIVE_FRONT_LEFT = 0;
    public static final int DRIVE_FRONT_RIGHT = 1;
    public static final int DRIVE_BACK_LEFT = 2;
    public static final int DRIVE_BACK_RIGHT = 3;

    // 4-5: Intake (NEO) - 30A. High peak, short duration.
    public static final int INTAKE_A = 4;
    public static final int INTAKE_B = 5;

    // 6-7: Shooter / Flywheel (Falcon 500) - 40A. Sustained spin-up current.
    public static final int SHOOTER_A = 6;
    public static final int SHOOTER_B = 7;

    // 8: Indexer / Feeder (NEO 550) - 20A. Low continuous draw.
    public static final int INDEXER = 8;

    // 9: Climber (NEO) - 40A. Brief but very high peak near endgame.
    public static final int CLIMBER = 9;

    // 10-11: Turret / Aim (NEO 550) - 20A. Position control, low draw.
    public static final int TURRET_A = 10;
    public static final int TURRET_B = 11;

    // 20-21: RIO, radio, PDH internals - internally fused. Not motor channels.
    public static final int RIO_RAIL = 20;
    public static final int RADIO_RAIL = 21;

    // Switchable channels (compressor, LEDs) - 20A. Can be remotely disabled if shorted.
    public static final int SWITCHABLE_PNEUMATICS = 22; // switchable A
    public static final int SWITCHABLE_LEDS = 23; // switchable B
  }

  /**
   * Per-channel breaker ratings in amps (design doc &sect;2.2). Used by the monitor to warn
   * when a channel approaches the physical breaker limit before it nuisance-trips.
   */
  public static final class BreakerRatings {
    private BreakerRatings() {}

    public static final double DRIVE = 40.0;
    public static final double INTAKE = 30.0;
    public static final double SHOOTER = 40.0;
    public static final double INDEXER = 20.0;
    public static final double CLIMBER = 40.0;
    public static final double TURRET = 20.0;
    public static final double SWITCHABLE = 20.0;

    /**
     * Warn when a channel's current exceeds this fraction of its breaker rating.
     * PDH breakers tolerate brief overcurrent, so we warn at 90% sustained rather than 100%.
     */
    public static final double WARN_FRACTION = 0.90;
  }

  /**
   * Smart current limits set on the motor controllers (design doc &sect;3.2). These are the
   * values passed to {@code setSmartCurrentLimit()} / {@code StatorCurrentLimit}, kept here
   * so mechanism code and the power model reference the same numbers.
   */
  public static final class CurrentLimits {
    private CurrentLimits() {}

    public static final double DRIVE_PER_MOTOR = 60.0; // statorCurrentLimit, per drivetrain motor
    public static final double SHOOTER = 35.0;
    public static final double INTAKE = 20.0;
    public static final double CLIMBER = 40.0;
    public static final double INDEXER_TURRET = 15.0;
  }

  /**
   * Match power budget and brownout thresholds (design doc &sect;3.1, &sect;3.3, &sect;4.3).
   */
  public static final class PowerBudget {
    private PowerBudget() {}

    /** Main breaker rating. Hard ceiling. */
    public static final double MAIN_BREAKER_AMPS = 120.0;

    /** Practical sustained-draw ceiling; battery sag becomes a problem well before 120A. */
    public static final double TOTAL_CURRENT_BUDGET_AMPS = 90.0;

    /** Green/yellow boundary for the dashboard total-current bar. */
    public static final double TOTAL_CURRENT_CAUTION_AMPS = 70.0;

    /** Warn on low bus voltage; brownout risk. */
    public static final double LOW_VOLTAGE_WARNING = 7.0;

    /** RoboRIO internal rail browns out around here. Informational threshold for logging. */
    public static final double BROWNOUT_VOLTAGE = 6.8;

    /** Nominal fully-charged SLA battery voltage, for the dashboard voltage gauge range. */
    public static final double NOMINAL_VOLTAGE = 12.0;
  }

  /** Robot loop period in seconds (default 20 ms). Used for energy integration + logging. */
  public static final double LOOP_PERIOD_SECONDS = 0.020;
}
