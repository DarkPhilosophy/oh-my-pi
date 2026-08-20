import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { copyHelp as commandHelp } from "../cli/command-help";
import { copyTextPersistent } from "../utils/clipboard";
import { registerCopyUrlHandler, resolveCopyBlock } from "../utils/copy-store";

export default class Copy extends Command {
	static description = commandHelp.description;
	static args = {
		url: Args.string({
			description: "omp-copy:<id> URL or a bare 16-hex block id",
			required: false,
		}),
	};

	static flags = {
		"install-handler": Flags.boolean({
			description: "Register the omp-copy: URL scheme handler (Linux xdg)",
		}),
	};

	static examples = [
		"# Register the click-to-copy URL handler (also auto-registered on startup)\n  omp copy --install-handler",
		"# Copy a stored block (normally invoked by the terminal on a chip click)\n  omp copy omp-copy:0123456789abcdef",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Copy);
		if (flags["install-handler"]) {
			const result = await registerCopyUrlHandler();
			if (result.ok) {
				process.stdout.write(
					`Registered omp-copy: → ${result.desktopPath}\n` +
						`Clicking a [copy] chip now copies the block. Your terminal must support OSC 8 links.\n`,
				);
			} else {
				process.stderr.write(`copy: handler registration failed: ${result.error}\n`);
				process.exitCode = 1;
			}
			return;
		}
		if (!args.url) {
			process.stderr.write("usage: omp copy <omp-copy:id> | omp copy --install-handler\n");
			process.exitCode = 2;
			return;
		}
		const code = resolveCopyBlock(args.url);
		if (code === undefined) {
			process.stderr.write(`copy: no stored block for ${args.url}\n`);
			process.exitCode = 1;
			return;
		}
		await copyTextPersistent(code);
	}
}
