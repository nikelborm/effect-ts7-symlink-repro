declare const NodeInspectSymbol: unique symbol

export interface Duration {
  readonly [NodeInspectSymbol]: "Duration"
  readonly millis: number
}

export const make = (millis: number): Duration => ({ millis } as Duration)
