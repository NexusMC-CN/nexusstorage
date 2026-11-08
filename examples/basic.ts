import { NexusStorage, NexusStorageError } from '@nexusmc-cn/nexusstorage';

interface Profile {
  name: string;
  settings: { theme: 'light' | 'dark'; language: string };
  tags: string[];
}

/** 在浏览器中调用；更换 driver 不需要改变下方读写代码。 */
export async function basicExample(): Promise<Profile | undefined> {
  const storage = new NexusStorage({ driver: 'localStorage', namespace: 'my-app' });
  try {
    await storage.set<Profile>('profile', {
      name: 'Alex',
      settings: { theme: 'light', language: 'zh-CN' },
      tags: ['developer'],
    });
    const updated = await storage.update<Profile>('profile', { name: 'Sam' });
    console.log(updated.name, await storage.has('profile'), await storage.keys());
    const profile = await storage.get<Profile>('profile');
    await storage.remove('profile');
    await storage.clear();
    return profile;
  } catch (error) {
    if (error instanceof NexusStorageError) console.error(error.code, error.cause);
    throw error;
  } finally {
    await storage.close();
  }
}
