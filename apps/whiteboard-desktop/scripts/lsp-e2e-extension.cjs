// Loaded only by lsp-e2e.mjs into its disposable extension host.
const vscode = require("vscode");

const fs = require("node:fs/promises");

const path = require("node:path");

exports.activate = function (context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("review.lspE2E", async () => {
      const root = process.env.WHITEBOARD_LSP_E2E_ROOT;

      const request = JSON.parse(
        await fs.readFile(path.join(root, "request.json"), "utf8"),
      );

      let response;
      let delayedProvider;

      try {
        const uri = request.uri && vscode.Uri.parse(request.uri);

        const position = new vscode.Position(
          request.line ?? 0,
          request.character ?? 0,
        );

        if (request.open) {
          const document = await vscode.workspace.openTextDocument(uri);

          const editor = await vscode.window.showTextDocument(document, {
            preview: false,
          });

          editor.selection = new vscode.Selection(position, position);
        }

        if (request.diff) {
          await vscode.commands.executeCommand(
            "vscode.diff",
            vscode.Uri.parse(request.diff.base),
            vscode.Uri.parse(request.diff.head),
            "Pinned source diff",
          );
        }

        let result;

        if (request.delayedHover) {
          delayedProvider = vscode.languages.registerHoverProvider(
            { scheme: "file", pattern: "**/main.ts" },
            {
              async provideHover() {
                await fs.writeFile(
                  path.join(root, "provider-started"),
                  "ready",
                );
                const deadline = Date.now() + 20000;

                while (Date.now() < deadline) {
                  try {
                    await fs.access(path.join(root, "provider-release"));
                    break;
                  } catch {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                  }
                }

                return new vscode.Hover(
                  "delayed old environment",
                  new vscode.Range(position, position.translate(0, 1)),
                );
              },
            },
          );
        }

        if (request.feature) {
          result = (
            await Promise.all(
              Array.from({ length: request.repeat ?? 1 }, () =>
                vscode.commands.executeCommand(request.feature, uri, position),
              ),
            )
          ).flat();

          if (request.feature === "vscode.executeHoverProvider") {
            result = (result ?? []).map((hover) => ({
              contents: hover.contents.map((content) => content.value),
              range: hover.range,
            }));
          } else {
            result = (result ?? []).map((location) => ({
              uri: (location.targetUri ?? location.uri).toString(),
              range: {
                start: (location.targetSelectionRange ?? location.range).start,
                end: (location.targetSelectionRange ?? location.range).end,
              },
            }));
          }
        }

        if (request.edit) {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            vscode.Uri.parse(request.edit.uri),
            new vscode.Position(0, 0),
            request.edit.text,
          );
          result = await vscode.workspace.applyEdit(edit);
        }

        if (request.command)
          await vscode.commands.executeCommand(
            request.command,
            ...(request.args ?? []),
          );
        const active = vscode.window.activeTextEditor;
        response = {
          result,
          active: active && {
            uri: active.document.uri.toString(),
            text: active.document.getText(),
            dirty: active.document.isDirty,
            line: active.selection.active.line,
            character: active.selection.active.character,
          },
          roots: (vscode.workspace.workspaceFolders ?? []).map((folder) =>
            folder.uri.toString(),
          ),
          extensions: vscode.extensions.all
            .filter((extension) =>
              /typescript-language|astral-sh.ty|ms-python.python/.test(
                extension.id,
              ),
            )
            .map((extension) => ({
              id: extension.id,
              active: extension.isActive,
            })),
        };
      } catch (error) {
        response = { error: String(error?.stack ?? error) };
      } finally {
        delayedProvider?.dispose();
      }

      await fs.writeFile(
        path.join(root, `${request.id}.json`),
        JSON.stringify(response),
      );
    }),
  );
};
