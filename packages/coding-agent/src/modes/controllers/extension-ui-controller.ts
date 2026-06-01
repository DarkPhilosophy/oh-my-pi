		});
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		const placement = options?.placement ?? "aboveEditor";
		this.#removeHookWidget(this.#hookWidgetsAbove, key);
		this.#removeHookWidget(this.#hookWidgetsBelow, key);
		this.#rightWidgets.delete(key);

		if (content === undefined) {
			this.#flushRightWidgets();
			this.#rebuildHookWidgets();
			return;
		}

		if (placement === "rightEditor") {
			this.#rightWidgets.set(key, this.#contentToRightLines(content));
			this.#flushRightWidgets();
			this.#rebuildHookWidgets();
			return;
		}

		const target = placement === "belowEditor" ? this.#hookWidgetsBelow : this.#hookWidgetsAbove;
		target.set(key, this.#createHookWidget(content));
		this.#rebuildHookWidgets();
