import { describe, expect, it } from "bun:test";
import { resolveTinyModelDevicePreference, tinyModelDeviceLoadOrder } from "@oh-my-pi/pi-coding-agent/tiny/device";

describe("automatic tiny model device selection", () => {
	it("selects CUDA first on hosts with CUDA hardware", () => {
		const preference = resolveTinyModelDevicePreference("auto");
		expect(tinyModelDeviceLoadOrder(preference, undefined, { cuda: true, rocm: false })).toEqual(["cuda", "cpu"]);
	});

	it("selects ROCm through the ONNX GPU provider on AMD hosts", () => {
		const preference = resolveTinyModelDevicePreference("auto");
		expect(tinyModelDeviceLoadOrder(preference, undefined, { cuda: false, rocm: true })).toEqual(["gpu", "cpu"]);
	});

	it("falls back to CPU when no supported accelerator is detected", () => {
		const preference = resolveTinyModelDevicePreference("auto");
		expect(tinyModelDeviceLoadOrder(preference, undefined, { cuda: false, rocm: false })).toEqual(["cpu"]);
	});

	it("keeps explicit providers independent of host detection", () => {
		const preference = resolveTinyModelDevicePreference("cuda");
		expect(tinyModelDeviceLoadOrder(preference, undefined, { cuda: false, rocm: true })).toEqual(["cuda", "cpu"]);
	});
});
