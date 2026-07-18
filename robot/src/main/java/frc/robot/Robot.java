package frc.robot;

import edu.wpi.first.wpilibj.TimedRobot;
import edu.wpi.first.wpilibj2.command.CommandScheduler;

/**
 * Team 6560 power-monitor demo robot.
 *
 * <p>The {@link edu.wpi.first.wpilibj2.command.CommandScheduler} runs every subsystem's
 * {@code periodic()}, including {@link frc.robot.subsystems.PowerMonitorSubsystem}, so power
 * logging / dashboard / alerts / load-shedding all run automatically at the 20 ms loop rate.
 */
public class Robot extends TimedRobot {

  private RobotContainer container;

  public Robot() {
    super(Constants.LOOP_PERIOD_SECONDS);
  }

  @Override
  public void robotInit() {
    container = new RobotContainer();
  }

  @Override
  public void robotPeriodic() {
    CommandScheduler.getInstance().run();
  }

  @Override
  public void autonomousInit() {
    // Fresh energy + min-voltage accounting per match, and clear any leftover shedding.
    container.powerMonitor().resetSessionStats();
    container.powerMonitor().resetLoadShedding();
  }

  @Override
  public void teleopInit() {
    container.powerMonitor().resetLoadShedding();
  }
}
