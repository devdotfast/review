/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { registerColor } from '../../platform/theme/common/colorRegistry.js';

function registerReviewMapColor(id: string, dark: string, light: string, description: string, needsTransparency = false): void {
	registerColor(id, { dark, light, hcDark: dark, hcLight: light }, description, needsTransparency);
}

registerReviewMapColor('review.map.canvas', '#08080D', '#FFFFFF', localize('review.map.canvas', "Background color for the Review map canvas."));
registerReviewMapColor('review.map.panel1', '#0F1119', '#F4F4F8', localize('review.map.panel1', "Primary panel color for the Review map."));
registerReviewMapColor('review.map.panel2', '#14161F', '#ECEDF3', localize('review.map.panel2', "Secondary panel color for the Review map."));
registerReviewMapColor('review.map.card', '#0B0C12', '#FFFFFF', localize('review.map.card', "Card background color for the Review map."));
registerReviewMapColor('review.map.line1', '#1E2130', '#E2E3EC', localize('review.map.line1', "Primary line color for the Review map."));
registerReviewMapColor('review.map.line2', '#262A3B', '#DEE0EA', localize('review.map.line2', "Secondary line color for the Review map."));
registerReviewMapColor('review.map.cardLine', '#262A3B', '#E2E3EC', localize('review.map.cardLine', "Card border color for the Review map."));
registerReviewMapColor('review.map.edge', '#3D4256', '#AFB3C2', localize('review.map.edge', "Edge color for the Review map."));
registerReviewMapColor('review.map.chip', '#10121A', '#FFFFFF', localize('review.map.chip', "Chip background color for the Review map."));
registerReviewMapColor('review.map.activeFill', '#4D6EF514', '#F8F9FD', localize('review.map.activeFill', "Active fill color for the Review map."), true);
registerReviewMapColor('review.map.changed', '#F5C97C', '#C89544', localize('review.map.changed', "Changed-state color for the Review map."));
registerReviewMapColor('review.map.added', '#6FC7A8', '#149E62', localize('review.map.added', "Added-state color for the Review map."));
registerReviewMapColor('review.map.removed', '#F58A7C', '#CF5D4C', localize('review.map.removed', "Removed-state color for the Review map."));
registerReviewMapColor('review.map.diffPositive', '#6FC7A8', '#149E62', localize('review.map.diffPositive', "Positive diff color for the Review map."));
registerReviewMapColor('review.map.diffNegative', '#F58A7C', '#CF5D4C', localize('review.map.diffNegative', "Negative diff color for the Review map."));
registerReviewMapColor('review.map.badgeBg', '#FFFFFF0A', '#171B190D', localize('review.map.badgeBg', "Badge background color for the Review map."), true);
