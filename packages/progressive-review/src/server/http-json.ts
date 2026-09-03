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
