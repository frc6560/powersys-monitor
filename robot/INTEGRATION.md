# Integrating the power monitor into the real robot (motor-current / 6328 style)

Reads per-subsystem current **from the motor controllers by CAN ID** — no PDH port mapping. Reuses
`BatteryEstimator`, `BreakerThermalModel`, `FinanceDepartment`, and `MotorCurrentMonitor` (all in
`frc/robot/power/`).

> Targeted at the real `frc.robot` robot: **Swerve + Shooter + Hood + Turret + Intake + Feeder**.
> CAN IDs below are read from your `Constants.java`; swerve IDs come from your YAGSL config.

## 1. Copy the code in
Copy into your robot project, fixing the `package` line to match (your robot uses `frc.robot`, so
`frc.robot.power` is natural):

```
power/BatteryEstimator.java
power/BreakerThermalModel.java
power/FinanceDepartment.java
power/MotorCurrentMonitor.java
```

You already have **Phoenix 6** (and YAGSL). No new vendordeps needed. `MotorCurrentMonitor` is
vendor-agnostic (takes `DoubleSupplier`s of amps); the Phoenix calls live in `RobotContainer`.

## 2. Register your subsystems in RobotContainer
Because nearly every mechanism is a **Kraken/TalonFX**, and Phoenix 6 allows multiple `TalonFX`
objects per device, you can make **read-only handles by CAN ID** — no need to touch your existing
subsystem objects. Drop this in:

```java
import com.ctre.phoenix6.hardware.TalonFX;
import java.util.function.DoubleSupplier;
import frc.robot.Constants.*;

private final MotorCurrentMonitor powerMonitor = new MotorCurrentMonitor();

/** Read-only supply-current source for a TalonFX by CAN ID (safe to duplicate the device). */
private static DoubleSupplier talon(int canId) {
  TalonFX fx = new TalonFX(canId);
  var sig = fx.getSupplyCurrent();
  sig.setUpdateFrequency(50);                 // default is 4 Hz — bump it for live monitoring
  return () -> sig.refresh().getValueAsDouble();
}

private void configurePowerMonitor() {
  // --- Swerve DRIVE — protected (shed last). CONFIRM CAN IDs from your YAGSL swervedrive JSON ---
  powerMonitor.driveGroup("Swerve Drive", 160.0)
      .addMotor(talon(/* FL drive */ 1))
      .addMotor(talon(/* FR drive */ 2))
      .addMotor(talon(/* BL drive */ 3))
      .addMotor(talon(/* BR drive */ 4));

  // --- Shooter flywheels (Kraken x60), CAN 19, 20 ---
  powerMonitor.group("Shooter", 100.0)
      .addMotor(talon(ShooterConstants.LEFT_FLYWHEEL_ID))    // 19
      .addMotor(talon(ShooterConstants.RIGHT_FLYWHEEL_ID));  // 20

  // --- Feeder (pan / floor / pusher), CAN 14, 15, 23 ---
  powerMonitor.group("Feeder", 120.0)
      .addMotor(talon(FeederConstants.PAN_MOTOR_ID))         // 14
      .addMotor(talon(FeederConstants.FLOOR_ID))             // 15
      .addMotor(talon(FeederConstants.PUSHER_MOTOR_ID));     // 23

  // --- Intake, CAN 24, 25 ---
  powerMonitor.group("Intake", 60.0)
      .addMotor(talon(IntakeConstants.LEFT_MOTOR_ID))        // 24
      .addMotor(talon(IntakeConstants.RIGHT_MOTOR_ID));      // 25

  // --- Hood (TalonFX), CAN 21 ---
  powerMonitor.group("Hood", 40.0)
      .addMotor(talon(HoodConstants.HOOD_MOTOR_ID));         // 21

  // --- Turret, CAN 17  (confirm it's a TalonFX; if SPARK MAX see note below) ---
  powerMonitor.group("Turret", 30.0)
      .addMotor(talon(TurretConstants.MOTOR_ID));            // 17
}
```

Call `configurePowerMonitor()` from your `RobotContainer` constructor. The command scheduler runs
`MotorCurrentMonitor.periodic()` automatically.

### If a motor is a SPARK MAX (not TalonFX)
Don't duplicate a `SparkMax` object. Use the **existing** one and its `getOutputCurrent()`:
```java
powerMonitor.group("Turret", 30.0).addMotor(() -> turret.motor().getOutputCurrent());
```
(Same for swerve **steer** motors if yours are SPARK MAX — register the drive Krakens with `talon(...)`
and the steer motors via their existing objects.)

## 3. Use the outputs
- NetworkTables: `PowerMonitor/motor/<name>`, plus a **"Power (motors)"** Shuffleboard tab; DataLog
  under `/power/motor/<name>`. Bus voltage + brownout come from the roboRIO (`PowerMonitor/BusVoltage`,
  `BrownoutCount`).
- For the **finance dept.** to act, have the drivetrain read `powerMonitor.driveCurrentAllocation()`
  each loop and push it to the drive Krakens' stator-current limit. `setFinanceEnabled(false)` disables it.

## What I still need from you
1. **Swerve drive CAN IDs** (and whether steer is Kraken or SPARK MAX) — from your YAGSL
   `deploy/swerve/.../modules/*.json`. Send them (or the folder) and I'll fill in the swerve block.
2. **Confirm Turret (CAN 17)** is a TalonFX (vs SPARK MAX) — that's the only mechanism whose type I'm
   inferring.

Everything else (Shooter 19/20, Feeder 14/15/23, Intake 24/25, Hood 21) is pulled straight from your
`Constants.java` and ready.

## Note vs. the PDH path
This measures **motor supply current** — captures the mechanisms, not non-motor loads (radio, RIO,
pneumatics, LEDs), and won't exactly equal the PDH total. Ideal for per-subsystem attribution +
brownout prediction. For full-system truth, also keep a `PowerDistribution` and read
`getTotalCurrent()`/`getVoltage()` (no mapping needed).
