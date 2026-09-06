# Integrating the power monitor into the real robot (motor-current / 6328 style)

Reads per-subsystem current **from the motor controllers by CAN ID** — no PDH port mapping. Reuses
`BatteryEstimator`, `BreakerThermalModel`, `FinanceDepartment`, and `MotorCurrentMonitor` (in
`frc/robot/power/`).

**Every motor on this robot is a Kraken / TalonFX** (confirmed from the `...IOTalonFX` layers on
`glendale-working-branch`), so it's fully uniform — `getSupplyCurrent()` everywhere. Two CAN buses:
**swerve is on a CANivore named `"Canivore"`**, everything else is on `"rio"`.

## Full CAN map (from the repo — nothing left to confirm)
| Subsystem | Motors | CAN IDs | Bus |
| --- | --- | --- | --- |
| Swerve Drive | KrakenX60 ×4 | 1 (FR), 4 (FL), 7 (BL), 10 (BR) | `Canivore` |
| Swerve Steer | KrakenX44 ×4 | 3 (FR), 6 (FL), 9 (BL), 12 (BR) | `Canivore` |
| Shooter | TalonFX ×2 | 19, 20 | `rio` |
| Feeder | TalonFX ×3 | 14 (pan), 15 (floor), 23 (pusher) | `rio` |
| Intake | TalonFX ×2 | 24, 25 | `rio` |
| Hood | TalonFX ×1 | 21 | `rio` |
| Turret | TalonFX ×1 | 17 | `rio` |

*(CANcoders 2/5/8/11, 18, 22 aren't motors — skipped.)*

## 1. Copy the code in
Copy the whole `power/` package into your robot project (package `frc.robot`, so `frc.robot.power`
fits) — it's **self-contained** (no dependency on your `Constants.java`; thresholds live in
`PowerConstants`):
```
power/PowerConstants.java     power/BatteryEstimator.java   power/BreakerThermalModel.java
power/FinanceDepartment.java  power/MotorCurrentMonitor.java
```
You already have Phoenix 6 — no new vendordeps.

## 2. Register in RobotContainer
Because every motor is a TalonFX (and Phoenix 6 allows multiple handles per device), just make
read-only handles by CAN ID — no need to touch your `...IOTalonFX` subsystems:

```java
import com.ctre.phoenix6.hardware.TalonFX;
import java.util.function.DoubleSupplier;
import frc.robot.Constants.*;

private final MotorCurrentMonitor powerMonitor = new MotorCurrentMonitor();

/** Read-only supply-current source for a TalonFX by CAN ID on a given bus. */
private static DoubleSupplier talon(int canId, String canbus) {
  TalonFX fx = new TalonFX(canId, canbus);
  var sig = fx.getSupplyCurrent();
  sig.setUpdateFrequency(50);                 // default 4 Hz — bump for live monitoring
  return () -> sig.refresh().getValueAsDouble();
}

private void configurePowerMonitor() {
  final String CANIVORE = "Canivore";   // swerve bus
  final String RIO = "rio";             // mechanism bus

  // Swerve DRIVE (KrakenX60) — protected: shed last, gets the finance allocation
  powerMonitor.driveGroup("Swerve Drive", 160.0)
      .addMotor(talon(1, CANIVORE)).addMotor(talon(4, CANIVORE))
      .addMotor(talon(7, CANIVORE)).addMotor(talon(10, CANIVORE));

  // Swerve STEER (KrakenX44)
  powerMonitor.group("Swerve Steer", 100.0)
      .addMotor(talon(3, CANIVORE)).addMotor(talon(6, CANIVORE))
      .addMotor(talon(9, CANIVORE)).addMotor(talon(12, CANIVORE));

  powerMonitor.group("Shooter", 100.0)
      .addMotor(talon(ShooterConstants.LEFT_FLYWHEEL_ID, RIO))   // 19
      .addMotor(talon(ShooterConstants.RIGHT_FLYWHEEL_ID, RIO)); // 20

  powerMonitor.group("Feeder", 120.0)
      .addMotor(talon(FeederConstants.PAN_MOTOR_ID, RIO))        // 14
      .addMotor(talon(FeederConstants.FLOOR_ID, RIO))           // 15
      .addMotor(talon(FeederConstants.PUSHER_MOTOR_ID, RIO));    // 23

  powerMonitor.group("Intake", 60.0)
      .addMotor(talon(IntakeConstants.LEFT_MOTOR_ID, RIO))       // 24
      .addMotor(talon(IntakeConstants.RIGHT_MOTOR_ID, RIO));     // 25

  powerMonitor.group("Hood", 40.0)
      .addMotor(talon(HoodConstants.HOOD_MOTOR_ID, RIO));        // 21

  powerMonitor.group("Turret", 30.0)
      .addMotor(talon(TurretConstants.MOTOR_ID, RIO));           // 17
}
```
Call `configurePowerMonitor()` from your `RobotContainer` constructor. The scheduler runs
`MotorCurrentMonitor.periodic()` automatically.

## 3. Use the outputs
- NetworkTables `PowerMonitor/motor/<name>`, a **"Power (motors)"** Shuffleboard tab, and DataLog
  `/power/motor/<name>`. Bus voltage + brownout from the roboRIO (`PowerMonitor/BusVoltage`,
  `BrownoutCount`).
- For the finance dept. to act, feed `powerMonitor.driveCurrentAllocation()` into the swerve drive
  Krakens' stator-current limit each loop. `setFinanceEnabled(false)` disables it.

## Notes
- The group capacities (160/100/… A) are for the dashboard bar scale + near-limit warnings — tune to
  taste; they don't affect the readings.
- **Per-subsystem** numbers come from **motor supply current** (mechanisms only). **Full-system
  truth** is built in: the monitor also opens the REV PDH at `Constants.PDH_CAN_ID` and publishes
  `PowerMonitor/PdhTotalCurrent` + uses PDH bus voltage for the estimator (falling back to the
  roboRIO if no PDH is present). So you get both — per-subsystem motor draw *and* the true total
  including non-motor loads — with no channel mapping.
