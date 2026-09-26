import { make, type Duration } from "lib"

export const millis = (d: Duration): number => d.millis
export const one = make(1)
