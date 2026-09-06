package frc.robot.power;

import edu.wpi.first.networktables.DoublePublisher;
import edu.wpi.first.networktables.NetworkTable;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StringPublisher;
import edu.wpi.first.util.datalog.DataLog;
import edu.wpi.first.util.datalog.DoubleLogEntry;
import edu.wpi.first.wpilibj.DataLogManager;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.PowerDistribution;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj.shuffleboard.BuiltInWidgets;
import edu.wpi.first.wpilibj.shuffleboard.Shuffleboard;
import edu.wpi.first.wpilibj.shuffleboard.ShuffleboardTab;
import edu.wpi.first.wpilibj2.command.SubsystemBase;


import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.DoubleSupplier;

/**
 * Per-subsystem power monitor that sources current from the <b>motor controllers</b> (by CAN ID),
 * the way Team 6328 / AdvantageKit do it — NOT from PDH output channels. Each subsystem is a named
 * group of motor current suppliers; you provide the per-motor current from your existing motor
 * objects (Kraken/TalonFX {@code getSupplyCurrent()}, SPARK MAX {@code getOutputCurrent()}), so no
 * PDH port mapping / wire tracing is needed.
 *
 * <p>This class is deliberately <b>vendor-agnostic</b>: it only takes {@link DoubleSupplier}s of
 * amps, so it compiles against plain WPILib and works with any motor library. You wire the actual
 * Phoenix 6 / REVLib calls in your {@code RobotContainer} (see the integration guide).
 *
 * <p>Bus voltage and brownout come from {@link RobotController} (no PDH required). It reuses the
 * {@link BatteryEstimator}, {@link BreakerThermalModel}, and {@link FinanceDepartment} to predict
 * sag, track breaker heat, and compute the dynamic drive-current allocation.
 *
 * <pre>{@code
 * // in RobotContainer, after your motors exist:
 * var monitor = new MotorCurrentMonitor();
 * monitor.driveGroup("Swerve Drive", BreakerRatings.DRIVE)
 *     .addMotor(() -> flDrive.getSupplyCurrent().getValueAsDouble())
 *     .addMotor(() -> frDrive.getSupplyCurrent().getValueAsDouble()) ...;
 * monitor.group("Elevator", BreakerRatings.INDEXER)
 *     .addMotor(() -> elevatorLeft.getOutputCurrent())
 *     .addMotor(() -> elevatorRight.getOutputCurrent());
 * }</pre>
 */
public class MotorCurrentMonitor extends SubsystemBase {

  private static final double WARNING_THROTTLE_SECONDS = 1.0;
  private static final double NEAR_BREAKER_FRACTION = 0.90;

  /** A named subsystem = one or more motor current suppliers, summed each loop. */
  public static final class Group {
    private final String name;
    private final boolean isDrive; // the drivetrain: protected, never auto-shed
    private final double breakerAmps;
    private final List<DoubleSupplier> motors = new ArrayList<>();
    private double current; // last summed current (A)

    private Group(String name, boolean isDrive, double breakerAmps) {
      this.name = name;
      this.isDrive = isDrive;
      this.breakerAmps = breakerAmps;
    }

    /** Add one motor's current source (amps). Chainable. */
    public Group addMotor(DoubleSupplier currentAmps) {
      motors.add(currentAmps);
      return this;
    }

    private double sum() {
      double s = 0;
      for (DoubleSupplier m : motors) {
        s += Math.max(0.0, m.getAsDouble());
      }
      current = s;
      return s;
    }

    public String name() {
      return name;
    }

    public double current() {
      return current;
    }

    public double breakerAmps() {
      return breakerAmps;
    }
  }

  private final List<Group> groups = new ArrayList<>();

  // Estimation / allocation (reused, unchanged).
  private final BatteryEstimator battery = new BatteryEstimator(18.0, 1.0, 0.3);
  private final BreakerThermalModel breaker =
      new BreakerThermalModel(PowerConstants.MAIN_BREAKER_AMPS, 40.0);
  private final FinanceDepartment finance = new FinanceDepartment(battery, breaker);
  private volatile double driveCurrentAllocation = PowerConstants.MAIN_BREAKER_AMPS;
  private boolean financeEnabled = true;

  // Optional REV PDH for full-system truth (total current + bus voltage). Reading a PDH that
  // isn't present just returns ~0, so we sanity-check its voltage and fall back to the roboRIO.
  private final PowerDistribution pdh =
      new PowerDistribution(PowerConstants.PDH_CAN_ID, PowerDistribution.ModuleType.kRev);

  // NetworkTables + DataLog.
  private final NetworkTable table = NetworkTableInstance.getDefault().getTable("PowerMonitor");
  private final DoublePublisher totalCurrentPub = table.getDoubleTopic("MotorTotalCurrent").publish();
  private final DoublePublisher pdhTotalPub = table.getDoubleTopic("PdhTotalCurrent").publish();
  private final DoublePublisher busVoltagePub = table.getDoubleTopic("BusVoltage").publish();
  private final DoublePublisher socPub = table.getDoubleTopic("estimator/SOC").publish();
  private final DoublePublisher thermalPub = table.getDoubleTopic("estimator/BreakerThermal").publish();
  private final DoublePublisher permissiblePub = table.getDoubleTopic("finance/PermissibleTotalA").publish();
  private final DoublePublisher driveAllocPub = table.getDoubleTopic("finance/DriveAllocationA").publish();
  private final StringPublisher statusPub = table.getStringTopic("Status").publish();
  private final List<DoublePublisher> groupPub = new ArrayList<>();
  private final List<DoubleLogEntry> groupLog = new ArrayList<>();

  private final DataLog log = DataLogManager.getLog();
  private final DoubleLogEntry logTotal = new DoubleLogEntry(log, "/power/motorTotalCurrent");
  private final DoubleLogEntry logVoltage = new DoubleLogEntry(log, "/power/busVoltage");
  private final DoubleLogEntry logSoc = new DoubleLogEntry(log, "/power/estimator/soc");

  private final ShuffleboardTab tab = Shuffleboard.getTab("Power (motors)");

  // Brownout + alert throttling.
  private int brownoutCount = 0;
  private boolean wasBrownedOut = false;
  private double minVoltage = PowerConstants.NOMINAL_VOLTAGE;
  private double lastLowVoltageWarn = -WARNING_THROTTLE_SECONDS;
  private double lastHighCurrentWarn = -WARNING_THROTTLE_SECONDS;
  private double lastBreakerWarn = -WARNING_THROTTLE_SECONDS;

  public MotorCurrentMonitor() {
    DataLogManager.start();
    DriverStation.startDataLog(log);
  }

  /** Register the drivetrain group (protected from load-shedding, gets the finance allocation). */
  public Group driveGroup(String name, double breakerAmps) {
    return addGroup(name, true, breakerAmps);
  }

  /** Register a non-drive subsystem group. */
  public Group group(String name, double breakerAmps) {
    return addGroup(name, false, breakerAmps);
  }

  private Group addGroup(String name, boolean isDrive, double breakerAmps) {
    Group g = new Group(name, isDrive, breakerAmps);
    groups.add(g);
    groupPub.add(table.getDoubleTopic("motor/" + name).publish());
    groupLog.add(new DoubleLogEntry(log, "/power/motor/" + name));
    tab.addDouble(name + " (A)", g::current)
        .withWidget(BuiltInWidgets.kNumberBar)
        .withProperties(Map.of("Min", 0, "Max", breakerAmps));
    return g;
  }

  @Override
  public void periodic() {
    final double now = Timer.getFPGATimestamp();
    final double dt = PowerConstants.LOOP_PERIOD_SECONDS;

    // 1) Sum each subsystem's motor currents; track the protected drive group separately.
    double motorTotal = 0;
    double driveCurrent = 0;
    for (Group g : groups) {
      double c = g.sum();
      motorTotal += c;
      if (g.isDrive) driveCurrent += c;
    }

    // 2) Prefer the PDH for full-system total + bus voltage (captures non-motor loads too);
    //    fall back to the roboRIO if no PDH is present (its reads sanity-check to ~0V).
    final double pdhVoltage = pdh.getVoltage();
    final boolean pdhOk = pdhVoltage > 4.0;
    final double pdhTotal = pdh.getTotalCurrent();
    final double voltage = pdhOk ? pdhVoltage : RobotController.getBatteryVoltage();
    final double total = pdhOk ? pdhTotal : motorTotal; // system total for estimation
    final double reservedNonDrive = Math.max(0.0, total - driveCurrent);
    updateBrownout(voltage);

    // 3) Estimate + allocate on the system total.
    battery.update(voltage, total, dt);
    breaker.update(total, dt);
    if (financeEnabled) {
      driveCurrentAllocation = finance.allocate(reservedNonDrive);
    }

    publishAndLog(motorTotal, pdhTotal, voltage);
    runAlerts(now, voltage, total);
    statusPub.set(statusFor(voltage, total));
  }

  private void updateBrownout(double voltage) {
    if (voltage < minVoltage) minVoltage = voltage;
    boolean browned = RobotController.isBrownedOut();
    if (browned && !wasBrownedOut) {
      brownoutCount++;
      DriverStation.reportError("BROWNOUT #" + brownoutCount + " (bus " + round(voltage) + "V)", false);
      table.getDoubleTopic("BrownoutCount").publish().set(brownoutCount);
    }
    wasBrownedOut = browned;
  }

  private void publishAndLog(double motorTotal, double pdhTotal, double voltage) {
    totalCurrentPub.set(motorTotal);
    pdhTotalPub.set(pdhTotal);
    busVoltagePub.set(voltage);
    socPub.set(battery.soc());
    thermalPub.set(breaker.thermalState());
    permissiblePub.set(finance.permissibleTotalCurrent());
    driveAllocPub.set(driveCurrentAllocation);

    logTotal.append(motorTotal);
    logVoltage.append(voltage);
    logSoc.append(battery.soc());
    for (int i = 0; i < groups.size(); i++) {
      double c = groups.get(i).current();
      groupPub.get(i).set(c);
      groupLog.get(i).append(c);
    }
  }

  private void runAlerts(double now, double voltage, double total) {
    if (voltage < PowerConstants.LOW_VOLTAGE_WARNING && now - lastLowVoltageWarn > WARNING_THROTTLE_SECONDS) {
      DriverStation.reportWarning("Low bus voltage " + round(voltage) + "V - brownout risk", false);
      lastLowVoltageWarn = now;
    }
    if (total > PowerConstants.TOTAL_CURRENT_BUDGET_AMPS && now - lastHighCurrentWarn > WARNING_THROTTLE_SECONDS) {
      DriverStation.reportWarning("Motor current " + round(total) + "A - approaching budget", false);
      lastHighCurrentWarn = now;
    }
    for (Group g : groups) {
      if (g.current() > g.breakerAmps() * NEAR_BREAKER_FRACTION
          && now - lastBreakerWarn > WARNING_THROTTLE_SECONDS) {
        DriverStation.reportWarning(
            g.name() + " " + round(g.current()) + "A near " + round(g.breakerAmps()) + "A breaker", false);
        lastBreakerWarn = now;
      }
    }
  }

  private String statusFor(double voltage, double total) {
    if (voltage < PowerConstants.LOW_VOLTAGE_WARNING || total > PowerConstants.TOTAL_CURRENT_BUDGET_AMPS) return "RED";
    if (total > PowerConstants.TOTAL_CURRENT_CAUTION_AMPS) return "YELLOW";
    return "GREEN";
  }

  private static double round(double v) {
    return Math.round(v * 10.0) / 10.0;
  }

  // ---- Accessors for your mechanisms / commands ----

  /** Dynamic current limit (A) the finance dept. allocates to the drivetrain this loop. */
  public double driveCurrentAllocation() {
    return driveCurrentAllocation;
  }

  public double stateOfCharge() {
    return battery.soc();
  }

  public double breakerThermalState() {
    return breaker.thermalState();
  }

  public double permissibleTotalCurrent() {
    return finance.permissibleTotalCurrent();
  }

  public int brownoutCount() {
    return brownoutCount;
  }

  public double minBusVoltage() {
    return minVoltage;
  }

  public void setFinanceEnabled(boolean enabled) {
    financeEnabled = enabled;
    if (!enabled) driveCurrentAllocation = PowerConstants.MAIN_BREAKER_AMPS;
  }

  public void setBatteryAge(double ageFactor) {
    battery.setAgeFactor(ageFactor);
  }
}
