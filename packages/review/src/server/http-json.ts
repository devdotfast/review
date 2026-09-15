export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

export class HttpJsonError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413 | 415,
  ) {
    super(message);
    this.name = "HttpJsonError";
  }
}

/** An error whose status and machine code the JSON routes hand straight back. */
export class ReviewServerError extends Error {
  override readonly name = "ReviewServerError";

  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
