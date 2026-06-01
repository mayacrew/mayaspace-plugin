/**
 * One-step password login modal.
 *
 * Replaces the Device Flow browser round-trip with a single form. The
 * plugin is a trusted client (user installed it manually into their own
 * vault), so taking credentials directly is fine — the password never
 * touches plugin.saveData(), only the resulting tokens do.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import { InvalidCredentialsError, MayaspaceAuth } from "./mayaspace-auth";

export class PasswordLoginModal extends Modal {
	private email = "";
	private password = "";
	private submitting = false;

	constructor(
		app: App,
		private auth: MayaspaceAuth,
		private deviceName: string,
		private onSuccess: () => Promise<void> | void,
		private onSwitchToSignup?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "MayaSpace 로그인" });
		contentEl.createEl("p", {
			text: "이메일과 비밀번호로 바로 로그인합니다. 비밀번호는 옵시디언 디스크에 저장되지 않고, 발급된 토큰만 저장됩니다.",
		});

		new Setting(contentEl)
			.setName("이메일")
			.addText((t) => {
				t.setPlaceholder("alice@example.com").setValue(this.email).onChange((v) => { this.email = v.trim(); });
				t.inputEl.type = "email";
				t.inputEl.autocapitalize = "off";
				t.inputEl.spellcheck = false;
				setTimeout(() => t.inputEl.focus(), 0);
			});

		new Setting(contentEl)
			.setName("비밀번호")
			.addText((t) => {
				t.setPlaceholder("••••••••").setValue(this.password).onChange((v) => { this.password = v; });
				t.inputEl.type = "password";
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						this.submit();
					}
				});
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(this.submitting ? "로그인 중…" : "로그인")
					.setCta()
					.setDisabled(this.submitting)
					.onClick(() => this.submit()),
			)
			.addButton((btn) => btn.setButtonText("취소").onClick(() => this.close()));

		if (this.onSwitchToSignup) {
			const switchEl = contentEl.createEl("p", { cls: "mayaspace-auth-switch" });
			switchEl.appendText("계정이 없으세요? ");
			const link = switchEl.createEl("a", { text: "회원가입", href: "#" });
			link.addEventListener("click", (e) => {
				e.preventDefault();
				this.close();
				this.onSwitchToSignup?.();
			});
		}
	}

	private async submit(): Promise<void> {
		if (this.submitting) return;
		if (!this.email || !this.password) {
			new Notice("이메일과 비밀번호를 모두 입력해 주세요.");
			return;
		}
		this.submitting = true;
		this.render();
		try {
			await this.auth.loginWithPassword(this.email, this.password, this.deviceName);
			// Wipe in-memory password as soon as the call returns. Tokens
			// are now stored by mayaspace-auth; we never persist `this.password`.
			this.password = "";
			new Notice("MayaSpace에 로그인했습니다.");
			this.close();
			await this.onSuccess();
		} catch (e) {
			if (e instanceof InvalidCredentialsError) {
				new Notice("이메일 또는 비밀번호가 올바르지 않습니다.");
			} else {
				new Notice(`로그인 실패: ${e instanceof Error ? e.message : String(e)}`);
			}
			this.submitting = false;
			this.render();
		}
	}

	onClose(): void {
		// Defensive: empty password fields and our captured value.
		this.password = "";
	}
}
