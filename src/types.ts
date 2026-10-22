/**
 * Public and internal types for pi-goal-orchestrator.
 *
 * The tool schema is deliberately JSON-shaped: everything a caller can pass is
 * plain data, so it can also be produced by a planner model or a script.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type IsolationMode = "worktree" | "off";

export type NodeStatus =
	| "pending"
	| "running"
	| "auditing"
	| "done"
	| "failed"
	| "blocked"
	| "stopped";

export interface PlanNodeSpec {
	id: string;
	title?: string;
	/** Self-contained brief for the worker. It should not assume the parent transcript. */
	prompt: string;
	deps?: string[];
	agent_type?: string;
	model?: string;
	thinking_level?: ThinkingLevel;
	isolation?: IsolationMode;
	max_turns?: number;
	timeout_seconds?: number;
	/** Independent audit of this node's result. Defaults to true. */
	audit?: boolean;
	max_attempts?: number;
	/** Paths (relative to cwd) the node is expected to produce or update. */
	outputs?: string[];
}

export interface PlanAuditSpec {
	enabled?: boolean;
	model?: string;
	thinking_level?: ThinkingLevel;
}

export interface PlanSpec {
	goal_id?: string;
	objective?: string;
	nodes: PlanNodeSpec[];
	max_concurrent?: number;
	fail_fast?: boolean;
	audit?: PlanAuditSpec;
}

export interface PlanNode {
	id: string;
	title: string;
	prompt: string;
	deps: string[];
	agentType: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	isolation?: IsolationMode;
	maxTurns: number;
	timeoutMs: number;
	audit: boolean;
	maxAttempts: number;
	outputs: string[];

	// Runtime state.
	status: NodeStatus;
	attempts: number;
	agentId?: string;
	startedAt?: string;
	completedAt?: string;
	/** Worker's final prose result. */
	result?: string;
	/** Structured summary extracted from the worker result, when present. */
	summary?: string;
	/** Auditor feedback from the latest rejected attempt. */
	lastAudit?: NodeAuditResult;
	auditHistory: NodeAuditResult[];
	error?: string;
	/** Artifact directory for this node, absolute. */
	artifactDir?: string;
	/** Worktree branch auto-committed by pi-subagents, when isolation was used. */
	branch?: string;
	usage: NodeUsage;
}

export interface NodeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	auditInput: number;
	auditOutput: number;
}

export interface NodeAuditResult {
	approved: boolean;
	disapproved: boolean;
	output: string;
	model?: string;
	error?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface NormalizedPlan {
	goalId?: string;
	objective: string;
	nodes: PlanNode[];
	maxConcurrent: number;
	failFast: boolean;
	audit: { enabled: boolean; model?: string; thinkingLevel?: ThinkingLevel };
}

export interface WorkerOutcome {
	agentId: string;
	status: string;
	result: string;
	error?: string;
	branch?: string;
	usage: NodeUsage;
}

export interface RunProgress {
	runId: string;
	artifactDir: string;
	nodes: Array<{
		id: string;
		status: NodeStatus;
		attempts: number;
		agentId?: string;
		lastAudit?: "approved" | "rejected";
	}>;
}

export interface RunResult {
	runId: string;
	status: "complete" | "failed" | "aborted";
	artifactDir: string;
	objective: string;
	goalId?: string;
	nodes: PlanNode[];
	startedAt: string;
	completedAt: string;
	usage: NodeUsage;
	/** Root cause when status is not complete. */
	error?: string;
}

export const DEFAULT_MAX_CONCURRENT = 3;
export const HARD_MAX_CONCURRENT = 16;
export const DEFAULT_MAX_TURNS = 80;
export const DEFAULT_TIMEOUT_SECONDS = 1800;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const MAX_NODES = 32;
