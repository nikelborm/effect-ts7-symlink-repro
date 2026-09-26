declare const Something: unique symbol;
export interface Duration {
	readonly [Something]: "Duration";
}
export declare const dur2: Duration;
