/**
 * Claude Code sync.
 *
 * Claude Code has no API to ask what it is doing, but it can run a command on
 * its own lifecycle events. So the extension registers hooks in
 * ~/.claude/settings.json that write one word — busy or idle — into a state
 * file, and then watches that file: playback follows Claude without either side
 * knowing about the other.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type ClaudeState = 'busy' | 'idle';

const claudeDir = path.join(os.homedir(), '.claude');
const settingsFile = path.join(claudeDir, 'settings.json');

export const stateDir = path.join(claudeDir, 'youtube-panel');
export const stateFileName = 'state';
export const stateFile = path.join(stateDir, stateFileName);
export const hookScript = path.join(stateDir, 'youtube-hook.sh');

/** Hooks the extension owns: event name -> state written when the event fires. */
const HOOK_EVENTS: Array<{ event: string; state: ClaudeState }> = [
	{ event: 'UserPromptSubmit', state: 'busy' },
	{ event: 'PreToolUse', state: 'busy' },
	// Fires once the tool actually runs, which is how playback resumes after a
	// permission prompt has been answered.
	{ event: 'PostToolUse', state: 'busy' },
	{ event: 'PermissionRequest', state: 'idle' },
	{ event: 'Notification', state: 'idle' },
	{ event: 'Stop', state: 'idle' },
	{ event: 'SessionEnd', state: 'idle' }
];

// Written through a temporary file so a watcher never reads a half-written state.
const HOOK_SCRIPT_BODY = `#!/bin/sh
# Managed by the YouTube Panel VS Code extension.
dir="$(dirname "$0")"
printf '%s' "$1" > "$dir/${stateFileName}.tmp" && mv "$dir/${stateFileName}.tmp" "$dir/${stateFileName}"
`;

function hookCommand(state: ClaudeState) {
	return `sh "${hookScript}" ${state}`;
}

function isOurHook(entry: any) {
	return Array.isArray(entry?.hooks) &&
		entry.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(hookScript));
}

export function writeHookScript() {
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(hookScript, HOOK_SCRIPT_BODY, { mode: 0o755 });
	if (!fs.existsSync(stateFile)) {
		fs.writeFileSync(stateFile, 'idle');
	}
}

export function readState(): ClaudeState {
	try {
		return fs.readFileSync(stateFile, 'utf8').trim() === 'busy' ? 'busy' : 'idle';
	} catch {
		return 'idle';
	}
}

function readSettings(): any {
	if (!fs.existsSync(settingsFile)) {
		return {};
	}
	return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
}

function writeSettings(settings: any) {
	fs.mkdirSync(claudeDir, { recursive: true });
	fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

export function hooksInstalled(): boolean {
	try {
		const hooks = readSettings().hooks ?? {};
		return HOOK_EVENTS.every(({ event }) => (hooks[event] ?? []).some(isOurHook));
	} catch {
		return false;
	}
}

/** Adds the state-writing hooks to ~/.claude/settings.json, leaving any other hooks intact. */
export function installHooks() {
	writeHookScript();

	const settings = readSettings();
	settings.hooks = settings.hooks ?? {};

	for (const { event, state } of HOOK_EVENTS) {
		const entries: any[] = (settings.hooks[event] ?? []).filter((e: any) => !isOurHook(e));
		entries.push({ hooks: [{ type: 'command', command: hookCommand(state) }] });
		settings.hooks[event] = entries;
	}

	writeSettings(settings);
}

export function uninstallHooks() {
	let settings: any;
	try {
		settings = readSettings();
	} catch {
		return;
	}

	const hooks = settings.hooks;
	if (!hooks) {
		return;
	}

	for (const { event } of HOOK_EVENTS) {
		if (!Array.isArray(hooks[event])) {
			continue;
		}
		const entries = hooks[event].filter((e: any) => !isOurHook(e));
		if (entries.length > 0) {
			hooks[event] = entries;
		} else {
			delete hooks[event];
		}
	}

	writeSettings(settings);
}
