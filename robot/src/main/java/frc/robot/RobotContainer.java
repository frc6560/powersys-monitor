package frc.robot;

import frc.robot.subsystems.ExampleShooterSubsystem;
import frc.robot.subsystems.PowerMonitorSubsystem;

/**
 * Wires the power-monitoring subsystem together with the mechanisms that can be load-shed.
 *
 * <p>In a real robot this class also owns the drivetrain, intake, climber, etc. Only the
 * power-management wiring is shown here.
 */
public class RobotContainer {

  private final PowerMonitorSubsystem powerMonitor = new PowerMonitorSubsystem();

  // Example sheddable mechanism. Add your real intake/climber/turret the same way.
  private final ExampleShooterSubsystem shooter = new ExampleShooterSubsystem();

  public RobotContainer() {
    // Register every mechanism that is willing to be automatically throttled at brownout risk
    // (design doc §3.3 priority strategy). The drivetrain is intentionally NOT registered so it
    // is never auto-shed.
    powerMonitor.registerForLoadShedding(shooter);
    // powerMonitor.registerForLoadShedding(intake);
    // powerMonitor.registerForLoadShedding(climber);
    // powerMonitor.registerForLoadShedding(turret);
  }

  public PowerMonitorSubsystem powerMonitor() {
    return powerMonitor;
  }
}
