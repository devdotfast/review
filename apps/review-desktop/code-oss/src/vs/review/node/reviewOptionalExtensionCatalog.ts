/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// This module is imported by src/main.ts before bootstrapESM() installs the NLS
// table. Keep it free of workbench registries, configuration, and localization.

export const reviewOptionalExtensionCatalog = [
	{
		id: 'rust-lang.rust-analyzer',
		role: 'primary',
		group: 'rust',
		version: '0.4.2990',
		targets: {
			'darwin-arm64': {
				url: 'https://open-vsx.org/api/rust-lang/rust-analyzer/darwin-arm64/0.4.2990/file/rust-lang.rust-analyzer-0.4.2990@darwin-arm64.vsix',
				sha256: 'e068ebb88f705491856b91cdbf8b7ead40c22d50f2c24df70e345c889c2b0111',
				size: 15445156
			},
			'linux-x64': {
				url: 'https://open-vsx.org/api/rust-lang/rust-analyzer/linux-x64/0.4.2990/file/rust-lang.rust-analyzer-0.4.2990@linux-x64.vsix',
				sha256: '317cb128e8caf2495b955ef6612d828fef809187ac445242116ad8e2e32382ff',
				size: 16313907
			}
		}
	},
	{
		id: 'swiftlang.swift-vscode',
		role: 'primary',
		group: 'swift',
		version: '2.17.20260702',
		targets: {
			universal: {
				url: 'https://open-vsx.org/api/swiftlang/swift-vscode/2.17.20260702/file/swiftlang.swift-vscode-2.17.20260702.vsix',
				sha256: '64fcca2666e033c3934ceeb98b13ff73e30071d32e0795bec891652814ef947b',
				size: 14779649
			}
		}
	},
	{
		id: 'llvm-vs-code-extensions.lldb-dap',
		role: 'support',
		group: 'swift',
		version: '0.7.20260804',
		targets: {
			universal: {
				url: 'https://open-vsx.org/api/llvm-vs-code-extensions/lldb-dap/0.7.20260804/file/llvm-vs-code-extensions.lldb-dap-0.7.20260804.vsix',
				sha256: '69dad4f902a1a9d96403205e209a9aef760189c93d687e02f568a753148c537f',
				size: 819802
			}
		}
	},
	{
		id: 'muhammad-sammy.csharp',
		role: 'primary',
		group: 'csharp',
		version: '2.145.21-g154a82fd27',
		targets: {
			'darwin-arm64': {
				url: 'https://open-vsx.org/api/muhammad-sammy/csharp/darwin-arm64/2.145.21-g154a82fd27/file/muhammad-sammy.csharp-2.145.21-g154a82fd27@darwin-arm64.vsix',
				sha256: '93f61e8b6938cbe8ecda8768bfaf08abed9789db9461177d3d0ab59ccda2528d',
				size: 75096042
			},
			'linux-x64': {
				url: 'https://open-vsx.org/api/muhammad-sammy/csharp/linux-x64/2.145.21-g154a82fd27/file/muhammad-sammy.csharp-2.145.21-g154a82fd27@linux-x64.vsix',
				sha256: '78bc006683cc998e9fd1a6f2760d8cb3da63096464a217bbd192ecfb490a5516',
				size: 78144854
			}
		}
	},
	{
		id: 'ms-dotnettools.vscode-dotnet-runtime',
		role: 'support',
		group: 'csharp',
		version: '3.1.0',
		targets: {
			universal: {
				url: 'https://open-vsx.org/api/ms-dotnettools/vscode-dotnet-runtime/3.1.0/file/ms-dotnettools.vscode-dotnet-runtime-3.1.0.vsix',
				sha256: '10fd1e1693a81e2c68f0382ae3cfcf0784c5f3e0da002dd4bfd322575b46941e',
				size: 1458566
			}
		}
	}
] as const;

export type ReviewOptionalExtension = (typeof reviewOptionalExtensionCatalog)[number];
export type ReviewOptionalExtensionTarget = keyof ReviewOptionalExtension['targets'];
