import { Quaternion } from 'three';

export interface OneEuroOptions {
  /** Minimum cutoff frequency in Hz (lower = smoother at rest). Default `1.4`. */
  minCutoff?: number;
  /** Speed coefficient (higher = less lag during fast motion). Default `0.02`. */
  beta?: number;
  /** Derivative cutoff frequency in Hz. Default `1.0`. */
  dCutoff?: number;
}

function smoothingFactor(dt: number, cutoff: number): number {
  const r = 2 * Math.PI * Math.max(1e-4, cutoff) * dt;
  return r / (r + 1);
}

function exponentialSmoothing(alpha: number, x: number, prevX: number): number {
  return alpha * x + (1 - alpha) * prevX;
}

/**
 * Scalar 1-Euro low-pass filter (Casiez et al.) providing jitter-free rest stability
 * and low-latency tracking during rapid movement.
 */
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private readonly dCutoff: number;
  private initialized = false;
  private xPrev = 0;
  private dxPrev = 0;
  private lastTimestamp = 0;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? 1.4;
    this.beta = options.beta ?? 0.02;
    this.dCutoff = options.dCutoff ?? 1.0;
  }

  configure(options: Pick<OneEuroOptions, 'minCutoff' | 'beta'>): void {
    if (typeof options.minCutoff === 'number' && Number.isFinite(options.minCutoff)) {
      this.minCutoff = Math.max(0.05, options.minCutoff);
    }
    if (typeof options.beta === 'number' && Number.isFinite(options.beta)) {
      this.beta = Math.max(0, options.beta);
    }
  }

  reset(): void {
    this.initialized = false;
    this.xPrev = 0;
    this.dxPrev = 0;
    this.lastTimestamp = 0;
  }

  filter(value: number, timestampSeconds: number): number {
    if (!Number.isFinite(value)) return this.xPrev;
    if (!this.initialized) {
      this.initialized = true;
      this.xPrev = value;
      this.dxPrev = 0;
      this.lastTimestamp = timestampSeconds;
      return value;
    }

    const dt = Math.max(1e-4, Math.min(0.25, timestampSeconds - this.lastTimestamp));
    this.lastTimestamp = timestampSeconds;

    const aD = smoothingFactor(dt, this.dCutoff);
    const dx = (value - this.xPrev) / dt;
    const dxHat = exponentialSmoothing(aD, dx, this.dxPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = smoothingFactor(dt, cutoff);
    const xHat = exponentialSmoothing(a, value, this.xPrev);

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

/**
 * Shortest-arc SLERP quaternion 1-Euro filter for jitter-free bone orientations.
 */
export class QuaternionOneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private readonly dCutoff: number;
  private initialized = false;
  private readonly qPrev = new Quaternion();
  private speedPrev = 0;
  private lastTimestamp = 0;
  private readonly target = new Quaternion();

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? 1.6;
    this.beta = options.beta ?? 0.04;
    this.dCutoff = options.dCutoff ?? 1.0;
  }

  configure(options: Pick<OneEuroOptions, 'minCutoff' | 'beta'>): void {
    if (typeof options.minCutoff === 'number' && Number.isFinite(options.minCutoff)) {
      this.minCutoff = Math.max(0.05, options.minCutoff);
    }
    if (typeof options.beta === 'number' && Number.isFinite(options.beta)) {
      this.beta = Math.max(0, options.beta);
    }
  }

  reset(): void {
    this.initialized = false;
    this.qPrev.identity();
    this.speedPrev = 0;
    this.lastTimestamp = 0;
  }

  filter(input: Quaternion, timestampSeconds: number, out = new Quaternion()): Quaternion {
    this.target.copy(input).normalize();
    if (!this.initialized) {
      this.initialized = true;
      this.qPrev.copy(this.target);
      this.speedPrev = 0;
      this.lastTimestamp = timestampSeconds;
      return out.copy(this.qPrev);
    }

    // Double-cover hemisphere alignment so SLERP takes shortest arc.
    if (this.qPrev.dot(this.target) < 0) {
      this.target.set(-this.target.x, -this.target.y, -this.target.z, -this.target.w);
    }

    const dt = Math.max(1e-4, Math.min(0.25, timestampSeconds - this.lastTimestamp));
    this.lastTimestamp = timestampSeconds;

    const angle = this.qPrev.angleTo(this.target);
    const speed = angle / dt;
    const aD = smoothingFactor(dt, this.dCutoff);
    const speedHat = exponentialSmoothing(aD, speed, this.speedPrev);
    const cutoff = this.minCutoff + this.beta * speedHat;
    const alpha = smoothingFactor(dt, cutoff);

    this.qPrev.slerp(this.target, alpha).normalize();
    this.speedPrev = speedHat;
    return out.copy(this.qPrev);
  }
}

/**
 * Per-channel 1-Euro filter bank for expression morphs (`0..1`) and scalar tracks.
 */
export class ChannelMapOneEuroFilter {
  private readonly filters = new Map<string, OneEuroFilter>();
  private minCutoff: number;
  private beta: number;
  private readonly dCutoff: number;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? 2.2;
    this.beta = options.beta ?? 0.05;
    this.dCutoff = options.dCutoff ?? 1.2;
  }

  configure(options: Pick<OneEuroOptions, 'minCutoff' | 'beta'>): void {
    if (typeof options.minCutoff === 'number' && Number.isFinite(options.minCutoff)) {
      this.minCutoff = Math.max(0.05, options.minCutoff);
    }
    if (typeof options.beta === 'number' && Number.isFinite(options.beta)) {
      this.beta = Math.max(0, options.beta);
    }
    for (const f of this.filters.values()) {
      f.configure({ minCutoff: this.minCutoff, beta: this.beta });
    }
  }

  reset(): void {
    this.filters.clear();
  }

  filterMap(channels: Readonly<Record<string, number>>, timestampSeconds: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, val] of Object.entries(channels)) {
      let filter = this.filters.get(key);
      if (!filter) {
        filter = new OneEuroFilter({
          minCutoff: this.minCutoff,
          beta: this.beta,
          dCutoff: this.dCutoff,
        });
        this.filters.set(key, filter);
      }
      out[key] = filter.filter(val, timestampSeconds);
    }
    return out;
  }
}
