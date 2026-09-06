// Qoder machine identity for COSY signing.
//
// A machine id is a stable, non-secret UUID the gateway associates with the
// client install. When the operator has the Qoder CLI installed, we reuse its
// machine id (~/.qoder/.auth/machine_id) so both clients present one device;
// otherwise a generated id is persisted inside the omp config dir.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import crypto from "node:crypto";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";

const MACHINE_ID_PATTERN = /^[0-9a-f-]{36}$/i;

let cached: string | null = null;

/**
 * Resolve the omp config root (`~/.omp` or `$PI_CONFIG_DIR`). Read HOME
 * directly each call — `node:os.homedir()` is cached at process start in Bun
 * and ignores later env changes, which breaks the file-overriding contract
 * the machine-id test relies on.
 */
function ompConfigRoot(): string {
	const dirName = process.env.PI_CONFIG_DIR?.trim() || CONFIG_DIR_NAME;
	const home = process.env.HOME?.trim() || os.homedir();
	return path.join(home, dirName);
}

/**
 * The Qoder CLI's machine-id path also depends on $HOME; read it directly
 * for the same reason.
 */
function qoderCliMachineIdPath(): string {
	const home = process.env.HOME?.trim() || os.homedir();
	return path.join(home, ".qoder", ".auth", "machine_id");
}

export function getQoderMachineId(): string {
	if (cached) return cached;
	const cliPath = qoderCliMachineIdPath();
	try {
		if (fs.existsSync(cliPath)) {
			const value = fs.readFileSync(cliPath, "utf8").trim();
			if (MACHINE_ID_PATTERN.test(value)) {
				cached = value;
				return value;
			}
		}
	} catch {
		// Fall through to the omp-owned id.
	}
	const ownPath = path.join(ompConfigRoot(), "qoder-machine-id");
	try {
		if (fs.existsSync(ownPath)) {
			const value = fs.readFileSync(ownPath, "utf8").trim();
			if (MACHINE_ID_PATTERN.test(value)) {
				cached = value;
				return value;
			}
		}
		// Persist a generated id with restrictive perms so the file never widens
		// to the user's default umask (the file holds an opaque device token,
		// not a credential, but tightening perms by default is free).
		const generated = crypto.randomUUID();
		fs.mkdirSync(ompConfigRoot(), { recursive: true });
		fs.writeFileSync(ownPath, generated, { encoding: "utf8", mode: 0o600 });
		cached = generated;
		return generated;
	} catch {
		// Last resort: a process-local id. Signing still works; the gateway simply
		// sees a fresh device per restart.
		cached = crypto.randomUUID();
		return cached;
	}
}

/** Test seam. */
export function resetQoderMachineIdForTests(): void {
	cached = null;
}
