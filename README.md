# powersys-monitor

Power Draw & Electrical Systems Monitor for **FRC Team 6560**. Two deliverables live here:

| Part | Location | What it is |
| --- | --- | --- |
| **Web dashboard / demo** | repo root (`index.html`) | A no-build, vanilla-JS simulation of the robot's electrical system — live PDH draw, brownout guard, priority load-shedding, a 6328-style battery estimator + breaker thermal model, and a "finance department" that allocates drive current dynamically. |
| **Robot firmware** | [`robot/`](robot/) | The real, deployable WPILib 2026 Java (command-based) project that reads an actual REV PDH and runs the same monitoring/estimation logic on the RoboRIO. |

The two share the same design: constants, subsystem→channel map, budgets, load-shed priorities,
battery estimator, breaker thermal model, and finance allocator are mirrored between the JS demo
and the Java robot code.

## Run the web dashboard

No build step, no dependencies. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8099    # then open http://localhost:8099
```

Drag the subsystem sliders to demand current, hit **⚡ Worst-case test** to trigger a brownout,
toggle **automatic load-shedding** and the **finance department**, and raise **battery age** to
watch the dynamic current budget shrink. Full details in [`docs/WEB.md`](docs/WEB.md).

## Robot code

The deployable project is in [`robot/`](robot/). Open that folder in **WPILib VS Code 2026**, then
Build / Deploy / Simulate from the WPILib command palette. See [`robot/README.md`](robot/README.md)
for the channel map, current limits, load-shedder, and battery-estimator wiring.

```bash
cd robot
./gradlew build     # compile + tests
./gradlew deploy    # deploy to the RoboRIO (team 6560)
```

## Layout

```
.                     # web dashboard (index.html, css/, js/)
├─ index.html
├─ css/styles.css
├─ js/                # constants, load-shedder, battery estimator, breaker model, finance, sim, app
├─ docs/WEB.md        # web-demo details
└─ robot/             # WPILib 2026 Java robot project
   └─ src/main/java/frc/robot/...
```

> Values in the web dashboard are **simulated**, not read from a real PDH — it's a teaching/demo
> and UX-validation tool. The `robot/` project is the one that reads real hardware.
