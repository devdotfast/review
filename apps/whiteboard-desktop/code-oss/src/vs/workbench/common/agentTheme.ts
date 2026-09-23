/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { registerColor, transparent } from '../../platform/theme/common/colorUtils.js';
import { contrastBorder, focusBorder } from '../../platform/theme/common/colorRegistry.js';
import { editorBackground } from '../../platform/theme/common/colors/editorColors.js';
import { foreground } from '../../platform/theme/common/colors/baseColors.js';
import { buttonBackground, inputBackground, inputBorder, inputForeground, inputPlaceholderForeground } from '../../platform/theme/common/colors/inputColors.js';
import { SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND } from './theme.js';

// Shared tokens still used by the desktop shell and chat surfaces.
export const agentsBackground = registerColor(
	'agents.background',
	{ dark: editorBackground, light: SIDE_BAR_BACKGROUND, hcDark: editorBackground, hcLight: editorBackground },
	localize('agents.background', 'Background color of the agent shell and gradient base.')
);

export const agentsPanelBackground = registerColor(
	'agentsPanel.background',
	{ dark: SIDE_BAR_BACKGROUND, light: editorBackground, hcDark: SIDE_BAR_BACKGROUND, hcLight: SIDE_BAR_BACKGROUND },
	localize('agentsPanel.background', 'Background color of agent panels.')
);

export const agentsPanelForeground = registerColor(
	'agentsPanel.foreground', SIDE_BAR_FOREGROUND,
	localize('agentsPanel.foreground', 'Foreground color of agent panels.')
);

export const agentsPanelBorder = registerColor(
	'agentsPanel.border',
	{ dark: transparent(foreground, 0.15), light: transparent(foreground, 0.15), hcDark: contrastBorder, hcLight: contrastBorder },
	localize('agentsPanel.border', 'Border color of agent panels.')
);

export const agentsGradientTintColor = registerColor(
	'agentsGradient.tintColor', buttonBackground,
	localize('agentsGradient.tintColor', 'Tint color for the agent shell background gradient.')
);

export const agentsChatInputBackground = registerColor(
	'agentsChatInput.background', inputBackground,
	localize('agentsChatInput.background', 'Background color of the agent chat input field.')
);

export const agentsChatInputForeground = registerColor(
	'agentsChatInput.foreground', inputForeground,
	localize('agentsChatInput.foreground', 'Foreground color of the agent chat input field.')
);

export const agentsChatInputBorder = registerColor(
	'agentsChatInput.border', inputBorder,
	localize('agentsChatInput.border', 'Border color of the agent chat input field.')
);

export const agentsChatInputFocusBorder = registerColor(
	'agentsChatInput.focusBorder', focusBorder,
	localize('agentsChatInput.focusBorder', 'Border color of the focused agent chat input field.')
);

export const agentsChatInputPlaceholderForeground = registerColor(
	'agentsChatInput.placeholderForeground', inputPlaceholderForeground,
	localize('agentsChatInput.placeholderForeground', 'Placeholder color of the agent chat input field.')
);
