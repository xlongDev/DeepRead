/** Type surface for the vendored refract.js (plain JS, kept verbatim upstream). */
export interface GlassSurface {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly radius: number
  readonly rim: number
  readonly edge: number
  readonly power: number
  readonly blur: number
  readonly saturate: number
  readonly contrast: number
  readonly brightness: number
  readonly keep: number
  readonly dispersion: number
}

export interface RefractionSource {
  readonly el: HTMLCanvasElement
  readonly moving?: boolean
  readonly external?: boolean
}

export interface GlassRefraction {
  readonly failed: boolean
  setEnabled(on: boolean): void
  reset(): void
  wake(): void
  frame(): void
}

export function createRefraction(
  canvas: HTMLCanvasElement,
  options: {
    source: () => RefractionSource | null
    surfaces: () => GlassSurface[]
  },
): GlassRefraction | null
