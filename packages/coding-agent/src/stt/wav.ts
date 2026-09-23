/**
 * Minimal WAV (RIFF/PCM) decoder producing the Float32Array @ 16 kHz mono that
 * transformers.js `automatic-speech-recognition` expects. Ports the decode/
 * mono-mix/resample logic from the retired Python `transcribe.py` (which read
 * via the stdlib `wave` module) so STT no longer shells out to Python.
 *
 * Supported sample formats: PCM uint8 (8-bit), int16 (16-bit), int32 (32-bit),
 * and IEEE float32 (format tag 3). Any number of channels is mixed down to mono.
 */

/** transformers.js Whisper feature extractor operates at 16 kHz. */
export const TARGET_SAMPLE_RATE = 16_000;

const WAV_FORMAT_PCM = 1;
const WAV_FORMAT_IEEE_FLOAT = 3;
const WAV_FORMAT_EXTENSIBLE = 0xfffe;

interface WavData {
	format: number;
	channels: number;
	sampleRate: number;
	bitsPerSample: number;
	/** Raw PCM/float bytes from the `data` chunk. */
	samples: DataView;
}

function readFourCc(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3),
	);
}

/** Parse the RIFF container, returning the `fmt ` parameters and `data` bytes. */
function parseWav(buffer: ArrayBuffer): WavData {
	const view = new DataView(buffer);
	if (buffer.byteLength < 12 || readFourCc(view, 0) !== "RIFF" || readFourCc(view, 8) !== "WAVE") {
		throw new Error("Not a RIFF/WAVE file");
	}

	let format: number | undefined;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let samples: DataView | undefined;

	// Chunks begin after the 12-byte RIFF/WAVE header; each is an 8-byte header
	// (4-char id + uint32 LE size) followed by `size` bytes padded to even.
	let offset = 12;
	while (offset + 8 <= buffer.byteLength) {
		const id = readFourCc(view, offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt ") {
			format = view.getUint16(body, true);
			channels = view.getUint16(body + 2, true);
			sampleRate = view.getUint32(body + 4, true);
			bitsPerSample = view.getUint16(body + 14, true);
			// WAVE_FORMAT_EXTENSIBLE (ffmpeg & friends): the real codec is the
			// first 2 bytes of the SubFormat GUID in the fmt extension.
			if (format === WAV_FORMAT_EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
		} else if (id === "data") {
			const length = Math.min(size, buffer.byteLength - body);
			samples = new DataView(buffer, body, length);
		}
		offset = body + size + (size % 2);
	}

	if (format === undefined || samples === undefined || channels < 1 || sampleRate < 1) {
		throw new Error("WAV file missing fmt/data chunks");
	}
	return { format, channels, sampleRate, bitsPerSample, samples };
}

/** Decode raw PCM/float bytes into interleaved normalized [-1, 1] float samples. */
function decodeSamples(wav: WavData): Float32Array {
	const { format, bitsPerSample, samples } = wav;
	const view = samples;
	if (format === WAV_FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
		const count = Math.floor(view.byteLength / 4);
		const out = new Float32Array(count);
		for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(i * 4, true);
		return out;
	}
	if (format !== WAV_FORMAT_PCM) {
		throw new Error(`Unsupported WAV format tag: ${format}`);
	}
	if (bitsPerSample === 16) {
		const count = Math.floor(view.byteLength / 2);
		const out = new Float32Array(count);
		for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 32_768;
		return out;
	}
	if (bitsPerSample === 8) {
		// 8-bit PCM is unsigned, centered at 128.
		const count = view.byteLength;
		const out = new Float32Array(count);
		for (let i = 0; i < count; i += 1) out[i] = (view.getUint8(i) - 128) / 128;
		return out;
	}
	if (bitsPerSample === 32) {
		const count = Math.floor(view.byteLength / 4);
		const out = new Float32Array(count);
		for (let i = 0; i < count; i += 1) out[i] = view.getInt32(i * 4, true) / 2_147_483_648;
		return out;
	}
	throw new Error(`Unsupported PCM sample width: ${bitsPerSample} bits`);
}

/** Average interleaved channels down to a single mono track. */
function mixToMono(interleaved: Float32Array, channels: number): Float32Array {
	if (channels <= 1) return interleaved;
	const frames = Math.floor(interleaved.length / channels);
	const out = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame += 1) {
		let sum = 0;
		for (let channel = 0; channel < channels; channel += 1) sum += interleaved[frame * channels + channel]!;
		out[frame] = sum / channels;
	}
	return out;
}

/**
 * Resample via linear interpolation, mirroring the Python `np.interp` over
 * `linspace(0, n-1, targetLen)` against `arange(n)`.
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || input.length === 0) return input;
	const n = input.length;
	const targetLen = Math.max(1, Math.floor((n * toRate) / fromRate));
	const out = new Float32Array(targetLen);
	if (targetLen === 1) {
		out[0] = input[0]!;
		return out;
	}
	const step = (n - 1) / (targetLen - 1);
	for (let i = 0; i < targetLen; i += 1) {
		const pos = i * step;
		const lo = Math.floor(pos);
		const hi = Math.min(lo + 1, n - 1);
		const frac = pos - lo;
		out[i] = input[lo]! * (1 - frac) + input[hi]! * frac;
	}
	return out;
}

/**
 * Decode a WAV byte buffer into a 16 kHz mono Float32Array suitable for the
 * transformers.js Whisper pipeline.
 */
export function decodeWavToMono16k(buffer: ArrayBuffer): Float32Array {
	const wav = parseWav(buffer);
	const interleaved = decodeSamples(wav);
	const mono = mixToMono(interleaved, wav.channels);
	return resampleLinear(mono, wav.sampleRate, TARGET_SAMPLE_RATE);
}

/**
 * Decode interleaved little-endian signed 16-bit PCM bytes into normalized
 * [-1, 1] mono float samples. The live recorder streams raw s16le frames from
 * sox/ffmpeg/arecord stdout (no RIFF container), so this is the hot-path
 * counterpart to {@link decodeWavToMono16k}. `bytes` MUST be 2-byte aligned;
 * callers buffer any trailing odd byte across chunk boundaries.
 */
export function decodePcmS16LE(bytes: Uint8Array): Float32Array {
	const count = bytes.length >>> 1;
	const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
	const out = new Float32Array(count);
	for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 32_768;
	return out;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
	for (let index = 0; index < text.length; index++) target[offset + index] = text.charCodeAt(index);
}

export function encodePcm16Wav(chunks: readonly Float32Array[], sampleRate = 16_000): Uint8Array {
	let sampleCount = 0;
	for (const chunk of chunks) sampleCount += chunk.length;

	const channelCount = 1;
	const bytesPerSample = 2;
	const dataBytes = sampleCount * bytesPerSample;
	const wav = new Uint8Array(44 + dataBytes);
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

	writeAscii(wav, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(wav, 8, "WAVE");
	writeAscii(wav, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channelCount, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
	view.setUint16(32, channelCount * bytesPerSample, true);
	view.setUint16(34, bytesPerSample * 8, true);
	writeAscii(wav, 36, "data");
	view.setUint32(40, dataBytes, true);

	let offset = 44;
	for (const chunk of chunks) {
		for (const sample of chunk) {
			const clamped = Math.max(-1, Math.min(1, sample));
			view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
			offset += bytesPerSample;
		}
	}
	return wav;
}
