import { isRecord } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

/** Whether a wire schema owns `i` as a tool parameter rather than harness intent. */
export function schemaDeclaresIntentField(schema: unknown): boolean {
	return isRecord(schema) && isRecord(schema.properties) && Object.hasOwn(schema.properties, INTENT_FIELD);
}
