package frc.robot.subsystems;

import edu.wpi.first.wpilibj2.command.SubsystemBase;
import frc.robot.Constants.CurrentLimits;
import frc.robot.power.CurrentLimited;
import frc.robot.power.PowerSubsystem;

/**
 * Example of a mechanism subsystem that participates in automatic load-shedding.
 *
 * <p>This is a template: the vendor motor-controller calls are shown as comments so the project
 * compiles against plain WPILib. Replace them with your real Phoenix 6 ({@code TalonFX}) or
 * REVLib ({@code SparkMax}) current-limit calls. The important part is the {@link CurrentLimited}
 * contract: the {@link frc.robot.power.LoadShedder} calls {@link #applyReducedLimit()} when the
 * robot is at brownout risk and {@link #restoreNormalLimit()} once it recovers.
 */
public class ExampleShooterSubsystem extends SubsystemBase implements CurrentLimited {

  /** When shedding, drop the shooter limit to this fraction of normal. */
  private static final double SHED_FRACTION = 0.6;

  // private final TalonFX motor = new TalonFX(...);

  public ExampleShooterSubsystem() {
    setSmartCurrentLimit(CurrentLimits.SHOOTER);
  }

  @Override
  public PowerSubsystem powerSubsystem() {
    return PowerSubsystem.SHOOTER;
  }

  @Override
  public void applyReducedLimit() {
    setSmartCurrentLimit(CurrentLimits.SHOOTER * SHED_FRACTION);
  }

  @Override
  public void restoreNormalLimit() {
    setSmartCurrentLimit(CurrentLimits.SHOOTER);
  }

  /**
   * Push a stator-current limit to the motor controller.
   *
   * <p>Phoenix 6 (TalonFX):
   * <pre>{@code
   * var cfg = new CurrentLimitsConfigs();
   * cfg.StatorCurrentLimit = amps;
   * cfg.StatorCurrentLimitEnable = true;
   * motor.getConfigurator().apply(cfg);
   * }</pre>
   *
   * <p>REVLib (SparkMax):
   * <pre>{@code
   * motor.setSmartCurrentLimit((int) amps);
   * }</pre>
   */
  private void setSmartCurrentLimit(double amps) {
    // motor.getConfigurator().apply(new CurrentLimitsConfigs()
    //     .withStatorCurrentLimit(amps).withStatorCurrentLimitEnable(true));
  }
}
