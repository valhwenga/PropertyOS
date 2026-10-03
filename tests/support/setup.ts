import { afterAll } from 'vitest';
import { closeConnections } from '@propertyos/db';

afterAll(async () => {
  await closeConnections();
});
