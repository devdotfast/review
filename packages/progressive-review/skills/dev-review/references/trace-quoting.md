# Retained trace excerpts

A trace quote is optional evidence, not a dependency on the author's session. Ingest only the relevant material supplied or authorized for this task. Never copy a full private transcript just to make Ask work.

Read enough surrounding context to understand requirements, accepted decisions and later reversals. Prefer short user quotations for intent. Do not present an earlier reversed decision as the final design.

## Ingest, then reference

Call `trace.ingest` with a review ID, descriptive label and bounded events:

```json
{
  "reviewId": "<review UUID>",
  "label": "Requirements discussion",
  "events": [{
    "id": "<event UUID>",
    "ordinal": 0,
    "at": "2026-09-10T12:00:00Z",
    "kind": "user",
    "text": "Keep the document available when source is offline."
  }]
}
```

Use the returned trace ID in a `trace_quote` node:

```json
{
  "id": "offline-requirement",
  "type": "trace_quote",
  "traceId": "<returned trace UUID>",
  "eventId": "<event UUID>",
  "text": "Keep the document available when source is offline."
}
```

The quote must match retained text from that event. Preserve wording; place explanations and corrections in separate prose. Every event is marked `client_supplied`: validating a quote against uploaded material does not independently authenticate its origin.

The host stores the events and serves them through `trace.get`. A viewer does not need the original transcript file, a session export tool, or access to the author's machine. Existing optional trace capture/search utilities are separate features, not prerequisites for JSON authoring.
