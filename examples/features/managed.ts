import { NexusStorage } from '@nexusmc-cn/nexusstorage';
import type { StandardSchemaV1 } from '@nexusmc-cn/nexusstorage';

interface Profile {
  name: string;
  visits: number;
  settings: { theme: string; language?: string };
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
          !Number.isInteger(profile.visits) || profile.visits < 0 ||
          typeof profile.settings !== 'object' || profile.settings === null || Array.isArray(profile.settings)) {
        return { issues: [{ message: 'Expected a name and a nonnegative visit count.' }] };
      }
      const settings = profile.settings as Record<string, unknown>;
      if (typeof settings.theme !== 'string' ||
          (settings.language !== undefined && typeof settings.language !== 'string')) {
        return { issues: [{ message: 'Expected a theme and optional language.' }] };
      }
      return { value: { name: profile.name.trim(), visits: profile.visits,
        settings: settings.language === undefined ? { theme: settings.theme }
          : { theme: settings.theme, language: settings.language } } };
    },
  },
};

// This input validator accepts only strings, while stored values are numbers.
const countSchema: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'managed-data-example',
    validate(value) {
      const count = typeof value === 'string' ? Number(value) : NaN;
      return Number.isFinite(count)
        ? { value: count }
        : { issues: [{ message: 'Expected a numeric string.' }] };
    },
  },
};

// Stored validation must preserve the JSON value; it never trims or reconverts.
const storedProfileSchema: StandardSchemaV1<Profile> = {
  '~standard': {
    version: 1,
    vendor: 'managed-data-example',
    validate(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { issues: [{ message: 'Expected a stored profile.' }] };
      }
      const profile = value as Record<string, unknown>;
      if (typeof profile.name !== 'string' || profile.name !== profile.name.trim() ||
          typeof profile.visits !== 'number' || !Number.isInteger(profile.visits) || profile.visits < 0 ||
          typeof profile.settings !== 'object' || profile.settings === null || Array.isArray(profile.settings)) {
        return { issues: [{ message: 'Expected stored fields, including an already trimmed name.' }] };
      }
      const settings = profile.settings as Record<string, unknown>;
      return typeof settings.theme === 'string' &&
        (settings.language === undefined || typeof settings.language === 'string')
        ? { value: value as Profile }
        : { issues: [{ message: 'Expected stored settings.' }] };
    },
  },
};

const storedCountSchema: StandardSchemaV1<number> = {
  '~standard': {
    version: 1,
    vendor: 'managed-data-example',
    validate(value) {
      return typeof value === 'number' && Number.isFinite(value)
        ? { value }
        : { issues: [{ message: 'Expected a finite stored count.' }] };
    },
  },
};

// In SSR, create this instance for each request and close it when the request ends.
// Memory remains private to this instance, even if another instance uses the same namespace.
const storage = new NexusStorage({
  driver: 'memory',
  namespace: 'managed-data',
  schemas: { profile: profileSchema, count: countSchema },
  storedSchemas: { profile: storedProfileSchema, count: storedCountSchema },
});

try {
  const profile = await storage.set('profile', {
    name: ' Alex ', visits: 1, settings: { theme: 'light', language: 'zh-CN' },
  }, { ttl: 60_000 });
  console.log(profile.name); // 'Alex'; input conversion runs only on set / CAS / tx.set.

  const updated = await storage.update('profile', { visits: 2 }); // Preserves the expiry.
  console.log(updated.visits); // 2; the full Profile is inferred.

  const shallow = await storage.update('profile', { name: 'Sam', settings: { theme: 'dark' } });
  console.log(shallow.settings); // { theme: 'dark' }; the nested language field is replaced.
  // A patch containing name: ' Sam ' fails stored validation instead of silently trimming.

  await storage.update('profile', { visits: 3 }, { expiresAt: Date.now() + 120_000 });
  const count = await storage.set('count', '42'); // Input: string; output: number.
  console.log(count, await storage.get('count')); // 42, 42; rereading the output is stable.

  await storage.set('profile', { name: 'Sam', visits: 4, settings: { theme: 'dark' } }); // Replaces the value and removes expiry.
  console.log(await storage.keys()); // ['count', 'profile']

  // storage.set('count', false);           // Type error: invalid schema input.
  // storage.update('profile', { visits: '5' }); // Type error: invalid output patch.
  // storage.get('unknown');               // Type error: undeclared key.
} finally {
  await storage.close();
}
