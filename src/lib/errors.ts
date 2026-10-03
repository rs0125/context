export class HttpError extends Error {
  readonly retryAfterSeconds?: number;
  constructor(public status: number, public code: string, message: string, options: { retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = 'HttpError';
    const delay = options.retryAfterSeconds;
    if (Number.isInteger(delay) && delay! >= 1 && delay! <= 86400) this.retryAfterSeconds = delay;
  }
}
