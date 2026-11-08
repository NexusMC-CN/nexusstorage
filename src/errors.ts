export type NexusStorageErrorCode =
  | 'INVALID_VALUE'
  | 'INVALID_OPTIONS'
  | 'INVALID_KEY'
  | 'VALIDATION_ERROR'
  | 'ASYNC_SCHEMA'
  | 'ASYNC_TRANSACTION'
  | 'TRANSACTION_INACTIVE'
  | 'UNSUPPORTED_OPERATION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'TYPE_MISMATCH'
  | 'CORRUPT_DATA'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_ERROR'
  | 'DATABASE_BLOCKED'
  | 'CLOSED';

export class NexusStorageError extends Error {
  readonly code: NexusStorageErrorCode;

  constructor(code: NexusStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NexusStorageError';
    this.code = code;
  }
}
