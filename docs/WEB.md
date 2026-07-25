# FRC 6560 — Power & Electrical Systems Monitor (Web Demo)

A browser demo of the Team 6560 *Power Draw & Electrical Systems Monitor*. It simulates the
robot's electrical system and drives the same monitoring logic as the real robot code: live
per-subsystem current, bus-voltage sag, brownout detection, threshold alerts, and the
priority-based automatic load-shedder — all with no hardware.

Pure vanilla HTML/CSS/JS. No build step, no dependencies.

## Run it

Just open `index.html` in a browser. (If your browser blocks the graph/scripts on `file://`,
serve the folder instead:)

```bash
python3 -m http.server 8099
# then open http://localhost:8099
```

## Battery Estimator & Finance Department

Inspired by Team 6328 (Mechanical Advantage). The demo runs a real observer + allocator on top of
the simulated battery:

- **Battery estimator** (`js/batteryEstimator.js`): coulomb counting with a dynamic Peukert
  correction estimates SOC; a single-RC **Thevenin** model predicts transient voltage sag; the
  measured voltage is fused back in with a small **Kalman-style** gain. Watch *Predicted V* track
  *Measured V* even during hard sags.
- **Breaker thermal model** (`js/breakerModel.js`): a Miner's-rule-style thermal state that
  accumulates during high-current draws and decays during cooldowns — the main breaker tolerates
  brief overcurrent but trips on sustained load.
- **Finance department** (`js/finance.js`): every loop it forward-projects both models and
  binary-searches the largest total current that keeps projected voltage above brownout *and* the
  breaker below trip, then hands the leftover headroom to the drivetrain as a **dynamic** current
  limit. The green "finance budget" line on the graph is this live ceiling; toggle the finance
  checkbox off and the drive falls back to a fixed static limit (and the breaker climbs toward a
  trip). Raise **Battery age** and watch the permissible budget shrink automatically.

## What you can do

- **⚡ Worst-case test** (header) fires drivetrain + shooter + intake + climber at once
  (design doc §5) — the transient inrush sags the battery, usually trips a brownout, and drives
  the whole dashboard. This is the main way to generate load.
- Watch the **automatic load-shedder** engage during the burst: it drops the least-critical
  subsystems' current limits first (turret → indexer → intake → shooter → climber) and **never
  sheds the drivetrain**.
- **Load-shedding** toggle (header) — turn it off and re-run the test to see the difference
  (more brownouts, higher sustained draw).
- **Battery age** slider raises internal resistance, so the same draw sags harder — mirrors the
  §6 idea of correlating battery age with voltage sag.
- **Export match log (CSV)** downloads the recorded log (time, bus V, total A, per-subsystem A,
  SOC, breaker thermal, permissible/allocated current, brownout flag) — the demo stand-in for
  the on-robot DataLog (§4.2).

## Match timeline & subsystem breakdown

The **Match Timeline** panel records total current (gold) and bus voltage (blue) across the whole
match, with **red bands marking brownouts** so you can spot exactly where the bus sagged. **Hover
the graph** to scrub to any moment — a cursor appears and the **breakdown pie** to the right shows
each subsystem's current draw (amps + %) at that timestamp. Move off the graph to return to the
live value. Handy for post-match review: find a brownout spike, then read which subsystems were
pulling current at that instant.

## How it maps to the design doc

| Doc section | In this demo |
| --- | --- |
| §2.2 channels / breaker ratings | `js/constants.js` — `PM.SUBSYSTEMS` (channels + breaker per subsystem) |
| §3.1 total budget, §4.3 thresholds | `PM.Budget` + the color-coded total-current meter and alerts |
| §3.2 smart current limits | `smart` field per subsystem; shown as the ▸ tick on each bar |
| §3.3 brownout + priority strategy | `js/simulation.js` brownout latch; `js/loadShedder.js` priority shedding |
| §4.1 PDH read / §4.2 logging | `Simulation.step()` produces PDH-like values; CSV export = DataLog |
| §4.4 dashboard widget | the whole page: voltage graph, current dial, per-subsystem bars, status pill |
| §6 load-shedding + battery-age tracking | the auto-shed toggle and battery-age slider |

## Files

```
index.html          # layout
css/styles.css       # dark control-room theme
js/constants.js       # budget + subsystem table (mirrors Constants.java / PowerSubsystem)
js/loadShedder.js     # priority load-shedding (mirrors LoadShedder.java)
js/batteryEstimator.js# Thevenin + Peukert coulomb counting + Kalman SOC (mirrors BatteryEstimator.java)
js/breakerModel.js    # breaker thermal / Miner's-rule model (mirrors BreakerThermalModel.java)
js/finance.js         # forward-projection current allocator (mirrors FinanceDepartment.java)
js/simulation.js      # Thevenin "truth" plant + current model
js/app.js             # dashboard rendering, 50 Hz loop, alerts, graph, CSV export
```

## Note

Values are **simulated**, not read from a real PDH. This is a teaching/demo tool for the drive
team and for validating the monitoring UX before the robot is wired. The real, deployable
version is the WPILib Java project (`frc-6560-power-monitor`), which reads an actual REV PDH.
