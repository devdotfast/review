import { EditorInputCapabilities } from "../../workbench/common/editor.js";
import { TextResourceEditorInput } from "../../workbench/common/editor/textResourceEditorInput.js";

/** Virtual review buffers cannot delegate Save or Save As to a workspace file. */
export class ReviewSourceEditorInput extends TextResourceEditorInput {
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.CanSplitInGroup;
	}
	override async save(): Promise<undefined> { return undefined; }
	override async saveAs(): Promise<undefined> { return undefined; }
	override async revert(): Promise<void> { }
}
