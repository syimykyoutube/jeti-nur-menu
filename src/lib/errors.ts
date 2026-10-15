export class AppError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 413 | 415 | 409 | 429 | 503, public key: string) {
    super(key);
  }
}
