/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';

import type { IHoverOptions } from '../../base/browser/ui/hover/hover.js';

// jsdom ships no types here; the DOM globals below are all this test reads from it.
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const dom = new JSDOM('<html><body></body></html>');
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'MutationObserver', 'Element', 'navigator', 'customElements', 'UIEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent'] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } }) as never;
registerHooks({ load(url, context, next) {
	return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { ReviewTooltip, ReviewViewedCheckbox } = await import('./reviewTooltip.js');

function hoverService() {
	const shown: IHoverOptions[] = [];
	let visible = 0;
	return {
		shown,
		visible: () => visible,
		service: {
			showInstantHover(options: IHoverOptions) {
				shown.push(options);
				visible++;
				return { dispose: () => { visible--; } } as never;
			},
		},
	};
}

test('the tooltip shows the moment the pointer lands and goes on click', () => {
	const hovers = hoverService();
	const target = document.createElement('span');
	document.body.append(target);
	const tooltip = new ReviewTooltip(hovers.service, target, { label: '+4 −1 remaining', detail: 'of +9 −2 total' });

	target.dispatchEvent(new MouseEvent('mouseenter'));
	assert.equal(hovers.visible(), 1);
	assert.equal((hovers.shown[0].content as HTMLElement).textContent, '+4 −1 remaining' + 'of +9 −2 total');

	target.dispatchEvent(new MouseEvent('click'));
	assert.equal(hovers.visible(), 0);
	tooltip.dispose();
	target.remove();
});

test('the viewed box toggles without collapsing the header it sits in', () => {
	const hovers = hoverService();
	const header = document.createElement('div');
	let collapsed = 0;
	let toggled = 0;
	header.addEventListener('click', () => collapsed++);
	const box = new ReviewViewedCheckbox(hovers.service, document, () => toggled++);
	header.append(box.element);

	box.update('partial', 'src/a.ts', false);
	assert.equal(box.element.getAttribute('aria-checked'), 'mixed');
	box.element.click();
	assert.equal(toggled, 1);
	assert.equal(collapsed, 0);
	box.dispose();
});

test('a viewed box with nothing to view is disabled and offers no tooltip', () => {
	const hovers = hoverService();
	const box = new ReviewViewedCheckbox(hovers.service, document, () => { });
	box.update(undefined, 'src/a.ts', true);
	assert.ok(box.element.disabled);
	box.element.dispatchEvent(new MouseEvent('mouseenter'));
	assert.equal(hovers.visible(), 0);
	box.dispose();
});
