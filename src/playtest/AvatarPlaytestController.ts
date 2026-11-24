import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  Object3D,
  Vector3,
} from 'three';
import type { PoseOffsetController } from '../pose/PoseOffsetController.js';

export interface PlaytestInputState {
  forward: number;
  right: number;
  walk?: boolean;
  sprint?: boolean;
  crouch?: boolean;
  jump?: boolean;
  cameraYaw?: number;
}

export type PlaytestLocomotionState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sprint'
  | 'crouch_idle'
  | 'crouch_walk'
  | 'jump'
  | 'fall'
  | 'land'
  | 'emote';

export interface PlaytestConfig {
  walkSpeed: number;
  runSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  acceleration: number;
  turnSpeed: number;
  jumpVelocity: number;
  gravity: number;
  groundY: number;
  crossfadeDuration: number;
  landDuration: number;
  walkThreshold: number;
}

export const DEFAULT_PLAYTEST_CONFIG: PlaytestConfig = {
  walkSpeed: 1.6,
  runSpeed: 3.6,
  sprintSpeed: 5.6,
  crouchSpeed: 1.0,
  acceleration: 14,
  turnSpeed: 12,
  jumpVelocity: 5.4,
  gravity: -16,
  groundY: 0,
  crossfadeDuration: 0.16,
  landDuration: 0.15,
  walkThreshold: 0.55,
};

export interface AvatarPlaytestControllerOptions {
  root: Object3D;
  mixer: AnimationMixer;
  clips: ReadonlyMap<string, AnimationClip> | readonly AnimationClip[];
  poseOffsets?: PoseOffsetController;
  config?: Partial<PlaytestConfig>;
}

const CLIP_FALLBACKS: Readonly<Record<PlaytestLocomotionState, readonly string[]>> = {
  idle: ['idle'],
  walk: ['walk', 'run', 'idle'],
  run: ['run', 'sprint', 'walk', 'idle'],
  sprint: ['sprint', 'run', 'walk', 'idle'],
  crouch_idle: ['crouch_idle', 'idle'],
  crouch_walk: ['crouch_walk', 'crouch_idle', 'walk', 'idle'],
  jump: ['jump', 'fall', 'idle'],
  fall: ['fall', 'jump', 'idle'],
  land: ['land', 'idle'],
  emote: ['idle'],
};

function shortestAngleDiff(from: number, to: number): number {
  let diff = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/**
 * Lightweight Engine-only kinematic third-person playtest loop (pure Three.js, zero physics WASM).
 * Steps locomotion states (`idle`, `walk`, `run`, `sprint`, `crouch`, `jump`, `fall`, `land`,
 * `emote`), drives the `AnimationMixer`, and applies `PoseOffsetController` with save/restore.
 */
export class AvatarPlaytestController {
  readonly root: Object3D;
  readonly mixer: AnimationMixer;
  readonly config: PlaytestConfig;
  readonly position = new Vector3();
  readonly velocity = new Vector3();

  private readonly clips = new Map<string, AnimationClip>();
  private readonly poseOffsets?: PoseOffsetController;

  private input: PlaytestInputState = { forward: 0, right: 0 };
  private state: PlaytestLocomotionState = 'idle';
  private yaw = 0;
  private grounded = true;
  private landTimer = 0;
  private jumpLatch = false;
  private emoteName: string | undefined;
  private emoteRemaining = 0;
  private activeAction: AnimationAction | undefined;
  private activeClipName: string | undefined;

  constructor(options: AvatarPlaytestControllerOptions) {
    this.root = options.root;
    this.mixer = options.mixer;
    this.poseOffsets = options.poseOffsets;
    this.config = { ...DEFAULT_PLAYTEST_CONFIG, ...options.config };
    this.position.copy(this.root.position);
    this.position.y = Math.max(this.config.groundY, this.position.y);
    this.yaw = this.root.rotation.y;

    if (options.clips instanceof Map) {
      for (const [name, clip] of options.clips) this.clips.set(name, clip);
    } else {
      for (const clip of options.clips as readonly AnimationClip[]) this.clips.set(clip.name, clip);
    }
  }

  get currentState(): PlaytestLocomotionState {
    return this.state;
  }

  get currentClipName(): string | undefined {
    return this.activeClipName;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  get facingYaw(): number {
    return this.yaw;
  }

  setInput(partial: Partial<PlaytestInputState>): void {
    this.input = {
      ...this.input,
      ...partial,
      forward: Number.isFinite(partial.forward) ? Math.max(-1, Math.min(1, partial.forward!)) : this.input.forward,
      right: Number.isFinite(partial.right) ? Math.max(-1, Math.min(1, partial.right!)) : this.input.right,
    };
  }

  triggerEmote(clipName: string): boolean {
    const clip = this.clips.get(clipName);
    if (!clip) return false;
    this.emoteName = clipName;
    this.emoteRemaining = Math.max(0.1, clip.duration);
    this.state = 'emote';
    this.switchClip(clipName, false);
    return true;
  }

  update(dt: number): PlaytestLocomotionState {
    const clampedDt = Math.max(0, Math.min(dt, 0.05));
    this.poseOffsets?.restore();

    const forward = this.input.forward;
    const right = this.input.right;
    const rawMag = Math.hypot(forward, right);
    const mag = Math.min(1, rawMag);
    const hasMove = mag > 0.05;
    const wantsJump = Boolean(this.input.jump) && !this.jumpLatch;
    this.jumpLatch = Boolean(this.input.jump);

    if (this.state === 'emote') {
      if (hasMove || wantsJump) {
        this.emoteName = undefined;
        this.emoteRemaining = 0;
        this.state = 'idle';
      } else {
        this.emoteRemaining -= clampedDt;
        if (this.emoteRemaining <= 0) {
          this.emoteName = undefined;
          this.state = 'idle';
        }
      }
    }

    // Camera-relative horizontal direction where yaw=0 faces +Z and right is -X.
    const camYaw = this.input.cameraYaw ?? 0;
    const sinCam = Math.sin(camYaw);
    const cosCam = Math.cos(camYaw);
    let moveX = 0;
    let moveZ = 0;
    if (hasMove) {
      const nf = forward / rawMag;
      const nr = right / rawMag;
      moveX = nf * sinCam - nr * cosCam;
      moveZ = nf * cosCam + nr * sinCam;
    }

    let targetSpeed = 0;
    let groundLocomotion: PlaytestLocomotionState = this.input.crouch ? 'crouch_idle' : 'idle';
    if (hasMove) {
      if (this.input.crouch) {
        targetSpeed = this.config.crouchSpeed * mag;
        groundLocomotion = 'crouch_walk';
      } else if (this.input.sprint) {
        targetSpeed = this.config.sprintSpeed * mag;
        groundLocomotion = 'sprint';
      } else if (this.input.walk || mag <= this.config.walkThreshold) {
        const ratio = this.input.walk ? mag : Math.min(1, mag / Math.max(this.config.walkThreshold, 1e-4));
        targetSpeed = this.config.walkSpeed * ratio;
        groundLocomotion = 'walk';
      } else {
        targetSpeed = this.config.runSpeed * mag;
        groundLocomotion = 'run';
      }
    }

    const desiredVx = moveX * targetSpeed;
    const desiredVz = moveZ * targetSpeed;
    const accelAlpha = 1 - Math.exp(-this.config.acceleration * clampedDt);
    this.velocity.x += (desiredVx - this.velocity.x) * accelAlpha;
    this.velocity.z += (desiredVz - this.velocity.z) * accelAlpha;
    if (!hasMove && Math.hypot(this.velocity.x, this.velocity.z) < 0.01) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    this.position.x += this.velocity.x * clampedDt;
    this.position.z += this.velocity.z * clampedDt;

    if (hasMove) {
      const targetYaw = Math.atan2(moveX, moveZ);
      const diff = shortestAngleDiff(this.yaw, targetYaw);
      const turnAlpha = 1 - Math.exp(-this.config.turnSpeed * clampedDt);
      this.yaw += diff * turnAlpha;
    }

    if (this.grounded && wantsJump) {
      this.grounded = false;
      this.landTimer = 0;
      this.velocity.y = this.config.jumpVelocity;
      this.state = 'jump';
    }

    if (!this.grounded) {
      this.velocity.y += this.config.gravity * clampedDt;
      this.position.y += this.velocity.y * clampedDt;
      if (this.position.y <= this.config.groundY) {
        this.position.y = this.config.groundY;
        this.velocity.y = 0;
        this.grounded = true;
        this.landTimer = this.config.landDuration;
        this.state = hasMove ? groundLocomotion : 'land';
      } else {
        this.state = this.velocity.y > 0 ? 'jump' : 'fall';
      }
    } else if (this.state !== 'emote') {
      if (this.landTimer > 0 && !hasMove) {
        this.landTimer -= clampedDt;
        this.state = this.landTimer > 0 ? 'land' : groundLocomotion;
      } else {
        this.landTimer = 0;
        this.state = groundLocomotion;
      }
    }

    this.root.position.copy(this.position);
    this.root.rotation.y = this.yaw;

    if (this.state === 'emote' && this.emoteName) {
      this.switchClip(this.emoteName, false);
    } else {
      const resolved = this.resolveClipName(this.state);
      if (resolved) this.switchClip(resolved, true);
    }

    this.mixer.update(clampedDt);
    this.poseOffsets?.apply(this.activeClipName);
    return this.state;
  }

  reset(): void {
    this.poseOffsets?.restore();
    this.mixer.stopAllAction();
    this.activeAction = undefined;
    this.activeClipName = undefined;
    this.position.set(0, this.config.groundY, 0);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.grounded = true;
    this.landTimer = 0;
    this.jumpLatch = false;
    this.emoteName = undefined;
    this.emoteRemaining = 0;
    this.input = { forward: 0, right: 0 };
    this.state = 'idle';
    this.root.position.copy(this.position);
    this.root.rotation.y = 0;
    const idle = this.resolveClipName('idle');
    if (idle) this.switchClip(idle, true);
    this.mixer.update(0);
    this.poseOffsets?.apply(this.activeClipName);
  }

  dispose(): void {
    this.poseOffsets?.restore();
    this.mixer.stopAllAction();
    this.activeAction = undefined;
    this.activeClipName = undefined;
  }

  private resolveClipName(state: PlaytestLocomotionState): string | undefined {
    for (const candidate of CLIP_FALLBACKS[state]) {
      if (this.clips.has(candidate)) return candidate;
    }
    return undefined;
  }

  private switchClip(clipName: string, loop: boolean): void {
    if (this.activeClipName === clipName && this.activeAction) return;
    const clip = this.clips.get(clipName);
    if (!clip) return;

    const next = this.mixer.clipAction(clip);
    next.reset();
    next.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    next.play();

    if (this.activeAction && this.activeAction !== next) {
      next.crossFadeFrom(this.activeAction, this.config.crossfadeDuration, false);
    }

    this.activeAction = next;
    this.activeClipName = clipName;
  }
}
