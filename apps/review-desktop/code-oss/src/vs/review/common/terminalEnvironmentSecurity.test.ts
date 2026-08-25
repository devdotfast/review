/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeNonWindowsPath } from '../../platform/terminal/common/terminalEnvironment.js';
import { GeneralShellType, PosixShellType } from '../../platform/terminal/common/terminal.js';

test('quotes hostile POSIX paths as one shell word', () => {
	const hostilePath = "/tmp/a'file\nprintf CODEQL_RELEVANT\n'$HOME\\tail";
	assert.equal(
		escapeNonWindowsPath(hostilePath, PosixShellType.Bash),
		"'/tmp/a'\\''file\nprintf CODEQL_RELEVANT\n'\\''$HOME\\tail'",
	);
	assert.equal(
		escapeNonWindowsPath('/tmp/`$|&;<>#*!^~', PosixShellType.Zsh),
		"'/tmp/`$|&;<>#*!^~'",
	);
});

test('uses the native quoting rules for Fish and PowerShell', () => {
	assert.equal(escapeNonWindowsPath("a\\b'c", PosixShellType.Fish), "'a\\\\b\\'c'");
	assert.equal(escapeNonWindowsPath("a'b", GeneralShellType.PowerShell), "'a''b'");
});
