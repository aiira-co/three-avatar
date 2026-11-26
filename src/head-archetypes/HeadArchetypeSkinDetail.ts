import type { AvatarHeadArchetypeState } from '../format/types.js';
import { DEFAULT_SKIN_DETAIL_STRENGTH } from './HeadArchetypeController.js';

export interface HeadArchetypeSkinDetailProfile {
  /** Micro-pore tile density multiplier relative to head UV space. */
  poreScale: number;
  /** Tangent-space micro-normal pore perturbation amplitude (0..1). */
  poreStrength: number;
  /** Roughness offset applied selectively to face skin (-0.25..0.25). */
  roughnessBias: number;
  /** Subtle brow / T-zone specular highlight lift (0..1). */
  browHighlight: number;
  /** Subtle cheek warmth / subsurface flush (0..1). */
  cheekFlush: number;
  /** Lip tone saturation / warmth (0..1). */
  lipTint: number;
  /** Nose-bridge & tip specular accent (0..1). */
  noseSpecular: number;
  /** Subtle freckle / natural skin variation amplitude (0..1). */
  freckleDensity: number;
}

export interface BlendedHeadSkinDetail extends HeadArchetypeSkinDetailProfile {
  /** Normalized effective strength multiplier in `0..1`. */
  detailStrength: number;
  /** Total active head-archetype weight (0 when wearing baseline head). */
  activeArchetypeWeight: number;
}

export const DEFAULT_HEAD_SKIN_DETAIL_PROFILE: Readonly<HeadArchetypeSkinDetailProfile> = {
  poreScale: 1.0,
  poreStrength: 0.48,
  roughnessBias: 0.0,
  browHighlight: 0.14,
  cheekFlush: 0.14,
  lipTint: 0.22,
  noseSpecular: 0.18,
  freckleDensity: 0.08,
};

export const HEAD_ARCHETYPE_SKIN_DETAIL_PROFILES: Readonly<Record<string, HeadArchetypeSkinDetailProfile>> = {
  default: DEFAULT_HEAD_SKIN_DETAIL_PROFILE,
  black: {
    poreScale: 1.08,
    poreStrength: 0.62,
    roughnessBias: -0.05,
    browHighlight: 0.28,
    cheekFlush: 0.16,
    lipTint: 0.28,
    noseSpecular: 0.34,
    freckleDensity: 0.05,
  },
  east_asian: {
    poreScale: 0.92,
    poreStrength: 0.36,
    roughnessBias: -0.04,
    browHighlight: 0.18,
    cheekFlush: 0.22,
    lipTint: 0.26,
    noseSpecular: 0.24,
    freckleDensity: 0.04,
  },
  chinese: {
    poreScale: 0.9,
    poreStrength: 0.34,
    roughnessBias: -0.05,
    browHighlight: 0.2,
    cheekFlush: 0.24,
    lipTint: 0.28,
    noseSpecular: 0.25,
    freckleDensity: 0.03,
  },
  manga: {
    poreScale: 0.85,
    poreStrength: 0.14,
    roughnessBias: 0.04,
    browHighlight: 0.1,
    cheekFlush: 0.36,
    lipTint: 0.18,
    noseSpecular: 0.12,
    freckleDensity: 0.0,
  },
  south_asian: {
    poreScale: 1.05,
    poreStrength: 0.56,
    roughnessBias: -0.02,
    browHighlight: 0.24,
    cheekFlush: 0.18,
    lipTint: 0.3,
    noseSpecular: 0.28,
    freckleDensity: 0.09,
  },
  angular: {
    poreScale: 1.12,
    poreStrength: 0.66,
    roughnessBias: 0.02,
    browHighlight: 0.26,
    cheekFlush: 0.1,
    lipTint: 0.18,
    noseSpecular: 0.3,
    freckleDensity: 0.14,
  },
};

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * Blends per-archetype skin-detail parameters across global and regional
 * head-archetype weights, scaled by `state.detailStrength`.
 */
export function blendHeadArchetypeSkinDetail(state?: AvatarHeadArchetypeState | null): BlendedHeadSkinDetail {
  const rawDetail = state?.detailStrength;
  const detailStrength =
    typeof rawDetail === 'number' && Number.isFinite(rawDetail)
      ? clamp01(rawDetail)
      : DEFAULT_SKIN_DETAIL_STRENGTH;

  const combined = new Map<string, number>();
  for (const [id, rawW] of Object.entries(state?.weights ?? {})) {
    if (!Number.isFinite(rawW) || rawW <= 0) continue;
    combined.set(id, (combined.get(id) ?? 0) + clamp01(rawW));
  }
  const regionEntries = Object.values(state?.regions ?? {});
  const regionScale = regionEntries.length > 0 ? 0.35 / regionEntries.length : 0;
  for (const regWeights of regionEntries) {
    if (!regWeights) continue;
    for (const [id, rawW] of Object.entries(regWeights)) {
      if (!Number.isFinite(rawW) || rawW <= 0) continue;
      combined.set(id, (combined.get(id) ?? 0) + clamp01(rawW) * regionScale);
    }
  }

  let totalWeight = 0;
  for (const w of combined.values()) totalWeight += w;

  if (totalWeight <= 1e-4) {
    return {
      poreScale: DEFAULT_HEAD_SKIN_DETAIL_PROFILE.poreScale,
      poreStrength: DEFAULT_HEAD_SKIN_DETAIL_PROFILE.poreStrength * detailStrength,
      roughnessBias: DEFAULT_HEAD_SKIN_DETAIL_PROFILE.roughnessBias * detailStrength,
      browHighlight: DEFAULT_HEAD_SKIN_DETAIL_PROFILE.browHighlight * detailStrength,
      cheekFlush: DEFAULT_HEAD_SKIN_DETAIL_PROFILE.cheekFlush * detailStrength,
      lipTint: DEFAULT_HEAD_SKIN_DETAIL_PROFILE.lipTint * detailStrength,
      noseSpecular: DEFAULT_HEAD_SKIN_DETAIL_PROFILE.noseSpecular * detailStrength,
      freckleDensity: DEFAULT_HEAD_SKIN_DETAIL_PROFILE.freckleDensity * detailStrength,
      detailStrength,
      activeArchetypeWeight: 0,
    };
  }

  // Blend toward default when total weight < 1; normalize when sum > 1.
  const norm = totalWeight > 1 ? 1 / totalWeight : 1;
  const baseWeight = Math.max(0, 1 - totalWeight * norm);

  let poreScale = DEFAULT_HEAD_SKIN_DETAIL_PROFILE.poreScale * baseWeight;
  let poreStrength = DEFAULT_HEAD_SKIN_DETAIL_PROFILE.poreStrength * baseWeight;
  let roughnessBias = DEFAULT_HEAD_SKIN_DETAIL_PROFILE.roughnessBias * baseWeight;
  let browHighlight = DEFAULT_HEAD_SKIN_DETAIL_PROFILE.browHighlight * baseWeight;
  let cheekFlush = DEFAULT_HEAD_SKIN_DETAIL_PROFILE.cheekFlush * baseWeight;
  let lipTint = DEFAULT_HEAD_SKIN_DETAIL_PROFILE.lipTint * baseWeight;
  let noseSpecular = DEFAULT_HEAD_SKIN_DETAIL_PROFILE.noseSpecular * baseWeight;
  let freckleDensity = DEFAULT_HEAD_SKIN_DETAIL_PROFILE.freckleDensity * baseWeight;

  for (const [id, rawW] of combined.entries()) {
    const w = rawW * norm;
    const p = HEAD_ARCHETYPE_SKIN_DETAIL_PROFILES[id] ?? DEFAULT_HEAD_SKIN_DETAIL_PROFILE;
    poreScale += p.poreScale * w;
    poreStrength += p.poreStrength * w;
    roughnessBias += p.roughnessBias * w;
    browHighlight += p.browHighlight * w;
    cheekFlush += p.cheekFlush * w;
    lipTint += p.lipTint * w;
    noseSpecular += p.noseSpecular * w;
    freckleDensity += p.freckleDensity * w;
  }

  return {
    poreScale,
    poreStrength: clamp01(poreStrength * detailStrength),
    roughnessBias: roughnessBias * detailStrength,
    browHighlight: clamp01(browHighlight * detailStrength),
    cheekFlush: clamp01(cheekFlush * detailStrength),
    lipTint: clamp01(lipTint * detailStrength),
    noseSpecular: clamp01(noseSpecular * detailStrength),
    freckleDensity: clamp01(freckleDensity * detailStrength),
    detailStrength,
    activeArchetypeWeight: Math.min(1, totalWeight),
  };
}
