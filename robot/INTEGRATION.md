# Integrating the power monitor into the real robot (motor-current / 6328 style)

This wires the monitor to read per-subsystem current **from the motor controllers by CAN ID** —
no PDH port mapping, no wire tracing. It reuses `BatteryEstimator`, `BreakerThermalModel`,
`FinanceDepartment`, and the new `MotorCurrentMonitor` (all in `frc/robot/power/`).

## 1. Copy the code in
Copy these into your robot project (`com.team6560.frc2026`), fixing the `package` line to match
wherever you put them (e.g. `com.team6560.frc2026.power`):

```
power/BatteryEstimator.java
power/BreakerThermalModel.java
power/FinanceDepartment.java
power/MotorCurrentMonitor.java
```

You already have the **Phoenix 6** and **REVLib** vendordeps, so no new dependencies are needed.
`MotorCurrentMonitor` itself is vendor-agnostic (it only takes `DoubleSupplier`s of amps) — the
Phoenix/REV calls live in your `RobotContainer` below.

## 2. Register your subsystems in RobotContainer
The pattern: one `group(...)` per subsystem, then `.addMotor(() -> <amps>)` per motor.

- **Kraken / TalonFX** (Phoenix 6): `motor.getSupplyCurrent().getValueAsDouble()`
- **SPARK MAX** (REVLib): `motor.getOutputCurrent()`

```java
private final MotorCurrentMonitor powerMonitor = new MotorCurrentMonitor();

private void configurePowerMonitor() {
  // --- Swerve DRIVE — Kraken/TalonFX, CAN 1, 4, 7, 10 (protected: shed last) ---
  powerMonitor.driveGroup("Swerve Drive", 160.0)   // ~4 x 40A group capacity
      .addMotor(() -> flDrive.getSupplyCurrent().getValueAsDouble())
      .addMotor(() -> frDrive.getSupplyCurrent().getValueAsDouble())
      .addMotor(() -> blDrive.getSupplyCurrent().getValueAsDouble())
      .addMotor(() -> brDrive.getSupplyCurrent().getValueAsDouble());

  // --- Swerve STEER — SPARK MAX, CAN 2, 5, 8, 11 ---
  powerMonitor.group("Swerve Steer", 120.0)
      .addMotor(() -> flSteer.getOutputCurrent())
      .addMotor(() -> frSteer.getOutputCurrent())
      .addMotor(() -> blSteer.getOutputCurrent())
      .addMotor(() -> brSteer.getOutputCurrent());

  // --- Elevator — CAN 14, 15  (confirm motor type; using getOutputCurrent for SPARK MAX) ---
  powerMonitor.group("Elevator", 80.0)
      .addMotor(() -> elevatorLeft.getOutputCurrent())
      .addMotor(() -> elevatorRight.getOutputCurrent());

  // --- Wrist — CAN 16 ---
  powerMonitor.group("Wrist", 40.0)
      .addMotor(() -> wrist.getOutputCurrent());

  // --- Climb — CAN 20, 21 ---
  powerMonitor.group("Climb", 80.0)
      .addMotor(() -> climb1.getOutputCurrent())
      .addMotor(() -> climb2.getOutputCurrent());
}
```

Call `configurePowerMonitor()` from your `RobotContainer` constructor, after the motor objects
exist. That's it — the command scheduler runs `MotorCurrentMonitor.periodic()` automatically.

## 3. Where do the motor objects come from?
- **Elevator / Wrist / Climb**: use the `SparkMax` / `TalonFX` objects your subsystems already
  create — expose a getter (e.g. `elevator.leftMotor()`), or move the registration into each
  subsystem.
- **Swerve (YAGSL)**: your drive/steer motors live inside the YAGSL `SwerveDrive`. Two options:
  1. If your YAGSL version exposes the raw controllers, read them via
     `swerveDrive.getModules()[i]...`.
  2. **Simplest for the Krakens:** because Phoenix 6 allows multiple `TalonFX` objects for the
     same device, just make read-only handles by CAN ID and register those:
     ```java
     TalonFX flDrive = new TalonFX(1);   // read-only monitor handle, safe to duplicate
     TalonFX frDrive = new TalonFX(4);
     TalonFX blDrive = new TalonFX(7);
     TalonFX brDrive = new TalonFX(10);
     ```
     (Do **not** do this for the SPARK MAX steer motors — don't duplicate a `SparkMax` object;
     use the existing one and its `getOutputCurrent()`.)

## 4. Use the outputs
- Live data publishes to NetworkTables under `PowerMonitor/motor/<name>`, plus a **"Power
  (motors)"** Shuffleboard tab, and logs to `/power/motor/<name>` in the DataLog.
- For the **finance department** to actually help, have your drivetrain read
  `powerMonitor.driveCurrentAllocation()` each loop and push it to the Kraken stator-current
  limit. `powerMonitor.setFinanceEnabled(false)` disables dynamic allocation.

## Confirm before you trust the numbers
> **CAN IDs** below are read from your repo (swerve JSONs + `Constants.java`). Confirm them, and
> confirm the **motor type** for elevator / wrist / climb so the current call is right
> (`getSupplyCurrent()` for Kraken, `getOutputCurrent()` for SPARK MAX):

| Subsystem | CAN IDs | Assumed type | Current call |
| --- | --- | --- | --- |
| Swerve Drive | 1, 4, 7, 10 | KrakenX60 | `getSupplyCurrent().getValueAsDouble()` |
| Swerve Steer | 2, 5, 8, 11 | SPARK MAX | `getOutputCurrent()` |
| Elevator | 14, 15 | **confirm** | — |
| Wrist | 16 | **confirm** | — |
| Climb | 20, 21 | **confirm** | — |

Send me the confirmed CAN IDs + motor types and I'll finalize the snippet exactly for your motors.

## Note vs. the PDH path
This measures **motor supply current**, so it captures the mechanisms but not non-motor loads
(radio, RIO, pneumatics, LEDs), and the sum won't exactly equal the PDH total. If you also want
the full-system total, keep a `PowerDistribution` object and read `getTotalCurrent()` /
`getVoltage()` alongside — that needs no channel mapping.
