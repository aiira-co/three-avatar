import { Camera, Vector3 } from 'three';

export interface FollowCameraConfig {
  distance: number;
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
  heightOffset: number;
  damping: number;
}

export const DEFAULT_FOLLOW_CAMERA_CONFIG: FollowCameraConfig = {
  distance: 3.1,
  minDistance: 1.4,
  maxDistance: 6.5,
  minPitch: -0.35,
  maxPitch: 1.05,
  heightOffset: 1.25,
  damping: 12,
};

/**
 * Spring-damped spherical third-person follow camera for Engine Avatar Studio playtest mode.
 */
export class ThirdPersonFollowCamera {
  readonly config: FollowCameraConfig;
  yaw = 0;
  pitch = 0.28;
  distance: number;

  private readonly smoothedTarget = new Vector3();
  private readonly desiredPos = new Vector3();
  private initialized = false;

  constructor(config: Partial<FollowCameraConfig> = {}) {
    this.config = { ...DEFAULT_FOLLOW_CAMERA_CONFIG, ...config };
    this.distance = this.config.distance;
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    if (Number.isFinite(deltaYaw)) this.yaw += deltaYaw;
    if (Number.isFinite(deltaPitch)) {
      this.pitch = Math.max(this.config.minPitch, Math.min(this.config.maxPitch, this.pitch + deltaPitch));
    }
  }

  zoom(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.distance = Math.max(this.config.minDistance, Math.min(this.config.maxDistance, this.distance + delta));
  }

  reset(yaw = 0): void {
    this.yaw = yaw;
    this.pitch = 0.28;
    this.distance = this.config.distance;
    this.initialized = false;
  }

  update(targetPosition: Vector3, dt: number, camera: Camera): void {
    const targetY = targetPosition.y + this.config.heightOffset;
    if (!this.initialized) {
      this.smoothedTarget.set(targetPosition.x, targetY, targetPosition.z);
      this.initialized = true;
    } else {
      const alpha = 1 - Math.exp(-this.config.damping * Math.max(0, dt));
      this.smoothedTarget.x += (targetPosition.x - this.smoothedTarget.x) * alpha;
      this.smoothedTarget.y += (targetY - this.smoothedTarget.y) * alpha;
      this.smoothedTarget.z += (targetPosition.z - this.smoothedTarget.z) * alpha;
    }

    const cosPitch = Math.cos(this.pitch);
    const offsetX = -Math.sin(this.yaw) * cosPitch * this.distance;
    const offsetY = Math.sin(this.pitch) * this.distance;
    const offsetZ = -Math.cos(this.yaw) * cosPitch * this.distance;

    this.desiredPos.set(
      this.smoothedTarget.x + offsetX,
      Math.max(0.15, this.smoothedTarget.y + offsetY),
      this.smoothedTarget.z + offsetZ,
    );
    camera.position.copy(this.desiredPos);
    camera.lookAt(this.smoothedTarget);
  }
}
