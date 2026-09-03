# `@dev.fast/trace-shared`

This package defines the public contract between the Review CLI and the hosted
trace store. It exports the schemas, size limits, device paths, route builders,
and server route matchers that both sides use.

The server and CLI must use the same exact version. For each contract release,
bump the package version in the change pull request. After that pull request
merges, build and test the merge commit, publish it to npm, and tag that commit
as `trace-shared-v<version>`.

Install the public package without registry-specific authentication:

```sh
npm install @dev.fast/trace-shared@0.1.0
```
