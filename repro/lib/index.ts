declare const NodeInspectSymbol: unique symbol;

export interface Duration {
	readonly [NodeInspectSymbol]: "Duration";
	readonly millis: number;
}

export declare const dur2: Duration;
