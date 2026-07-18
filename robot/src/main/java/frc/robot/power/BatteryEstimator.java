package frc.robot.power;

/**
 * Battery state estimator (inspired by Team 6328 "Mechanical Advantage" energy tracking).
 *
 * <p>Estimates State of Charge (SOC) by coulomb counting with a dynamic Peukert correction, and
 * models transient voltage sag with a single-RC Thevenin equivalent circuit:
 *
 * <pre>
 *   V_terminal = OCV(SOC) - I*R0 - V_rc      (V_rc is the polarization branch)
 *   dV_rc/dt   = I/C1 - V_rc/(R1*C1)
 * </pre>
 *
 * <p>The measured terminal voltage is compared to the model's prediction and the SOC estimate is
 * nudged toward what the measurement implies, using a small noise-attenuated (Kalman-style)
 * scalar gain on the voltage innovation. OCV and internal resistance are empirical functions of
 * SOC.
 *
 * <p>All resistances in ohms, capacity in amp-hours, time in seconds, current in amps (positive =
 * discharge).
 */
public class BatteryEstimator {

  // ---- Battery parameters (typical 18 Ah FRC SLA pack) ----
  private final double nominalCapacityAh;
  private final double r0Base = 0.012; // ohmic series resistance at full charge, fresh pack
  private final double r1 = 0.010; // polarization resistance
  private final double c1 = 500.0; // polarization capacitance -> tau1 = R1*C1 = 5 s
  private final double peukertK = 1.08; // >1: high current depletes charge faster
  private final double iRef = 20.0; // reference current for the Peukert correction

  /** Kalman-style innovation gain (per volt of error, applied to SOC). Small = trust the model. */
  private final double socGain = 0.02;

  private double ageFactor; // 0 = fresh, 1 = old (scales internal resistance up)

  // ---- Estimator state ----
  private double soc; // 0..1
  private double vRc; // polarization branch voltage
  private double predictedVoltage;
  private double lastCurrent;

  public BatteryEstimator(double nominalCapacityAh, double initialSoc, double ageFactor) {
    this.nominalCapacityAh = nominalCapacityAh;
    this.soc = clamp01(initialSoc);
    this.ageFactor = ageFactor;
    this.predictedVoltage = openCircuitVoltage(soc);
  }

  public void setAgeFactor(double ageFactor) {
    this.ageFactor = ageFactor;
  }

  /**
   * Empirical open-circuit voltage as a function of SOC. Shaped like a lead-acid discharge curve:
   * a shelf in the mid range, steeper near the ends. ~12.9 V full, ~11.6 V empty.
   */
  public double openCircuitVoltage(double s) {
    s = clamp01(s);
    // Smooth curve: base + linear + gentle S from the tanh term.
    return 11.6 + 1.0 * s + 0.30 * Math.tanh(6.0 * (s - 0.5)) + 0.15;
  }

  /** Series (ohmic) resistance rises as the pack empties and with age. */
  public double seriesResistance() {
    double socPenalty = 1.0 + 0.6 * (1.0 - soc); // up to +60% when empty
    double agePenalty = 1.0 + 1.2 * ageFactor; // up to +120% for an old pack
    return r0Base * socPenalty * agePenalty;
  }

  /**
   * Advance the estimator one step.
   *
   * @param measuredVoltage terminal voltage read from the PDH (V)
   * @param current total bus current (A, positive = discharge)
   * @param dt timestep (s)
   */
  public void update(double measuredVoltage, double current, double dt) {
    this.lastCurrent = current;

    // 1) Coulomb counting with dynamic Peukert correction.
    double iEff = current * Math.pow(Math.max(current, 0.1) / iRef, peukertK - 1.0);
    soc -= (iEff * dt) / (3600.0 * nominalCapacityAh);
    soc = clamp01(soc);

    // 2) Propagate the RC polarization branch (exact discrete solution).
    double tau1 = r1 * c1;
    double decay = Math.exp(-dt / tau1);
    vRc = vRc * decay + current * r1 * (1.0 - decay);

    // 3) Model-predicted terminal voltage.
    predictedVoltage = openCircuitVoltage(soc) - current * seriesResistance() - vRc;

    // 4) Kalman-style SOC correction from the voltage innovation, scaled by dOCV/dSOC so the
    //    volt error maps to a SOC error. Gain kept small to attenuate sensor noise.
    double innovation = measuredVoltage - predictedVoltage;
    double dOcvDsoc = ocvSlope(soc);
    if (dOcvDsoc > 1e-3) {
      soc = clamp01(soc + socGain * innovation / dOcvDsoc);
    }
  }

  /** Numerical dOCV/dSOC. */
  private double ocvSlope(double s) {
    double h = 0.01;
    return (openCircuitVoltage(s + h) - openCircuitVoltage(s - h)) / (2 * h);
  }

  /**
   * Forward-project the minimum terminal voltage if the bus were held at {@code totalCurrent} for
   * {@code horizonSec}. Used by the current-budget projector to find the largest draw that keeps
   * voltage above brownout. Does not mutate estimator state.
   */
  public double projectMinVoltage(double totalCurrent, double horizonSec, double dt) {
    double s = soc;
    double v = vRc;
    double tau1 = r1 * c1;
    double decay = Math.exp(-dt / tau1);
    double minV = Double.MAX_VALUE;
    for (double t = 0; t < horizonSec; t += dt) {
      double iEff = totalCurrent * Math.pow(Math.max(totalCurrent, 0.1) / iRef, peukertK - 1.0);
      s = clamp01(s - (iEff * dt) / (3600.0 * nominalCapacityAh));
      v = v * decay + totalCurrent * r1 * (1.0 - decay);
      double r0 = r0Base * (1.0 + 0.6 * (1.0 - s)) * (1.0 + 1.2 * ageFactor);
      double vTerm = openCircuitVoltage(s) - totalCurrent * r0 - v;
      if (vTerm < minV) minV = vTerm;
    }
    return minV;
  }

  public double soc() {
    return soc;
  }

  public double predictedVoltage() {
    return predictedVoltage;
  }

  public double lastCurrent() {
    return lastCurrent;
  }

  private static double clamp01(double x) {
    return Math.max(0.0, Math.min(1.0, x));
  }
}
