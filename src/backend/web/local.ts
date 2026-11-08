import { WebStorageBackend } from './index.js';

export class LocalStorageBackend extends WebStorageBackend {
  constructor(namespace: string) {
    super(namespace, 'localStorage');
  }
}
