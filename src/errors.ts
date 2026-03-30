export class CloxyHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly type: string = "invalid_request_error"
  ) {
    super(message);
    this.name = "CloxyHttpError";
  }
}

export class UnsupportedFeatureError extends CloxyHttpError {
  constructor(message: string) {
    super(message, 400, "unsupported_feature");
  }
}

export class PayloadTooLargeError extends CloxyHttpError {
  constructor(message: string) {
    super(message, 413, "payload_too_large");
  }
}

export function isCloxyHttpError(error: unknown): error is CloxyHttpError {
  return error instanceof CloxyHttpError;
}
