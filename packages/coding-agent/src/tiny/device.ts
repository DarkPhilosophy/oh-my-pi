import type { DeviceType } from "@huggingface/transformers";
import { $env } from "@oh-my-pi/pi-utils";

export type TinyModelDevice = DeviceType;

export interface TinyModelDevicePreference {
	device: TinyModelDevice;
	raw: string | undefined;
	auto?: boolean;
}

export interface TinyModelAcceleratorAvailability {
	cuda: boolean;
	rocm: boolean;
}

const DEFAULT_ACCELERATOR_AVAILABILITY: TinyModelAcceleratorAvailability = { cuda: false, rocm: false };

const CPU_DEVICE: TinyModelDevice = "cpu";
const CPU_ONLY_ORDER: readonly TinyModelDevice[] = [CPU_DEVICE];
const DARWIN_WEBGPU_UNSAFE_ORDER: readonly TinyModelDevice[] = [CPU_DEVICE];

const DEVICE_VALUES: Record<TinyModelDevice, true> = {
	auto: true,
	gpu: true,
	cpu: true,
	wasm: true,
	webgpu: true,
	cuda: true,
	dml: true,
	coreml: true,
	webnn: true,
	"webnn-npu": true,
	"webnn-gpu": true,
	"webnn-cpu": true,
};

function usesDarwinWorkerWebGpu(device: TinyModelDevice): boolean {
	return process.platform === "darwin" && (device === "gpu" || device === "webgpu" || device === "auto");
}

export function normalizeTinyModelDevice(value: string | undefined): TinyModelDevice | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "metal") return "webgpu";
	if (raw in DEVICE_VALUES) return raw as TinyModelDevice;
	throw new Error(
		`Unsupported PI_TINY_DEVICE=${JSON.stringify(value)}. Use cpu, gpu, metal, webgpu, auto, cuda, dml, coreml, wasm, webnn, webnn-gpu, webnn-cpu, or webnn-npu.`,
	);
}

export function resolveTinyModelDevicePreference(
	value: string | undefined = $env.PI_TINY_DEVICE,
): TinyModelDevicePreference {
	const normalized = normalizeTinyModelDevice(value);
	return {
		device: normalized ?? CPU_DEVICE,
		raw: value,
		auto: normalized === "auto",
	};
}

function autoDeviceLoadOrder(
	availability: TinyModelAcceleratorAvailability,
	unavailableDevices?: ReadonlySet<TinyModelDevice>,
): readonly TinyModelDevice[] {
	const preferred: TinyModelDevice = availability.cuda ? "cuda" : availability.rocm ? "gpu" : CPU_DEVICE;
	if (preferred === CPU_DEVICE || unavailableDevices?.has(preferred)) return CPU_ONLY_ORDER;
	return [preferred, CPU_DEVICE];
}

export function tinyModelDeviceLoadOrder(
	preference: TinyModelDevicePreference,
	unavailableDevices?: ReadonlySet<TinyModelDevice>,
	availability: TinyModelAcceleratorAvailability = DEFAULT_ACCELERATOR_AVAILABILITY,
): readonly TinyModelDevice[] {
	if (preference.auto) return autoDeviceLoadOrder(availability, unavailableDevices);
	if (preference.device === CPU_DEVICE) return CPU_ONLY_ORDER;
	if (usesDarwinWorkerWebGpu(preference.device)) return DARWIN_WEBGPU_UNSAFE_ORDER;
	if (unavailableDevices?.has(preference.device)) return CPU_ONLY_ORDER;
	return [preference.device, CPU_DEVICE];
}

/**
 * Return accelerated devices whose failure is confirmed by a later successful
 * pipeline load. A failed attempt with no successful fallback must not poison
 * subsequent model loads because the error may be model-specific.
 */
export function tinyModelDevicesToMarkUnavailable(
	attemptedDevices: readonly TinyModelDevice[],
	successfulDevice: TinyModelDevice | undefined,
): readonly TinyModelDevice[] {
	if (successfulDevice === undefined) return [];
	const successfulIndex = attemptedDevices.indexOf(successfulDevice);
	if (successfulIndex < 1) return [];
	return attemptedDevices.slice(0, successfulIndex).filter(device => device !== CPU_DEVICE);
}

/** Sentinel `providers.tinyModelDevice` value meaning "use the built-in CPU default". */
export const TINY_MODEL_DEVICE_DEFAULT = "default";

/** Accepted values for the `providers.tinyModelDevice` setting (validation + UI). */
export const TINY_MODEL_DEVICE_SETTING_VALUES = [
	TINY_MODEL_DEVICE_DEFAULT,
	"gpu",
	"cpu",
	"metal",
	"webgpu",
	"cuda",
	"dml",
	"coreml",
	"auto",
	"wasm",
	"webnn",
	"webnn-gpu",
	"webnn-cpu",
	"webnn-npu",
] as const;

/** Submenu metadata for the `providers.tinyModelDevice` setting. */
export const TINY_MODEL_DEVICE_SETTING_OPTIONS = [
	{ value: "default", label: "Default", description: "CPU-only inference" },
	{ value: "gpu", label: "GPU", description: "Accelerated provider (WebGPU/Metal, CUDA, or DirectML)" },
	{ value: "cpu", label: "CPU", description: "CPU-only inference" },
	{ value: "metal", label: "Metal", description: "WebGPU alias for Apple GPUs" },
	{ value: "webgpu", label: "WebGPU", description: "WebGPU/Metal backend" },
	{ value: "cuda", label: "CUDA", description: "NVIDIA CUDA (Linux x64)" },
	{ value: "dml", label: "DirectML", description: "DirectML backend (Windows)" },
	{ value: "coreml", label: "CoreML", description: "Apple CoreML (opt-in; can fail to load)" },
	{ value: "auto", label: "Auto", description: "Let ONNX Runtime choose a provider" },
	{ value: "wasm", label: "WASM", description: "WebAssembly backend" },
	{ value: "webnn", label: "WebNN", description: "WebNN backend" },
	{ value: "webnn-gpu", label: "WebNN GPU", description: "WebNN GPU device" },
	{ value: "webnn-cpu", label: "WebNN CPU", description: "WebNN CPU device" },
	{ value: "webnn-npu", label: "WebNN NPU", description: "WebNN NPU device" },
] as const satisfies ReadonlyArray<{
	value: (typeof TINY_MODEL_DEVICE_SETTING_VALUES)[number];
	label: string;
	description: string;
}>;

/**
 * Map a `providers.tinyModelDevice` setting value onto a `PI_TINY_DEVICE` env
 * value for the worker. Returns `undefined` for the default sentinel so the
 * worker keeps its built-in CPU default; the worker still validates the
 * forwarded value via {@link normalizeTinyModelDevice}.
 */
export function tinyModelDeviceSettingToEnv(value: string | undefined): string | undefined {
	if (!value || value === TINY_MODEL_DEVICE_DEFAULT) return undefined;
	return value;
}
