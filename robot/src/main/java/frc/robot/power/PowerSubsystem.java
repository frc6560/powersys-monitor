package frc.robot.power;

import frc.robot.Constants.BreakerRatings;
import frc.robot.Constants.Channels;

/**
 * Logical robot subsystems grouped by the PDH channels that feed them (design doc &sect;2.2).
 *
 * <p>Each entry knows its output channels, the breaker rating on those channels, and its
 * load-shed priority. Priority drives the strategy from &sect;3.3: when total draw approaches
 * the budget ceiling, higher-priority-number subsystems are throttled first and the
 * drivetrain (priority 0) is throttled last, because losing drive control loses the match.
 */
public enum PowerSubsystem {

  // priority 0 = shed last (most critical). Higher number = shed first.
  DRIVETRAIN(
      "Drivetrain",
      0,
      BreakerRatings.DRIVE,
      new int[] {
        Channels.DRIVE_FRONT_LEFT,
        Channels.DRIVE_FRONT_RIGHT,
        Channels.DRIVE_BACK_LEFT,
        Channels.DRIVE_BACK_RIGHT
      }),

  CLIMBER("Climber", 1, BreakerRatings.CLIMBER, new int[] {Channels.CLIMBER}),

  SHOOTER("Shooter", 2, BreakerRatings.SHOOTER, new int[] {Channels.SHOOTER_A, Channels.SHOOTER_B}),

  INTAKE("Intake", 3, BreakerRatings.INTAKE, new int[] {Channels.INTAKE_A, Channels.INTAKE_B}),

  INDEXER("Indexer", 4, BreakerRatings.INDEXER, new int[] {Channels.INDEXER}),

  TURRET("Turret", 5, BreakerRatings.TURRET, new int[] {Channels.TURRET_A, Channels.TURRET_B});

  private final String label;
  private final int shedPriority;
  private final double breakerRatingAmps;
  private final int[] channels;

  PowerSubsystem(String label, int shedPriority, double breakerRatingAmps, int[] channels) {
    this.label = label;
    this.shedPriority = shedPriority;
    this.breakerRatingAmps = breakerRatingAmps;
    this.channels = channels;
  }

  public String label() {
    return label;
  }

  /** Lower number = more critical = shed last. Drivetrain is 0. */
  public int shedPriority() {
    return shedPriority;
  }

  /** Breaker rating (amps) on each of this subsystem's channels. */
  public double breakerRatingAmps() {
    return breakerRatingAmps;
  }

  public int[] channels() {
    return channels;
  }

  /** Current at which we warn this subsystem is nearing its breaker (90% of rating). */
  public double breakerWarnAmps() {
    return breakerRatingAmps * BreakerRatings.WARN_FRACTION;
  }
}
