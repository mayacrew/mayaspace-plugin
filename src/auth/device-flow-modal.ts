/**
 * Device Flow approval modal.
 *
 * Shows the user_code prominently, offers "Open browser" to verification_uri,
 * and polls the server every interval seconds. On 410 (expired), surfaces a
 * restart button instead of silently failing.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import {
	DeviceFlowExpiredError,
	DeviceFlowPendingError,
	MayaspaceAuth,
	type DeviceFlowSession,
} from "./mayaspace-auth";

export class DeviceFlowModal extends Modal {
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private session: DeviceFlowSession | null = null;
	private closed = false;

	constructor(
		app: App,
		private auth: MayaspaceAuth,
		private deviceName: string,
		private onApproved: () => Promise<void> | void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Sign in to MayaSpace" });
		this.contentEl.createEl("p", {
			text: "Start a device authorization. The server will give you a code to enter in your browser.",
		});
		this.renderStart();
	}

	onClose(): void {
		this.closed = true;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private renderStart(): void {
		const container = this.contentEl.createDiv();
		new Setting(container)
			.setName("Begin")
			.setDesc("Request a one-time code from the server.")
			.addButton((btn) =>
				btn
					.setButtonText("Start sign-in")
					.setCta()
					.onClick(async () => {
						container.remove();
						await this.start();
					}),
			);
	}

	private async start(): Promise<void> {
		try {
			this.session = await this.auth.startDeviceFlow(this.deviceName);
		} catch (e) {
			this.renderError(e);
			return;
		}
		this.renderApproval(this.session);
		this.schedulePoll(this.session.intervalSec);
	}

	private renderApproval(session: DeviceFlowSession): void {
		const box = this.contentEl.createDiv();
		box.createEl("p", { text: "Enter this code in your browser:" });
		const codeEl = box.createEl("h1", { text: session.userCode });
		codeEl.style.letterSpacing = "0.1em";
		codeEl.style.textAlign = "center";

		new Setting(box)
			.setName("Open verification page")
			.setDesc(session.verificationUri)
			.addButton((btn) =>
				btn
					.setButtonText("Open browser")
					.setCta()
					.onClick(() => {
						// 코드를 함께 전달 → 승인 페이지에 prefill되어 한 번에 승인 가능.
						const sep = session.verificationUri.includes("?") ? "&" : "?";
						const url = `${session.verificationUri}${sep}code=${encodeURIComponent(session.userCode)}`;
						window.open(url, "_blank");
					}),
			);

		box.createEl("p", {
			text: `Waiting for approval. This code expires in ${session.expiresInSec}s.`,
			cls: "mayaspace-device-flow-waiting",
		});
	}

	private schedulePoll(intervalSec: number): void {
		this.pollTimer = setTimeout(() => this.poll(), Math.max(1, intervalSec) * 1000);
	}

	private async poll(): Promise<void> {
		if (this.closed || !this.session) return;
		try {
			await this.auth.pollDeviceFlow(this.session.deviceCode);
		} catch (e) {
			if (e instanceof DeviceFlowPendingError) {
				this.schedulePoll(this.session.intervalSec);
				return;
			}
			if (e instanceof DeviceFlowExpiredError) {
				this.renderExpired();
				return;
			}
			this.renderError(e);
			return;
		}
		new Notice("MayaSpace: signed in.");
		this.close();
		try {
			await this.onApproved();
		} catch (e) {
			console.warn("[mayaspace] post-approval error", e);
		}
	}

	private renderExpired(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Code expired" });
		this.contentEl.createEl("p", { text: "Start a new sign-in to get a fresh code." });
		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText("Try again")
				.setCta()
				.onClick(() => {
					this.session = null;
					this.contentEl.empty();
					this.renderStart();
				}),
		);
	}

	private renderError(e: unknown): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Sign-in failed" });
		this.contentEl.createEl("p", { text: e instanceof Error ? e.message : String(e) });
		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("Close").onClick(() => this.close()),
		);
	}
}
