/** Small filesystem helpers shared by the plan store and run artifacts. */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Absolute path for a configured root; relative roots resolve against cwd. */
export function resolveRoot(cwd: string, root: string): string {
	return path.isAbsolute(root) ? root : path.join(cwd, root);
}

/** Turn arbitrary text into a short, path-safe segment. */
export function safeSegment(value: string, fallback: string): string {
	const clean = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return clean || fallback;
}

/** Write through a temp file so a crash never leaves truncated JSON behind. */
export function writeAtomic(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	fs.writeFileSync(temp, content, "utf8");
	fs.renameSync(temp, filePath);
}
