import {
  type CodePeekProps,
  createWhiteboardDefinitionSession,
} from "../../src/authoring";
import { defineSoftwareModel } from "./software-map/model";

export function createTestWhiteboardDefinitionSession(
  options: {
    softwareMap?: ReturnType<typeof defineSoftwareModel>;
    validateCodePeek?: (props: CodePeekProps) => Promise<void>;
  } = {},
) {
  const softwareMap =
    options.softwareMap ?? defineSoftwareModel({ systems: {} });

  return createWhiteboardDefinitionSession({
    softwareMap,
    baseSoftwareMap: softwareMap,
    validateCodePeek: options.validateCodePeek ?? (async () => {}),
  });
}
