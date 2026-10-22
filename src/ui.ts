/**
 * Orchestrator dashboard.
 *
 * A compact above-editor widget that mirrors the subagents widget's visual
 * language (tree, status icons, attempts) and sits next to it: subagents shows
 * the live workers, this shows the plan they belong to. The status bar carries
 * the one-line summary, so the widget can stay hidden when there is nothing to
 * show.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanRecord } from "./plans.ts";
import type { NodeStatus, RunProgress } from "./types.ts";

export interface ActiveRunView {
	number?: number;
	title: string;
	status: string;
	total: number;
	progress?: RunProgress;
}

export interface OrchestratorView {
	plans: PlanRecord[];
	active?: ActiveRunView;
}

interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const WIDGET_KEY = "orchestrator";
const STATUS_KEY = "orchestrator";

const NODE_ICON: Record<NodeStatus, { glyph: string; color: string }> = {
	pending: { glyph: "○", color: "dim" },
	running: { glyph: "◐", color: "accent" },
	auditing: { glyph: "◑", color: "accent" },
	done: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	blocked: { glyph: "⊘", color: "warning" },
	stopped: { glyph: "■", color: "dim" },
};

const PLAN_COLOR: Record<string, string> = {
	planned: "dim",
	running: "accent",
	complete: "success",
	failed: "error",
	aborted: "warning",
};

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class OrchestratorWidget {
	private ctx?: ExtensionContext;
	private view: OrchestratorView = { plans: [] };
	private enabled = true;
	private registered = false;
	private tui?: { requestRender(): void };
	private lastStatus?: string;

	configure(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.clear();
	}

	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.registered = false;
		this.tui = undefined;
		this.lastStatus = undefined;
		this.refresh();
	}

	setView(view: OrchestratorView): void {
		this.view = view;
		this.refresh();
	}

	dispose(): void {
		this.clear();
		this.ctx = undefined;
	}

	private clear(): void {
		try {
			this.ctx?.ui.setWidget(WIDGET_KEY, undefined);
			if (this.lastStatus !== undefined) this.ctx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Headless sessions have no widget surface.
		}
		this.registered = false;
		this.tui = undefined;
		this.lastStatus = undefined;
	}

	private refresh(): void {
		const ctx = this.ctx;
		if (!ctx || !this.enabled) return;
		const { plans, active } = this.view;
		if (!active && plans.length === 0) {
			this.clear();
			return;
		}

		const status = this.statusText();
		try {
			if (status !== this.lastStatus) {
				ctx.ui.setStatus(STATUS_KEY, status);
				this.lastStatus = status;
			}
			if (!this.registered) {
				ctx.ui.setWidget(
					WIDGET_KEY,
					(tui, theme) => {
						this.tui = tui;
						return {
							render: () => this.render(theme),
							invalidate: () => {
								// Theme changed: let the next refresh re-register with the new theme.
								this.registered = false;
								this.tui = undefined;
							},
						};
					},
					{ placement: "aboveEditor" },
				);
				this.registered = true;
			} else {
				this.tui?.requestRender();
			}
		} catch {
			// Headless sessions have no widget surface.
		}
	}

	private statusText(): string | undefined {
		const { plans, active } = this.view;
		if (active) {
			const total = active.progress?.nodes.length ?? active.total;
			const done = active.progress?.nodes.filter((node) => node.status === "done").length ?? 0;
			const label = active.number === undefined ? "adhoc" : `#${active.number}`;
			return `${label} running ${done}/${total}`;
		}
		if (plans.length === 0) return undefined;
		const running = plans.filter((plan) => plan.status === "running").length;
		if (running > 0) return `${running} plan${running === 1 ? "" : "s"} running`;
		return `${plans.length} plan${plans.length === 1 ? "" : "s"}`;
	}

	private render(theme: Theme): string[] {
		const { plans, active } = this.view;
		const lines: string[] = [theme.fg("accent", "● ") + theme.bold("Orchestrator")];
		if (active) {
			const nodes = active.progress?.nodes ?? [];
			const done = nodes.filter((node) => node.status === "done").length;
			const total = nodes.length || active.total;
			const label = active.number === undefined ? "adhoc" : `#${active.number}`;
			lines.push(
				theme.fg("dim", "├─ ") +
					theme.fg("accent", label) +
					` ${truncate(active.title, 60)} ` +
					theme.fg("dim", "·") +
					` ${theme.fg(PLAN_COLOR[active.status] ?? "accent", active.status)} ` +
					theme.fg("dim", `· ${done}/${total} nodes`),
			);
			if (nodes.length > 0) {
				const chips = nodes.map((node) => {
					const icon = NODE_ICON[node.status] ?? NODE_ICON.pending;
					const attempt = node.attempts > 1 ? theme.fg("warning", `↻${node.attempts}`) : "";
					return `${theme.fg(icon.color, icon.glyph)} ${node.id}${attempt}`;
				});
				const visible = chips.slice(0, 6);
				if (chips.length > visible.length) visible.push(theme.fg("dim", `+${chips.length - visible.length} more`));
				lines.push(theme.fg("dim", "│   ⎿  ") + visible.join(theme.fg("dim", " · ")));
			}
			const others = plans.filter((candidate) => candidate.number !== active.number).length;
			if (others > 0) lines.push(theme.fg("dim", `└─ ${others} other plan${others === 1 ? "" : "s"} · /orchestrator-plan-list`));
			else lines.push(theme.fg("dim", "└─ /orchestrator-plan-list · /orchestrator-status"));
			return lines;
		}

		const visible = [...plans].sort((a, b) => b.number - a.number).slice(0, 3);
		for (const plan of visible) {
			lines.push(
				theme.fg("dim", "├─ ") +
					theme.fg("accent", `#${plan.number}`) +
					` ${truncate(plan.title, 60)} ` +
					theme.fg("dim", "·") +
					` ${theme.fg(PLAN_COLOR[plan.status] ?? "dim", plan.status)} ` +
					theme.fg("dim", `· ${plan.nodes.length} node${plan.nodes.length === 1 ? "" : "s"}`),
			);
		}
		const hidden = plans.length - visible.length;
		lines.push(
			theme.fg("dim", `└─ ${hidden > 0 ? `+${hidden} more · ` : ""}/orchestrator-plan-list · /orchestrator-resume`),
		);
		return lines;
	}
}
