/**
 * 회원가입 모달. 가입 성공 시 토큰을 받아 바로 로그인 상태가 된다.
 * 가입 방식은 '초대 토큰으로 합류' 또는 '새 조직 만들기' 중 하나.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import {
	EmailAlreadyRegisteredError,
	MayaspaceAuth,
	SignupNotAllowedError,
} from "./mayaspace-auth";

type SignupMode = "invite" | "org";

export class SignupModal extends Modal {
	private email = "";
	private password = "";
	private displayName = "";
	private inviteToken = "";
	private orgName = "";
	private mode: SignupMode = "invite";
	private submitting = false;

	constructor(
		app: App,
		private auth: MayaspaceAuth,
		private deviceName: string,
		private onSuccess: () => Promise<void> | void,
		private onSwitchToLogin: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "MayaSpace 회원가입" });
		contentEl.createEl("p", {
			text: "계정을 만들면 바로 로그인됩니다. 비밀번호는 디스크에 저장되지 않고 발급된 토큰만 저장됩니다.",
		});

		new Setting(contentEl).setName("이메일").addText((t) => {
			t.setPlaceholder("alice@example.com").setValue(this.email).onChange((v) => { this.email = v.trim(); });
			t.inputEl.type = "email";
			t.inputEl.autocapitalize = "off";
			t.inputEl.spellcheck = false;
			setTimeout(() => t.inputEl.focus(), 0);
		});

		new Setting(contentEl).setName("비밀번호 (최소 8자)").addText((t) => {
			t.setPlaceholder("••••••••").setValue(this.password).onChange((v) => { this.password = v; });
			t.inputEl.type = "password";
		});

		new Setting(contentEl).setName("이름").addText((t) => {
			t.setPlaceholder("표시 이름").setValue(this.displayName).onChange((v) => { this.displayName = v.trim(); });
		});

		new Setting(contentEl).setName("가입 방식").addDropdown((d) => {
			d.addOption("invite", "초대 토큰으로 합류");
			d.addOption("org", "새 조직 만들기");
			d.setValue(this.mode);
			d.onChange((v) => { this.mode = v as SignupMode; this.render(); });
		});

		if (this.mode === "invite") {
			new Setting(contentEl).setName("초대 토큰").addText((t) => {
				t.setPlaceholder("초대 메일/관리자에게 받은 토큰").setValue(this.inviteToken)
					.onChange((v) => { this.inviteToken = v.trim(); });
			});
		} else {
			new Setting(contentEl).setName("조직 이름").addText((t) => {
				t.setPlaceholder("예: Acme").setValue(this.orgName).onChange((v) => { this.orgName = v.trim(); });
			});
		}

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(this.submitting ? "가입 중…" : "가입")
					.setCta()
					.setDisabled(this.submitting)
					.onClick(() => this.submit()),
			)
			.addButton((btn) => btn.setButtonText("취소").onClick(() => this.close()));

		const switchEl = contentEl.createEl("p", { cls: "mayaspace-auth-switch" });
		switchEl.appendText("이미 계정이 있으세요? ");
		const link = switchEl.createEl("a", { text: "로그인", href: "#" });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			this.close();
			this.onSwitchToLogin();
		});
	}

	private async submit(): Promise<void> {
		if (this.submitting) return;
		if (!this.email || !this.password || !this.displayName) {
			new Notice("이메일·비밀번호·이름을 모두 입력해 주세요.");
			return;
		}
		if (this.mode === "invite" && !this.inviteToken) {
			new Notice("초대 토큰을 입력해 주세요.");
			return;
		}
		if (this.mode === "org" && !this.orgName) {
			new Notice("조직 이름을 입력해 주세요.");
			return;
		}

		this.submitting = true;
		this.render();
		try {
			await this.auth.register({
				email: this.email,
				password: this.password,
				displayName: this.displayName,
				deviceName: this.deviceName,
				token: this.mode === "invite" ? this.inviteToken : undefined,
				orgName: this.mode === "org" ? this.orgName : undefined,
			});
			this.password = "";
			new Notice("MayaSpace 회원가입 완료. 로그인되었습니다.");
			this.close();
			await this.onSuccess();
		} catch (e) {
			if (e instanceof EmailAlreadyRegisteredError) {
				new Notice("이미 가입된 이메일입니다.");
			} else if (e instanceof SignupNotAllowedError) {
				new Notice("지금은 초대를 받아야 가입할 수 있어요. 초대 토큰으로 다시 시도해 주세요.");
			} else {
				new Notice(`가입 실패: ${e instanceof Error ? e.message : String(e)}`);
			}
			this.submitting = false;
			this.render();
		}
	}

	onClose(): void {
		this.password = "";
	}
}
