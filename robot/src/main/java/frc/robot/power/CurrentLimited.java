package frc.robot.power;

/**
 * Implemented by any mechanism subsystem that can voluntarily reduce its current draw when the
 * robot is at risk of a brownout (design doc &sect;3.3, &sect;6 automatic load-shedding).
 *
 * <p>The mechanism owns HOW it sheds load: typically by lowering its motor controllers'
 * smart-current limit, or by capping output. The {@link LoadShedder} decides WHEN, based on
 * total bus current and the subsystem's {@link PowerSubsystem#shedPriority()}.
 */
public interface CurrentLimited {

  /** Which logical subsystem this is, used for priority ordering. */
  PowerSubsystem powerSubsystem();

  /**
   * Apply a reduced current limit / output cap because the robot is shedding load.
   *
   * <p>Called at most once per shed event (not every loop). Should be idempotent.
   */
  void applyReducedLimit();

  /**
   * Restore the normal current limit from {@link frc.robot.Constants.CurrentLimits}.
   *
   * <p>Called when total draw has recovered below the restore threshold. Idempotent.
   */
  void restoreNormalLimit();
}
