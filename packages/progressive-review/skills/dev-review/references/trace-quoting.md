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

Array order determines event order; the host assigns consecutive ordinals. `at` is optional and should be supplied only when the original time is known. Quotes must match within an event after whitespace normalization. Preserve wording; put explanations and corrections in separate prose. Every event is marked `client_supplied`: validation does not independently authenticate its origin.

The host stores the events and serves them through `trace.get`. A viewer does not need the original transcript file, a session export tool, or access to the author's machine. Existing optional trace capture/search utilities are separate features, not prerequisites for JSON authoring.
