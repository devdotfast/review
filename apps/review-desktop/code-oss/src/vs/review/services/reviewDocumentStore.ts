/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import type {
	ReviewDocumentNode,
	ReviewDocumentSnapshot,
	ReviewDocumentStoreBridge,
} from "../common/reviewProtocol.js";

/** Host-owned external store consumed by the Review canvas. */
export class ReviewDocumentStore
	extends Disposable
	implements ReviewDocumentStoreBridge
{
	private readonly _onDidChange = this._register(new Emitter<void>());

	constructor(private snapshot: ReviewDocumentSnapshot) {
		super();
	}

	getSnapshot(): ReviewDocumentSnapshot {
		return this.snapshot;
	}

	subscribe(listener: () => void) {
		return this._onDidChange.event(listener);
	}

	replace(snapshot: ReviewDocumentSnapshot): void {
		if (
			snapshot.routePath !== this.snapshot.routePath ||
			snapshot.revision <= this.snapshot.revision
		) {
			return;
		}
		const previousNodes = new Map(
			(this.snapshot.nodes ?? []).map((node) => [node.id, node]),
		);
		this.snapshot = snapshot.nodes
			? {
					...snapshot,
					nodes: snapshot.nodes.map((node) => {
						const previous = previousNodes.get(node.id);
						return previous && sameReviewDocumentNode(previous, node)
							? previous
							: node;
					}),
				}
			: snapshot;
		this._onDidChange.fire();
	}
}

function sameReviewDocumentNode(
	left: ReviewDocumentNode,
	right: ReviewDocumentNode,
): boolean {
	return (
		left.id === right.id &&
		left.kind === right.kind &&
		left.content === right.content &&
		left.title === right.title &&
		left.tone === right.tone &&
		left.language === right.language
	);
}
