import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const reviewId = process.argv[2] ?? "cc2fa95d-112e-4d91-b4e0-b12528b438f8";
const marker = process.argv[3] ?? "A";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--import",
    "tsx",
    new URL("../src/cli.ts", import.meta.url).pathname,
    "mcp",
  ],
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  cwd: process.cwd(),
  stderr: "inherit",
});
const client = new Client({ name: "tanstack-tracer", version: "0.0.1" });

await client.connect(transport);
try {
  const result = await client.callTool({
    name: "execute",
    arguments: {
      code: `
await review.openReview({ reviewId: ${JSON.stringify(reviewId)} });
const info = await review.getBasicInfo();
const result = await review.renderMdx({
  targetNodeId: info.rootNodeId,
  mode: "append",
  title: ${JSON.stringify(`Local state tracer ${marker}`)},
  mdx: ${JSON.stringify(`## Local state tracer ${marker}

This section was appended through the code-mode MCP while the Review was open.

<SequenceDiagram
  label="SQLite commit reaches TanStack Query ${marker}"
  messages={[
    {
      from: { label: "Agent / MCP" },
      to: { label: "ReviewStateService" },
      label: "validate and commit changed nodes",
      code: "review.renderMdx(...)"
    },
    {
      from: { label: "ReviewStateService" },
      to: { label: "TanStack Query" },
      label: "push typed document patch",
      code: "queryClient.setQueryData(...)"
    },
    {
      from: { label: "TanStack Query" },
      to: { label: "React UI" },
      label: "rerender changed identities",
      code: "createLiveReviewDocument(state.page)"
    },
  ]}
/>
`)}
});
return { info, result };
`,
    },
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
