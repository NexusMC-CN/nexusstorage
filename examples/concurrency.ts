import { NexusStorage, NexusStorageError } from '@nexusmc-cn/nexusstorage';
import type { StandardSchemaV1, StorageEntry } from '@nexusmc-cn/nexusstorage';

const balanceSchema: StandardSchemaV1<number> = {
  '~standard': {
    version: 1,
    vendor: 'balance-example',
    validate(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? { value }
        : { issues: [{ message: '余额必须为非负有限数字' }] };
    },
  },
};

/** Memory 可在 Node.js 执行；IndexedDB 需浏览器。事务回调内不使用 await。 */
export async function concurrencyExample(
  driver: 'memory' | 'indexedDB' = 'memory',
): Promise<{ total: number; alice: StorageEntry<number> }> {
  const balances = new NexusStorage({
    driver,
    namespace: 'concurrency-example',
    schemas: { alice: balanceSchema, bob: balanceSchema },
  });
  const unsubscribe = balances.on('change', event => {
    console.log(event.operation, event.key, event.source);
  });
  try {
    // 初始化与转账都限制在明确声明的两个 key 上。
    const total = await balances.transaction(['alice', 'bob'], tx => {
      const alice = tx.get('alice') ?? 10;
      const bob = tx.get('bob') ?? 0;
      tx.set('alice', alice - 3, { ttl: null });
      tx.set('bob', bob + 3);
      return alice + bob;
    });
    const before = await balances.getEntry('alice'); // StorageEntry<number> | undefined
    if (!before) throw new Error('转账完成后缺少 Alice 的记录。');
    // CAS 只能替换此快照版本；其他写入先提交时会得到 CONFLICT。
    const alice = await balances.compareAndSwap('alice', before.revision, before.value + 1);
    return { total, alice };
  } catch (error) {
    if (error instanceof NexusStorageError && error.code === 'CONFLICT') {
      console.log('余额已经变化，请重新读取后再决定是否重试。');
    }
    throw error;
  } finally {
    unsubscribe();
    await balances.close();
  }
}
