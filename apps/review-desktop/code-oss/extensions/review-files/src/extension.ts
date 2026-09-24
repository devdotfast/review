/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

// A source window's folder is the Review's head checkout, and the
// `reviewFiles.base` setting names its base checkout. This view lists every
// file on either side in one tree and marks what changed. Opening any file
// shows it as an inline diff against the base; the workbench does that for
// every file open, so the tree only opens the file itself.

type Status = 'A' | 'M' | 'D';

interface Entry {
	readonly name: string;
	/** Slash-separated path relative to both checkouts. */
	readonly path: string;
	readonly parent: Entry | undefined;
	readonly children?: Map<string, Entry>;
	/** Where the entry exists: head unless it was deleted. */
	uri: vscode.Uri;
	status?: Status;
}

const statusLabels: Record<Status, string> = { A: 'Added', M: 'Modified', D: 'Deleted' };

const statusColors: Record<Status, vscode.ThemeColor> = {
	A: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	M: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
	D: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
};

const run = promisify(execFile);

async function git(cwd: vscode.Uri, args: string[]): Promise<string[]> {
	const { stdout } = await run('git', ['-C', cwd.fsPath, ...args], { maxBuffer: 256 * 1024 * 1024 });
	return stdout.split('\0').filter(Boolean);
}

class ReviewFiles implements vscode.TreeDataProvider<Entry>, vscode.FileDecorationProvider {

	private root: Entry;
	private readonly entries = new Map<string, Entry>();
	private readonly decorations = new Map<string, vscode.FileDecoration>();

	private readonly treeChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.treeChanged.event;
	private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this.decorationsChanged.event;

	constructor(
		private readonly head: vscode.Uri,
		private readonly base: vscode.Uri | undefined,
		private readonly untracked: boolean,
	) {
		this.root = this.folder('', undefined, head);
	}

	/** List both checkouts with Git, so ignored files such as prepared dependencies stay out. */
	async load(): Promise<void> {
		const [headFiles, missing, baseFiles, changed] = await Promise.all([
			git(this.head, ['ls-files', '-z', '--cached', ...(this.untracked ? ['--others', '--exclude-standard'] : [])]),
			this.untracked ? git(this.head, ['ls-files', '-z', '--deleted']) : [],
			this.base ? git(this.base, ['ls-files', '-z', '--cached']) : [],
			this.base ? this.changedFiles(this.base) : [],
		]);

		const inHead = new Set(headFiles);
		for (const file of missing) {
			inHead.delete(file);
		}
		const inBase = new Set(baseFiles);
		const modified = new Set(changed);

		this.root = this.folder('', undefined, this.head);
		this.entries.clear();
		this.decorations.clear();
		for (const file of new Set([...inHead, ...inBase])) {
			const status: Status | undefined = !inBase.has(file) ? 'A' : !inHead.has(file) ? 'D' : modified.has(file) ? 'M' : undefined;
			this.add(file, inHead.has(file), status);
		}
		for (const entry of this.entries.values()) {
			if (!entry.status) {
				continue;
			}
			this.decorations.set(entry.uri.toString(), { badge: entry.status, color: statusColors[entry.status], tooltip: statusLabels[entry.status] });
			for (let folder = entry.parent; folder && folder !== this.root; folder = folder.parent) {
				this.decorations.set(folder.uri.toString(), { color: statusColors.M, tooltip: 'Contains changes' });
			}
		}
		this.treeChanged.fire();
		this.decorationsChanged.fire(undefined);
	}

	/** Tracked files whose head content differs from the base commit, including a live checkout's edits. */
	private async changedFiles(base: vscode.Uri): Promise<string[]> {
		const [commit] = await git(base, ['rev-parse', 'HEAD']);
		return git(this.head, ['diff', '--name-only', '-z', '--no-renames', commit.trim()]);
	}

	private add(file: string, inHead: boolean, status: Status | undefined): void {
		const parts = file.split('/');
		let parent = this.root;
		for (const [index, name] of parts.entries()) {
			const path = parts.slice(0, index + 1).join('/');
			const last = index === parts.length - 1;
			const side = inHead || !this.base ? this.head : this.base;
			let entry = parent.children!.get(name);
			if (!entry) {
				entry = last
					? { name, path, parent, uri: vscode.Uri.joinPath(side, path) }
					: this.folder(path, parent, side);
				parent.children!.set(name, entry);
				this.entries.set(path, entry);
			} else if (inHead && entry.uri.fsPath !== vscode.Uri.joinPath(this.head, path).fsPath) {
				// A folder first seen through a deleted file also holds head files.
				entry.uri = vscode.Uri.joinPath(this.head, path);
			}
			parent = entry;
		}
		parent.status = status;
	}

	private folder(path: string, parent: Entry | undefined, side: vscode.Uri): Entry {
		return { name: path.split('/').pop()!, path, parent, children: new Map(), uri: vscode.Uri.joinPath(side, path) };
	}

	/** The entry for a file open in an editor, from either checkout. */
	find(uri: vscode.Uri): Entry | undefined {
		for (const root of [this.head, this.base]) {
			if (root && uri.scheme === 'file' && uri.fsPath.startsWith(root.fsPath + '/')) {
				return this.entries.get(uri.fsPath.slice(root.fsPath.length + 1));
			}
		}
		return undefined;
	}

	getTreeItem(entry: Entry): vscode.TreeItem {
		const item = new vscode.TreeItem(entry.uri, entry.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		item.id = entry.path;
		const label = entry.status ? `${entry.path}, ${statusLabels[entry.status]}` : entry.path;
		item.tooltip = label;
		item.accessibilityInformation = { label };
		if (!entry.children) {
			item.command = { command: 'vscode.open', title: 'Open', arguments: [entry.uri] };
		}
		return item;
	}

	getChildren(entry?: Entry): Entry[] {
		const children = [...(entry ?? this.root).children?.values() ?? []];
		return children.sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
	}

	getParent(entry: Entry): Entry | undefined {
		return entry.parent === this.root ? undefined : entry.parent;
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		return this.decorations.get(uri.toString());
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const configuration = vscode.workspace.getConfiguration('reviewFiles');
	// Only a source window's workspace names a base; the setting defaults to empty elsewhere.
	const base = configuration.inspect<string>('base')?.workspaceValue;
	const head = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (typeof base !== 'string' || head?.scheme !== 'file') {
		return;
	}

	const untracked = configuration.get<boolean>('untracked', false);
	const files = new ReviewFiles(head, base ? vscode.Uri.file(base) : undefined, untracked);
	const view = vscode.window.createTreeView('reviewFiles.tree', { treeDataProvider: files, showCollapseAll: true });

	const load = async () => {
		try {
			await files.load();
			view.message = undefined;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			view.message = `Could not list the source files: ${detail.split('\n')[0]}`;
		}
	};

	// Keep the open file selected in the tree, as the Explorer does.
	const reveal = (editor: vscode.TextEditor | undefined) => {
		const entry = editor && files.find(editor.document.uri);
		if (entry && view.visible) {
			view.reveal(entry, { select: true, focus: false, expand: true }).then(undefined, () => undefined);
		}
	};

	context.subscriptions.push(
		view,
		vscode.window.registerFileDecorationProvider(files),
		vscode.commands.registerCommand('reviewFiles.refresh', load),
		vscode.window.onDidChangeActiveTextEditor(reveal),
		view.onDidChangeVisibility(() => reveal(vscode.window.activeTextEditor)),
	);

	// A live Review's folder is the user's checkout, which keeps changing.
	if (untracked) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			clearTimeout(timer);
			timer = setTimeout(load, 1000);
		};
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(head, '**'));
		context.subscriptions.push(watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule), { dispose: () => clearTimeout(timer) });
	}

	void vscode.commands.executeCommand('setContext', 'reviewFiles.enabled', true);
	void load().then(() => reveal(vscode.window.activeTextEditor));
}
