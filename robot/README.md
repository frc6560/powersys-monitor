# FRC 6560 — Power Draw & Electrical Systems Monitor

Software implementation of the Team 6560 *Power Draw & Electrical Systems Monitor* design
document. It reads the REV Power Distribution Hub (PDH) live, logs everything for post-match
review, shows a color-coded driver-station dashboard, warns before a brownout, and can
automatically shed non-critical load to protect the drivetrain.

A standard WPILib 2026 Java (command-based) project — import it in WPILib VS Code, set your
CAN IDs / channels, and deploy.

## What it does

| Design doc section | Implemented by |
| --- | --- |
| §2.2 Channel allocation & breaker ratings | [`Constants.java`](src/main/java/frc/robot/Constants.java) — `Channels`, `BreakerRatings` |
| §3.2 Smart current limits | `Constants.CurrentLimits` |
| §3.1 / §4.3 Total budget & thresholds | `Constants.PowerBudget` + threshold alerts in the monitor |
| §2.2 / §3.3 Subsystem→channel map & shed priority | [`PowerSubsystem.java`](src/main/java/frc/robot/power/PowerSubsystem.java) |
| §4.1 PDH API read + §4.2 logging | [`PowerMonitorSubsystem.java`](src/main/java/frc/robot/subsystems/PowerMonitorSubsystem.java) |
| §4.4 Shuffleboard widget | [`PowerDashboard.java`](src/main/java/frc/robot/power/PowerDashboard.java) |
| §3.3 Brownout logging | `PowerMonitorSubsystem` — latched `isBrownedOut()` event counter |
| §3.3 / §6 Automatic load-shedding | [`LoadShedder.java`](src/main/java/frc/robot/power/LoadShedder.java) + [`CurrentLimited`](src/main/java/frc/robot/power/CurrentLimited.java) |
| Battery estimator (SOC / Thevenin sag / Kalman) | [`BatteryEstimator.java`](src/main/java/frc/robot/power/BatteryEstimator.java) |
| Main-breaker thermal model | [`BreakerThermalModel.java`](src/main/java/frc/robot/power/BreakerThermalModel.java) |
| "Finance department" dynamic current allocation | [`FinanceDepartment.java`](src/main/java/frc/robot/power/FinanceDepartment.java) |

## How the pieces fit

- **`PowerMonitorSubsystem`** is the heart. Its `periodic()` runs every 20 ms and does five
  things: read the PDH, log to DataLog, publish to NetworkTables/Shuffleboard, run threshold
  alerts, and drive the load-shedder. Just constructing it (see `RobotContainer`) makes
  everything run — the command scheduler calls `periodic()` for you.
- **`PowerSubsystem`** is an enum that groups PDH channels into logical subsystems and assigns
  each a **shed priority**. Drivetrain is priority 0 (shed last, or never); turret/indexer are
  the highest numbers (shed first).
- **`LoadShedder`** watches total bus current. If it stays over the 90 A budget for ~100 ms it
  reduces the current limit of the least-critical registered subsystem, then the next, and so
  on — never the drivetrain. It restores limits once draw drops back under the caution line
  (hysteresis prevents oscillation).
- **`CurrentLimited`** is the contract a mechanism implements to opt into shedding. See
  [`ExampleShooterSubsystem.java`](src/main/java/frc/robot/subsystems/ExampleShooterSubsystem.java)
  for the template, including the exact Phoenix 6 / REVLib current-limit calls to drop in.

## Battery estimator & finance department (6328-style)

`PowerMonitorSubsystem` also runs a battery observer and a dynamic current allocator, updated
every loop from the PDH:

- **`BatteryEstimator`** — coulomb counting with a dynamic Peukert correction estimates SOC; a
  single-RC Thevenin model predicts transient voltage sag; the measured terminal voltage is fused
  back with a small Kalman-style gain on the voltage innovation.
- **`BreakerThermalModel`** — a first-order thermal state (steady state `(I/I_rated)^2`) that
  accumulates during high-current draws and decays during cooldowns (Miner's-rule style).
- **`FinanceDepartment`** — forward-projects both models over a time budget and binary-searches
  the largest total current that keeps projected voltage above brownout and the breaker below
  trip, then allocates the leftover headroom to the drivetrain.

Your drivetrain subsystem reads `powerMonitor.driveCurrentAllocation()` each loop and pushes it
to its motor controllers' stator-current limit, so it uses the full safe headroom of the battery
instead of a fixed conservative cap. `setFinanceEnabled(false)` falls back to the static limit.
Estimator/finance outputs are published under `PowerMonitor/estimator/*` and `.../finance/*` and
logged to `/power/estimator/*`.

## Wiring in your own mechanisms

1. Set the real CAN IDs / channels in `Constants.java` to match your robot's labels.
2. Have each sheddable mechanism `implements CurrentLimited` (copy `ExampleShooterSubsystem`)
   and fill in `applyReducedLimit()` / `restoreNormalLimit()` with your motor-controller calls.
3. Register it in `RobotContainer`:
   ```java
   powerMonitor.registerForLoadShedding(intake);
   ```
   Do **not** register the drivetrain — leaving it unregistered guarantees it is never shed.

## Dashboard

Two live surfaces, both fed from the same PDH read:

- **NetworkTables** under the `PowerMonitor/` table (works with Elastic/Glass): `BusVoltage`,
  `TotalCurrent`, `TotalEnergyJ`, per-subsystem `current/<name>`, `Status`
  (GREEN/YELLOW/RED), `LoadShedding`, `BrownoutCount`, `MinBusVoltage`.
- A **Shuffleboard "Power" tab** (§4.4): bus-voltage graph, total-current dial against the
  120 A / 90 A budget, per-subsystem number bars scaled to each breaker rating, and status /
  brownout / min-voltage / energy readouts.

## Post-match review

Everything is written to the on-robot DataLog under `/power/...` every loop. Pull the `.wpilog`
off the RoboRIO (default `/home/lvuser/logs` or a USB stick) and open it in
**WPILib Data Log Tool / AdvantageScope** to replay currents and voltage and find any channel
that approached its breaker or any dip below 7 V. `getTotalEnergy()` (logged as
`/power/totalEnergyJ`) gives per-match energy for the scouting metric in §6.

## Build & deploy

```bash
./gradlew build          # compile + unit tests
./gradlew deploy         # deploy to the RoboRIO (team 6560)
./gradlew simulateJava   # desktop simulation with the sim GUI
```

Requires the WPILib 2026 toolchain installed (the `settings.gradle` resolves GradleRIO from
`~/wpilib/2026`). Team number and project year are set in `.wpilib/wpilib_preferences.json`.

## Tuning notes (from §5)

The numbers in `Constants.java` are starting points from motor datasheets. After each event,
replay the DataLog and adjust `CurrentLimits` and the budget thresholds based on **logged**
draw, not datasheet stall values. The load-shed timing (`SUSTAINED_LOOPS_TO_SHED`) and
hysteresis band live in `LoadShedder.java`.
