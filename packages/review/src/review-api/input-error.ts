/** Deliberately safe to show to API clients, unlike filesystem/provider errors. */
export class SessionInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
