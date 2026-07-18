package frc.robot.power;

/**
 * Thermal model of the 120 A main breaker (inspired by Team 6328's approach).
 *
 * <p>A thermal-magnetic breaker trips on accumulated heat, not instantaneous current. We track a
 * normalized thermal state {@code theta} (0 = cold, 1 = trip) with a first-order model whose
 * steady state is {@code (I/I_rated)^2}:
 *
 * <pre>
 *   dTheta/dt = ((I/I_rated)^2 - theta) / tau
 * </pre>
 *
 * <p>This is the physical realization of the "Miner's rule" damage accumulation described in the
 * binder: heat accumulates during high-current draws (theta rises toward (I/I_rated)^2 &gt; 1) and
 * exponentially decays during cooldowns (theta relaxes toward (I/I_rated)^2 &lt; 1). The breaker
 * tolerates brief overcurrent because theta lags the current.
 */
public class BreakerThermalModel {

  private final double ratedAmps;
  private final double tauSeconds; // thermal time constant

  private double theta; // 0..1, trip at 1

  public BreakerThermalModel(double ratedAmps, double tauSeconds) {
    this.ratedAmps = ratedAmps;
    this.tauSeconds = tauSeconds;
    this.theta = 0.0;
  }

  /** Advance the thermal state one step at the given total current. */
  public void update(double totalCurrent, double dt) {
    double drive = Math.pow(totalCurrent / ratedAmps, 2.0);
    theta += (drive - theta) * (dt / tauSeconds);
    theta = Math.max(0.0, theta);
  }

  /** Normalized thermal state 0..1 (fraction of the way to a trip). */
  public double thermalState() {
    return theta;
  }

  public boolean isTripped() {
    return theta >= 1.0;
  }

  /**
   * Forward-project the peak thermal state if the bus were held at {@code totalCurrent} for
   * {@code horizonSec}. Does not mutate state.
   */
  public double projectMaxTheta(double totalCurrent, double horizonSec, double dt) {
    double drive = Math.pow(totalCurrent / ratedAmps, 2.0);
    double th = theta;
    for (double t = 0; t < horizonSec; t += dt) {
      th += (drive - th) * (dt / tauSeconds);
    }
    return th;
  }

  public double ratedAmps() {
    return ratedAmps;
  }
}
