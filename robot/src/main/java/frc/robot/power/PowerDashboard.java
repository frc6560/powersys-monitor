package frc.robot.power;

import edu.wpi.first.wpilibj.shuffleboard.BuiltInWidgets;
import edu.wpi.first.wpilibj.shuffleboard.Shuffleboard;
import edu.wpi.first.wpilibj.shuffleboard.ShuffleboardTab;
import edu.wpi.first.wpilibj.shuffleboard.WidgetType;
import frc.robot.Constants.PowerBudget;
import java.util.Map;
import java.util.function.DoubleSupplier;
import java.util.function.IntSupplier;
import java.util.function.Supplier;

/**
 * Builds the "Power" Shuffleboard tab described in design doc &sect;4.4: a live bus-voltage graph,
 * a color-coded total-current bar against the 90A budget, per-subsystem current bars, and the
 * key at-a-glance status readouts for the drive team and pit crew.
 *
 * <p>This class only wires widgets to suppliers; the values themselves come from
 * {@code PowerMonitorSubsystem}. Build it once from the monitor's constructor.
 */
public final class PowerDashboard {

  private PowerDashboard() {}

  /**
   * @param busVoltage live bus voltage (V)
   * @param totalCurrent live total bus current (A)
   * @param energyJoules cumulative energy this match (J)
   * @param brownoutCount latched brownout events this session
   * @param minVoltage lowest bus voltage seen this session (V)
   * @param status "GREEN" / "YELLOW" / "RED"
   * @param shedStatus load-shedding status text
   * @param subsystemCurrent per-subsystem current supplier, indexed by PowerSubsystem.ordinal()
   */
  public static void build(
      DoubleSupplier busVoltage,
      DoubleSupplier totalCurrent,
      DoubleSupplier energyJoules,
      IntSupplier brownoutCount,
      DoubleSupplier minVoltage,
      Supplier<String> status,
      Supplier<String> shedStatus,
      DoubleSupplier[] subsystemCurrent) {

    ShuffleboardTab tab = Shuffleboard.getTab("Power");

    // Live bus-voltage graph. Range spans the brownout floor to a healthy pack.
    tab.addDouble("Bus Voltage", busVoltage)
        .withWidget(BuiltInWidgets.kGraph)
        .withPosition(0, 0)
        .withSize(4, 3)
        .withProperties(Map.of("Automatic bounds", false, "Lower bound", 6.0, "Upper bound", 13.0));

    // Total current as a dial, color-coded green/yellow/red against the budget.
    tab.addDouble("Total Current", totalCurrent)
        .withWidget(BuiltInWidgets.kDial)
        .withPosition(4, 0)
        .withSize(2, 2)
        .withProperties(
            Map.of(
                "Min", 0,
                "Max", PowerBudget.MAIN_BREAKER_AMPS,
                "Show value", true));

    tab.addString("Status", status)
        .withWidget(BuiltInWidgets.kTextView)
        .withPosition(6, 0)
        .withSize(2, 1);

    tab.addString("Load Shedding", shedStatus)
        .withWidget(BuiltInWidgets.kTextView)
        .withPosition(6, 1)
        .withSize(2, 1);

    // addInteger takes a LongSupplier; adapt the IntSupplier (int widens to long).
    tab.addInteger("Brownouts", () -> brownoutCount.getAsInt())
        .withWidget(BuiltInWidgets.kTextView)
        .withPosition(6, 2)
        .withSize(1, 1);

    tab.addDouble("Min Voltage", minVoltage)
        .withWidget(BuiltInWidgets.kTextView)
        .withPosition(7, 2)
        .withSize(1, 1);

    tab.addDouble("Energy (J)", energyJoules)
        .withWidget(BuiltInWidgets.kTextView)
        .withPosition(4, 2)
        .withSize(2, 1);

    // Per-subsystem current bars, each capped at that subsystem's breaker rating.
    WidgetType bar = BuiltInWidgets.kNumberBar;
    PowerSubsystem[] subsystems = PowerSubsystem.values();
    int row = 3;
    int col = 0;
    for (int i = 0; i < subsystems.length; i++) {
      PowerSubsystem sub = subsystems[i];
      final int idx = i;
      tab.addDouble(sub.label() + " (A)", () -> subsystemCurrent[idx].getAsDouble())
          .withWidget(bar)
          .withPosition(col, row)
          .withSize(2, 1)
          .withProperties(
              Map.of("Min", 0, "Max", sub.breakerRatingAmps(), "Center", sub.breakerWarnAmps()));
      col += 2;
      if (col >= 8) {
        col = 0;
        row++;
      }
    }
  }
}
