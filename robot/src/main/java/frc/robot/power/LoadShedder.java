package frc.robot.power;

import edu.wpi.first.wpilibj.DriverStation;
import frc.robot.Constants.PowerBudget;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Automatic load-shedding routine (design doc &sect;3.3 priority strategy, &sect;6 future improvement).
 *
 * <p>When total bus current climbs above the budget ceiling, this temporarily reduces the
 * current limits of non-critical subsystems, sheddng the LEAST critical first (highest
 * {@link PowerSubsystem#shedPriority()}). The drivetrain (priority 0) is shed last. Limits are
 * restored once total draw recovers below a hysteresis threshold, so we don't oscillate.
 */
public class LoadShedder {

  /** Start shedding when sustained total current exceeds the budget ceiling. */
  private static final double SHED_ABOVE_AMPS = PowerBudget.TOTAL_CURRENT_BUDGET_AMPS;

  /** Restore once we drop back under this (hysteresis band prevents chatter). */
  private static final double RESTORE_BELOW_AMPS = PowerBudget.TOTAL_CURRENT_CAUTION_AMPS;

  /**
   * Total current must stay above the shed threshold for this many consecutive loops before we
   * act, so a brief acceleration+shot peak doesn't trigger shedding. 5 loops @ 20 ms = 100 ms.
   */
  private static final int SUSTAINED_LOOPS_TO_SHED = 5;

  private final List<CurrentLimited> registered = new ArrayList<>();
  private final List<CurrentLimited> currentlyShed = new ArrayList<>();

  private int loopsOverBudget = 0;

  /** Register a mechanism that is willing to be throttled. Order does not matter. */
  public void register(CurrentLimited mechanism) {
    registered.add(mechanism);
    // Keep sorted most-critical-first; we iterate in reverse to shed least-critical first.
    registered.sort(Comparator.comparingInt(m -> m.powerSubsystem().shedPriority()));
  }

  /**
   * Drive the shed/restore state machine. Call once per loop from the monitor with the latest
   * total bus current.
   *
   * @return true if any subsystem is currently shed
   */
  public boolean update(double totalCurrentAmps) {
    if (totalCurrentAmps > SHED_ABOVE_AMPS) {
      loopsOverBudget++;
    } else {
      loopsOverBudget = 0;
    }

    if (loopsOverBudget >= SUSTAINED_LOOPS_TO_SHED) {
      shedNextLeastCritical();
    } else if (totalCurrentAmps < RESTORE_BELOW_AMPS && !currentlyShed.isEmpty()) {
      restoreAll();
    }

    return !currentlyShed.isEmpty();
  }

  /** Shed one more subsystem, the least critical not-yet-shed one. */
  private void shedNextLeastCritical() {
    // registered is sorted most-critical-first; walk from the end to find the least critical
    // subsystem that isn't shed yet.
    for (int i = registered.size() - 1; i >= 0; i--) {
      CurrentLimited m = registered.get(i);
      if (m.powerSubsystem() == PowerSubsystem.DRIVETRAIN) {
        continue; // never auto-shed the drivetrain
      }
      if (!currentlyShed.contains(m)) {
        m.applyReducedLimit();
        currentlyShed.add(m);
        DriverStation.reportWarning(
            "Load-shedding: reduced current limit on " + m.powerSubsystem().label(), false);
        return;
      }
    }
    // If we get here every sheddable subsystem is already shed; nothing more we can do.
  }

  /** Restore every shed subsystem to its normal limit. */
  public void restoreAll() {
    for (CurrentLimited m : currentlyShed) {
      m.restoreNormalLimit();
    }
    if (!currentlyShed.isEmpty()) {
      DriverStation.reportWarning("Load-shedding cleared: current limits restored", false);
    }
    currentlyShed.clear();
    loopsOverBudget = 0;
  }

  /** Names of subsystems currently shed, for the dashboard. Empty string when none. */
  public String shedStatus() {
    if (currentlyShed.isEmpty()) {
      return "";
    }
    StringBuilder sb = new StringBuilder();
    for (CurrentLimited m : currentlyShed) {
      if (sb.length() > 0) {
        sb.append(", ");
      }
      sb.append(m.powerSubsystem().label());
    }
    return sb.toString();
  }

  public boolean isShedding() {
    return !currentlyShed.isEmpty();
  }
}
