package frc.robot.subsystems;

import edu.wpi.first.networktables.DoublePublisher;
import edu.wpi.first.networktables.NetworkTable;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.networktables.StringPublisher;
import edu.wpi.first.util.datalog.DataLog;
import edu.wpi.first.util.datalog.DoubleLogEntry;
import edu.wpi.first.util.datalog.IntegerLogEntry;
import edu.wpi.first.wpilibj.DataLogManager;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.PowerDistribution;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.Timer;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import frc.robot.Constants;
import frc.robot.Constants.PowerBudget;
import frc.robot.power.BatteryEstimator;
import frc.robot.power.BreakerThermalModel;
import frc.robot.power.CurrentLimited;
import frc.robot.power.FinanceDepartment;
import frc.robot.power.LoadShedder;
import frc.robot.power.PowerSubsystem;
import java.util.function.DoubleSupplier;

/**
 * Real-time power / electrical monitor for Team 6560 (design doc &sect;4).
 *
 * <p>Every loop this subsystem:
 * <ul>
 *   <li>reads per-channel current, bus voltage, total current and total energy from the REV PDH;
 *   <li>logs everything to the on-robot DataLog for post-match replay (&sect;4.2);
 *   <li>publishes a color-coded live view to NetworkTables/Shuffleboard (&sect;4.4);
 *   <li>fires threshold warnings for low voltage / high total current / near-breaker channels (&sect;4.3);
 *   <li>records brownout events even when they are too brief for the driver to notice (&sect;3.3);
 *   <li>runs the automatic {@link LoadShedder} priority strategy (&sect;3.3, &sect;6).
 * </ul>
 *
 * <p>Warnings are rate-limited so we don't flood the Driver Station console.
 */
public class PowerMonitorSubsystem extends SubsystemBase {

  private static final double WARNING_THROTTLE_SECONDS = 1.0;

  private final PowerDistribution pdh;
  private final LoadShedder loadShedder = new LoadShedder();

  // ---- Battery / breaker estimation + dynamic current allocation (the "finance department") ----
  private final BatteryEstimator battery = new BatteryEstimator(18.0, 1.0, 0.3);
  private final BreakerThermalModel breaker =
      new BreakerThermalModel(PowerBudget.MAIN_BREAKER_AMPS, 40.0);
  private final FinanceDepartment finance = new FinanceDepartment(battery, breaker);
  private volatile double driveCurrentAllocation = PowerBudget.MAIN_BREAKER_AMPS;
  private boolean financeEnabled = true;

  // ---- NetworkTables (live dashboard) ----
  private final NetworkTable table =
      NetworkTableInstance.getDefault().getTable("PowerMonitor");
  private final DoublePublisher busVoltagePub = table.getDoubleTopic("BusVoltage").publish();
  private final DoublePublisher totalCurrentPub = table.getDoubleTopic("TotalCurrent").publish();
  private final DoublePublisher totalEnergyPub = table.getDoubleTopic("TotalEnergyJ").publish();
  private final StringPublisher statusPub = table.getStringTopic("Status").publish();
  private final StringPublisher shedStatusPub = table.getStringTopic("LoadShedding").publish();
  private final DoublePublisher socPub = table.getDoubleTopic("estimator/SOC").publish();
  private final DoublePublisher predVoltPub = table.getDoubleTopic("estimator/PredictedV").publish();
  private final DoublePublisher breakerThermalPub =
      table.getDoubleTopic("estimator/BreakerThermal").publish();
  private final DoublePublisher permissiblePub =
      table.getDoubleTopic("finance/PermissibleTotalA").publish();
  private final DoublePublisher driveAllocPub =
      table.getDoubleTopic("finance/DriveAllocationA").publish();
  private final DoublePublisher[] subsystemCurrentPub;

  // ---- DataLog (post-match replay) ----
  private final DataLog log = DataLogManager.getLog();
  private final DoubleLogEntry logBusVoltage = new DoubleLogEntry(log, "/power/busVoltage");
  private final DoubleLogEntry logTotalCurrent = new DoubleLogEntry(log, "/power/totalCurrent");
  private final DoubleLogEntry logTotalEnergy = new DoubleLogEntry(log, "/power/totalEnergyJ");
  private final IntegerLogEntry logBrownoutCount =
      new IntegerLogEntry(log, "/power/brownoutCount");
  private final DoubleLogEntry logSoc = new DoubleLogEntry(log, "/power/estimator/soc");
  private final DoubleLogEntry logBreakerThermal =
      new DoubleLogEntry(log, "/power/estimator/breakerThermal");
  private final DoubleLogEntry logDriveAllocation =
      new DoubleLogEntry(log, "/power/finance/driveAllocationA");
  private final DoubleLogEntry[] logSubsystemCurrent;

  // ---- Brownout tracking ----
  private int brownoutEventCount = 0;
  private boolean wasBrownedOut = false;
  private double minBusVoltageThisSession = PowerBudget.NOMINAL_VOLTAGE;

  // ---- Warning throttle timestamps ----
  private double lastLowVoltageWarn = -WARNING_THROTTLE_SECONDS;
  private double lastHighCurrentWarn = -WARNING_THROTTLE_SECONDS;
  private double lastBreakerWarn = -WARNING_THROTTLE_SECONDS;

  public PowerMonitorSubsystem() {
    this.pdh = new PowerDistribution(Constants.PDH_CAN_ID, PowerDistribution.ModuleType.kRev);

    // Make sure DataLog is running so /power entries are captured even before Robot enables it.
    DataLogManager.start();
    DriverStation.startDataLog(log);

    PowerSubsystem[] subsystems = PowerSubsystem.values();
    subsystemCurrentPub = new DoublePublisher[subsystems.length];
    logSubsystemCurrent = new DoubleLogEntry[subsystems.length];
    for (int i = 0; i < subsystems.length; i++) {
      String name = subsystems[i].label();
      subsystemCurrentPub[i] = table.getDoubleTopic("current/" + name).publish();
      logSubsystemCurrent[i] = new DoubleLogEntry(log, "/power/current/" + name);
    }

    // Publish the static budget lines once so dashboard gauges can draw threshold markers.
    table.getDoubleTopic("budget/totalCurrentAmps").publish().set(PowerBudget.TOTAL_CURRENT_BUDGET_AMPS);
    table.getDoubleTopic("budget/cautionAmps").publish().set(PowerBudget.TOTAL_CURRENT_CAUTION_AMPS);
    table.getDoubleTopic("budget/lowVoltage").publish().set(PowerBudget.LOW_VOLTAGE_WARNING);

    // Build the driver-station Shuffleboard tab (design doc §4.4).
    DoubleSupplier[] subsystemCurrentSuppliers = new DoubleSupplier[subsystems.length];
    for (int i = 0; i < subsystems.length; i++) {
      final PowerSubsystem sub = subsystems[i];
      subsystemCurrentSuppliers[i] = () -> subsystemCurrent(sub);
    }
    frc.robot.power.PowerDashboard.build(
        this::busVoltage,
        this::totalCurrent,
        this::energyJoules,
        this::brownoutEventCount,
        this::minBusVoltageThisSession,
        () -> statusFor(busVoltage(), totalCurrent()),
        () -> loadShedder.isShedding() ? loadShedder.shedStatus() : "nominal",
        subsystemCurrentSuppliers);
  }

  /**
   * Register a mechanism subsystem so it can be automatically current-limited during a
   * brownout risk. Call this from {@code RobotContainer} once per sheddable subsystem.
   */
  public void registerForLoadShedding(CurrentLimited mechanism) {
    loadShedder.register(mechanism);
  }

  @Override
  public void periodic() {
    final double now = Timer.getFPGATimestamp();
    final double busVoltage = pdh.getVoltage();
    final double totalCurrent = pdh.getTotalCurrent();
    final double totalEnergy = pdh.getTotalEnergy();

    updateBrownoutTracking(busVoltage);
    publishAndLogAggregate(busVoltage, totalCurrent, totalEnergy);
    publishAndLogPerSubsystem(now);
    runThresholdAlerts(now, busVoltage, totalCurrent);

    // Priority-based automatic load shedding (drivetrain is protected).
    loadShedder.update(totalCurrent);
    shedStatusPub.set(loadShedder.isShedding() ? loadShedder.shedStatus() : "nominal");

    updateEstimatorAndFinance(busVoltage, totalCurrent);

    statusPub.set(statusFor(busVoltage, totalCurrent));
  }

  /**
   * Advance the battery estimator + breaker thermal model, then let the finance department
   * recompute the drivetrain's dynamic current allocation from their forward projections.
   */
  private void updateEstimatorAndFinance(double busVoltage, double totalCurrent) {
    battery.update(busVoltage, totalCurrent, Constants.LOOP_PERIOD_SECONDS);
    breaker.update(totalCurrent, Constants.LOOP_PERIOD_SECONDS);

    if (financeEnabled) {
      double reservedNonDrive = subsystemCurrent(PowerSubsystem.SHOOTER)
          + subsystemCurrent(PowerSubsystem.INTAKE)
          + subsystemCurrent(PowerSubsystem.CLIMBER)
          + subsystemCurrent(PowerSubsystem.INDEXER)
          + subsystemCurrent(PowerSubsystem.TURRET);
      driveCurrentAllocation = finance.allocate(reservedNonDrive);
    }

    socPub.set(battery.soc());
    predVoltPub.set(battery.predictedVoltage());
    breakerThermalPub.set(breaker.thermalState());
    permissiblePub.set(finance.permissibleTotalCurrent());
    driveAllocPub.set(driveCurrentAllocation);

    logSoc.append(battery.soc());
    logBreakerThermal.append(breaker.thermalState());
    logDriveAllocation.append(driveCurrentAllocation);
  }

  private void updateBrownoutTracking(double busVoltage) {
    if (busVoltage < minBusVoltageThisSession) {
      minBusVoltageThisSession = busVoltage;
      table.getDoubleTopic("MinBusVoltage").publish().set(minBusVoltageThisSession);
    }

    // Latch brownout events on the rising edge so one dip counts once, not every loop.
    boolean brownedOut = RobotController.isBrownedOut();
    if (brownedOut && !wasBrownedOut) {
      brownoutEventCount++;
      logBrownoutCount.append(brownoutEventCount);
      DriverStation.reportError(
          "BROWNOUT #" + brownoutEventCount + " (bus " + round(busVoltage) + "V)", false);
      table.getDoubleTopic("BrownoutCount").publish().set(brownoutEventCount);
    }
    wasBrownedOut = brownedOut;
  }

  private void publishAndLogAggregate(double busVoltage, double totalCurrent, double totalEnergy) {
    busVoltagePub.set(busVoltage);
    totalCurrentPub.set(totalCurrent);
    totalEnergyPub.set(totalEnergy);

    logBusVoltage.append(busVoltage);
    logTotalCurrent.append(totalCurrent);
    logTotalEnergy.append(totalEnergy);
  }

  private void publishAndLogPerSubsystem(double now) {
    PowerSubsystem[] subsystems = PowerSubsystem.values();
    for (int i = 0; i < subsystems.length; i++) {
      double current = subsystemCurrent(subsystems[i]);
      subsystemCurrentPub[i].set(current);
      logSubsystemCurrent[i].append(current);
    }
  }

  private void runThresholdAlerts(double now, double busVoltage, double totalCurrent) {
    // Low bus voltage -> brownout risk (design doc &sect;4.3).
    if (busVoltage < PowerBudget.LOW_VOLTAGE_WARNING
        && now - lastLowVoltageWarn > WARNING_THROTTLE_SECONDS) {
      DriverStation.reportWarning(
          "Low bus voltage " + round(busVoltage) + "V - brownout risk", false);
      lastLowVoltageWarn = now;
    }

    // Approaching total current budget (design doc &sect;4.3).
    if (totalCurrent > PowerBudget.TOTAL_CURRENT_BUDGET_AMPS
        && now - lastHighCurrentWarn > WARNING_THROTTLE_SECONDS) {
      DriverStation.reportWarning(
          "Total current " + round(totalCurrent) + "A - approaching budget", false);
      lastHighCurrentWarn = now;
    }

    // Any channel nearing its breaker rating (design doc &sect;2.2 traceability).
    for (PowerSubsystem sub : PowerSubsystem.values()) {
      for (int channel : sub.channels()) {
        if (pdh.getCurrent(channel) > sub.breakerWarnAmps()
            && now - lastBreakerWarn > WARNING_THROTTLE_SECONDS) {
          DriverStation.reportWarning(
              sub.label()
                  + " ch"
                  + channel
                  + " "
                  + round(pdh.getCurrent(channel))
                  + "A near "
                  + round(sub.breakerRatingAmps())
                  + "A breaker",
              false);
          lastBreakerWarn = now;
        }
      }
    }
  }

  /** Sum the current on all channels belonging to a subsystem. */
  private double subsystemCurrent(PowerSubsystem sub) {
    double sum = 0.0;
    for (int channel : sub.channels()) {
      sum += pdh.getCurrent(channel);
    }
    return sum;
  }

  /** Coarse red/yellow/green status string for the dashboard status tile. */
  private String statusFor(double busVoltage, double totalCurrent) {
    if (busVoltage < PowerBudget.LOW_VOLTAGE_WARNING
        || totalCurrent > PowerBudget.TOTAL_CURRENT_BUDGET_AMPS) {
      return "RED";
    }
    if (totalCurrent > PowerBudget.TOTAL_CURRENT_CAUTION_AMPS) {
      return "YELLOW";
    }
    return "GREEN";
  }

  private static double round(double v) {
    return Math.round(v * 10.0) / 10.0;
  }

  // ---- Accessors for other subsystems / commands ----

  public double busVoltage() {
    return pdh.getVoltage();
  }

  public double totalCurrent() {
    return pdh.getTotalCurrent();
  }

  public double energyJoules() {
    return pdh.getTotalEnergy();
  }

  public int brownoutEventCount() {
    return brownoutEventCount;
  }

  public double minBusVoltageThisSession() {
    return minBusVoltageThisSession;
  }

  public boolean isSheddingLoad() {
    return loadShedder.isShedding();
  }

  /** Restore all shed subsystems, e.g. at the start of teleop/auto. */
  public void resetLoadShedding() {
    loadShedder.restoreAll();
  }

  /** Reset per-session min-voltage / energy accounting, e.g. at match start. */
  public void resetSessionStats() {
    minBusVoltageThisSession = PowerBudget.NOMINAL_VOLTAGE;
    pdh.resetTotalEnergy();
  }

  /** Remotely disable a switchable channel (e.g. a shorted compressor). Design doc &sect;2.2. */
  public void setSwitchableChannel(boolean on) {
    pdh.setSwitchableChannel(on);
  }

  // ---- Battery estimator / finance department ----

  /**
   * Dynamic current limit (A) the finance department has allocated to the drivetrain this loop.
   * The drivetrain subsystem should read this and push it to its motor controllers each loop so it
   * uses the full safe headroom of the battery. Falls back to the full main-breaker rating if the
   * finance department is disabled.
   */
  public double driveCurrentAllocation() {
    return driveCurrentAllocation;
  }

  /** Estimated battery state of charge, 0..1. */
  public double stateOfCharge() {
    return battery.soc();
  }

  /** Model-predicted terminal voltage (V) from the Thevenin estimator. */
  public double predictedVoltage() {
    return battery.predictedVoltage();
  }

  /** Main-breaker thermal state, 0 (cold) .. 1 (trip). */
  public double breakerThermalState() {
    return breaker.thermalState();
  }

  /** Max total bus current (A) the finance department projects as safe right now. */
  public double permissibleTotalCurrent() {
    return finance.permissibleTotalCurrent();
  }

  /** Enable/disable dynamic allocation. When off, the drivetrain uses its static limit. */
  public void setFinanceEnabled(boolean enabled) {
    financeEnabled = enabled;
    if (!enabled) driveCurrentAllocation = PowerBudget.MAIN_BREAKER_AMPS;
  }

  /** Update the modeled battery age (0 = fresh, 1 = old) — e.g. from a dashboard chooser. */
  public void setBatteryAge(double ageFactor) {
    battery.setAgeFactor(ageFactor);
  }
}
