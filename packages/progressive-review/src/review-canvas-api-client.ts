import {
  type JsonObject,
  type JsonValue,
  type ReviewDesktopDiscovery,
  type ReviewDocumentMutationRequest,
  type ReviewDocumentMutationResponse,
  ReviewDocumentMutationResponseSchema,
  type ReviewDocumentSnapshotResponse,
  ReviewDocumentSnapshotResponseSchema,
  type ReviewThreadsCommand,
  type ReviewThreadsCommandResponse,
  ReviewThreadsCommandResponseSchema,
  type ReviewThreadsSnapshotResponse,
  ReviewThreadsSnapshotResponseSchema,
  isJsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { requireHealthyReviewDesktop } from "./desktop-discovery";

export interface ReviewCanvasApi {
  getDocument(reviewId: string): Promise<ReviewDocumentSnapshotResponse>;
  mutateDocument(
    reviewId: string,
    request: ReviewDocumentMutationRequest,
  ): Promise<ReviewDocumentMutationResponse>;
  getComments(reviewId: string): Promise<ReviewThreadsSnapshotResponse>;
  command(
    reviewId: string,
    command: ReviewThreadsCommand,
  ): Promise<ReviewThreadsCommandResponse>;
  reply(input: {
    reviewId: string;
    threadId: string;
    mutationId: string;
    messageId: string;
    body: string;
    author?: string;
  }): Promise<ReviewThreadsCommandResponse>;
}

export interface ReviewCanvasApiClientOptions {
  discovery?: ReviewDesktopDiscovery;
  fetch?: typeof globalThis.fetch;
}

export class ReviewCanvasApiClient implements ReviewCanvasApi {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: ReviewCanvasApiClientOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async getDocument(reviewId: string): Promise<ReviewDocumentSnapshotResponse> {
    return ReviewDocumentSnapshotResponseSchema.parse(
      await this.request(`/reviews/${encodeURIComponent(reviewId)}/document`),
    );
  }

  async mutateDocument(
    reviewId: string,
    request: ReviewDocumentMutationRequest,
  ): Promise<ReviewDocumentMutationResponse> {
    return ReviewDocumentMutationResponseSchema.parse(
      await this.request(
        `/reviews/${encodeURIComponent(reviewId)}/document/mutations`,
        request,
      ),
    );
  }

  async getComments(reviewId: string): Promise<ReviewThreadsSnapshotResponse> {
    return ReviewThreadsSnapshotResponseSchema.parse(
      await this.request(`/reviews/${encodeURIComponent(reviewId)}/comments`),
    );
  }

  async command(
    reviewId: string,
    command: ReviewThreadsCommand,
  ): Promise<ReviewThreadsCommandResponse> {
    return ReviewThreadsCommandResponseSchema.parse(
      await this.request(
        `/reviews/${encodeURIComponent(reviewId)}/thread-commands`,
        command,
      ),
    );
  }

  async reply(input: {
    reviewId: string;
    threadId: string;
    mutationId: string;
    messageId: string;
    body: string;
    author?: string;
  }): Promise<ReviewThreadsCommandResponse> {
    const body: JsonObject = {
      mutationId: input.mutationId,
      messageId: input.messageId,
      body: input.body,
    };
    if (input.author) body.author = input.author;
    return ReviewThreadsCommandResponseSchema.parse(
      await this.request(
        `/reviews/${encodeURIComponent(input.reviewId)}/comments/${encodeURIComponent(input.threadId)}/replies`,
        body,
      ),
    );
  }

  private async request(
    pathname: string,
    body?: JsonValue,
  ): Promise<JsonValue> {
    const discovery =
      this.options.discovery ??
      (await requireHealthyReviewDesktop("review mcp"));
    let response: Response;
    try {
      const headers = new Headers({
        "x-review-token": discovery.token,
      });
      if (body !== undefined) headers.set("content-type", "application/json");
      response = await this.fetch(`${discovery.url}${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error("Review Desktop API is unavailable.", { cause: error });
    }
    const value = parseJsonText(await response.text());
    if (!response.ok) {
      const detail = isJsonObject(value)
        ? (jsonString(value.error) ??
          `Review Desktop returned ${response.status}.`)
        : `Review Desktop returned ${response.status}.`;
      throw new ReviewCanvasApiError(detail, response.status);
    }
    return value;
  }
}

export class ReviewCanvasApiError extends Error {
  override readonly name = "ReviewCanvasApiError";

  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
