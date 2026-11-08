import { NexusStorage } from '@nexusmc-cn/nexusstorage';
import type { StandardSchemaV1 } from '@nexusmc-cn/nexusstorage';

interface Profile {
  name: string;
  visits: number;
}

// Use any compatible synchronous Standard Schema V1 validator.
const profileSchema: StandardSchemaV1<Profile> = {
  '~standard': {
    version: 1,
    vendor: 'managed-data-example',
    validate(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { issues: [{ message: 'Expected a profile object.' }] };
      }
      const profile = value as Record<string, unknown>;
      if (typeof profile.name !== 'string' || typeof profile.visits !== 'number' ||
          !Number.isInteger(profile.visits) || profile.visits < 0) {
        return { issues: [{ message: 'Expected a name and a nonnegative visit count.' }] };
      }
      return { value: { name: profile.name.trim(), visits: profile.visits } };
    },
  },
};

const countSchema: StandardSchemaV1<string | number, number> = {
  '~standard': {
    version: 1,
    vendor: 'managed-data-example',
    validate(value) {
      const count = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
      return Number.isFinite(count)
        ? { value: count }
        : { issues: [{ message: 'Expected a finite number or numeric string.' }] };
    },
  },
};

// In SSR, create this instance for each request and close it when the request ends.
// Memory remains private to this instance, even if another instance uses the same namespace.
const storage = new NexusStorage({
  driver: 'memory',
  namespace: 'managed-data',
  schemas: { profile: profileSchema, count: countSchema },
});

try {
  const profile = await storage.set('profile', { name: ' Alex ', visits: 1 }, { ttl: 60_000 });
  console.log(profile); // { name: 'Alex', visits: 1 }

  const updated = await storage.update('profile', { visits: 2 }); // Preserves the expiry.
  console.log(updated.visits); // 2; the full Profile is inferred.

  await storage.update('profile', { visits: 3 }, { expiresAt: Date.now() + 120_000 });
  const count = await storage.set('count', '42'); // Input: string | number; output: number.
  console.log(count, await storage.get('count')); // 42, 42; rereading the output is stable.

  await storage.set('profile', { name: 'Sam', visits: 4 }); // Replaces the value and removes expiry.
  console.log(await storage.keys()); // ['count', 'profile']

  // storage.set('count', false);           // Type error: invalid schema input.
  // storage.update('profile', { visits: '5' }); // Type error: invalid output patch.
  // storage.get('unknown');               // Type error: undeclared key.
} finally {
  await storage.close();
}
