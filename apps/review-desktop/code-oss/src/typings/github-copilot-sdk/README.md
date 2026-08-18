# Type-only SDK declarations

These MIT-licensed declaration files come from
`@github/copilot-sdk@1.0.7-preview.0` (npm integrity
`sha512-qffczR5m1IbywMjh3EA9Qaz5GiSALMbI4v88cC4umymkeToTpYkNd/Sz4YcQqEVUYUuvtWJVhXUue/mWBNnJqw==`).

Review Desktop does not install or ship that SDK or its CLI runtime. The
upstream Code OSS source tree still contains dormant agent-host files that
import the SDK, and the all-source compile needs their type surface. Mapping
the module to these declarations preserves that compile coverage without
putting the functional packages back into `package.json`, `package-lock.json`,
or the product payload.
