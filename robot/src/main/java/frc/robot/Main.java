package frc.robot;

import edu.wpi.first.wpilibj.RobotBase;

/** Program entry point. Do not add startup logic here; use {@link Robot#robotInit()}. */
public final class Main {
  private Main() {}

  public static void main(String... args) {
    RobotBase.startRobot(Robot::new);
  }
}
