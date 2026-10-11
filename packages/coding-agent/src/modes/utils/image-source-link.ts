import type { ImageContent } from "@oh-my-pi/pi-ai";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { InternalUrlRouter, type LocalProtocolOptions } from "../../internal-urls";

/**
 * The file a chip or transcript image opens: an attachment's source path, with an
 * internal URL (`local://pasted-image-<hash>.png`, a clipboard image committed to the
 * session) resolved to the on-disk file under the session's current root. The source
 * itself keeps the relocation-safe URL; only the OSC 8 / native `href` needs a real
 * path, because `fileHyperlink` would otherwise resolve the URL against the cwd
 * (`file:///cwd/local:/pasted-image-….png`) and no viewer can open that.
 * Undefined when nothing backs the URL, so the caller falls back to a blob copy.
 */
export function imageSourceLinkPath(source: string, options: LocalProtocolOptions): string | undefined {
	const router = InternalUrlRouter.instance();
	if (!router.canHandle(source)) return source;
	return router.locateSync(source, { localProtocolOptions: options });
}

/** Link target for an attached image: its source file when it has one, else `fallback` (a blob copy). */
export function imageLinkTarget(
	image: ImageContent,
	options: LocalProtocolOptions,
	fallback: string | undefined,
): string | undefined {
	const source = imageAttachmentSource(image)?.path;
	return (source && imageSourceLinkPath(source, options)) ?? fallback;
}
