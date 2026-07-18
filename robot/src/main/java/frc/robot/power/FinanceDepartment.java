package frc.robot.power;

import frc.robot.Constants.PowerBudget;

/**
 * The "finance department" (Team 6328 term): allocates current to the drivetrain based on the
 * battery estimator and breaker thermal model, so the robot can safely use the full potential of
 * the battery in every match instead of a fixed conservative limit.
 *
 * <p>Each loop it forward-projects both models over a time budget and binary-searches the largest
 * total bus current that keeps:
 * <ul>
 *   <li>projected battery terminal voltage above brownout (+ a safety margin), and
 *   <li>projected breaker thermal state below trip (+ a margin).
 * </ul>
 * The reserved draw of the non-drive subsystems is subtracted from that ceiling, and whatever is
 * left is handed to the drivetrain as its dynamic current limit.
 */
public class FinanceDepartment {

  private final BatteryEstimator battery;
  private final BreakerThermalModel breaker;

  // Projection horizons (s) and integration step for the forward simulation.
  private final double batteryHorizon = 1.5;
  private final double breakerHorizon = 3.0;
  private final double projectionDt = 0.02;

  // Safety margins.
  private final double brownoutMargin = 0.3; // keep projected V >= brownout + 0.3 V
  private final double thetaMargin = 0.85; // keep projected theta <= 0.85

  // Search bounds for total permissible current.
  private final double searchMin = 0.0;
  private final double searchMax = 400.0;

  private double permissibleTotal;
  private double driveAllocation;

  public FinanceDepartment(BatteryEstimator battery, BreakerThermalModel breaker) {
    this.battery = battery;
    this.breaker = breaker;
  }

  /**
   * Recompute the budget.
   *
   * @param reservedNonDriveCurrent current the non-drive subsystems are drawing / expected to draw
   * @return the drivetrain's allocated current limit (A)
   */
  public double allocate(double reservedNonDriveCurrent) {
    permissibleTotal = maxPermissibleTotalCurrent();
    driveAllocation = Math.max(0.0, permissibleTotal - reservedNonDriveCurrent);
    return driveAllocation;
  }

  /** Binary-search the largest total current that satisfies both projected constraints. */
  private double maxPermissibleTotalCurrent() {
    double lo = searchMin;
    double hi = searchMax;
    // If even a tiny current already violates (empty/hot), the loop returns lo ~ 0.
    for (int i = 0; i < 24; i++) {
      double mid = 0.5 * (lo + hi);
      if (feasible(mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private boolean feasible(double totalCurrent) {
    double minV = battery.projectMinVoltage(totalCurrent, batteryHorizon, projectionDt);
    if (minV < PowerBudget.BROWNOUT_VOLTAGE + brownoutMargin) return false;
    double maxTheta = breaker.projectMaxTheta(totalCurrent, breakerHorizon, projectionDt);
    return maxTheta <= thetaMargin;
  }

  /** Last computed maximum permissible total bus current (A). */
  public double permissibleTotalCurrent() {
    return permissibleTotal;
  }

  /** Last computed drivetrain allocation (A). */
  public double driveAllocation() {
    return driveAllocation;
  }
}
