// `payload.onCommit(fn)` (issue #232): callbacks run after the commit that makes the write
// durable, in registration order, and are dropped by anything that rolls it back.
import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BuildSchemaConfig,
  buildSchema,
  discardCommitCallbacks,
  drizzleExecutorKey,
  runCommitCallbacks,
  type WriteHookPayload,
} from '@/index';

const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Articles = pgTable('articles', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
});

const r = createRelationsHelper({ Authors, Articles });
const relations = buildRelations(
  { Authors, Articles },
  {
    Authors: { articles: r.many.Articles({ from: r.Authors.id, to: r.Articles.authorId }) },
    Articles: { author: r.one.Authors({ from: r.Articles.authorId, to: r.Authors.id }) },
  },
);
const schema = { Authors, Articles, relations };

const DATA_DIR = `./tests/.temp/pgdata-on-commit-${Date.now()}`;
let pglite: PGlite;
let db: any;

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error) => error as Error, ...config }).schema;

const run = (gqlSchema: GraphQLSchema, source: string, contextValue: Record<PropertyKey, any> = {}) =>
  graphql({ schema: gqlSchema, source, contextValue });

const articleIds = async () => (await db.select().from(Articles).orderBy(Articles.id)).map((row: any) => row.id);
const authorIds = async () => (await db.select().from(Authors).orderBy(Authors.id)).map((row: any) => row.id);

/** What ran, in order: hooks push `hook:…`, callbacks push `commit:…`. */
let events: string[];

/** An `after` hook that queues one callback labelled with the table, operation and nested op. */
const deferLabel = (payload: WriteHookPayload) => {
  const label = `${payload.table}:${payload.operation}${payload.nested ? `:${payload.nested.op}` : ''}`;
  events.push(`hook:${label}`);
  payload.onCommit(() => {
    events.push(`commit:${label}`);
  });
};

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations });
  await db.execute(sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "articles" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "author_id" integer);`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  events = [];
  await db.delete(Articles);
  await db.delete(Authors);
  await db.insert(Authors).values([{ id: 1, name: 'Ada' }]);
  await db.insert(Articles).values([{ id: 1, title: 'first', authorId: 1 }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.sequential('onCommit: a field the library opened a transaction for', () => {
  it('runs after the commit, and the field resolves once it has settled', async () => {
    let seen: number[] | undefined;
    const gqlSchema = buildWith({
      onWrite: {
        Articles: (payload) => {
          payload.onCommit(async () => {
            // A separate read through `db`, not `tx`: on PGlite it would wait on the open
            // transaction forever if the callback ran before COMMIT.
            seen = await articleIds();
          });
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 2, title: "second" }]) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(seen).toEqual([1, 2]);
  });

  it('runs callbacks in registration order, across before and after', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: {
          before: (payload) => {
            payload.onCommit(() => void events.push('commit:before-1'));
            payload.onCommit(() => void events.push('commit:before-2'));
          },
          after: (payload) => {
            payload.onCommit(() => void events.push('commit:after'));
          },
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 2, title: "second" }]) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(events).toEqual(['commit:before-1', 'commit:before-2', 'commit:after']);
  });

  it('drops the callbacks when the hook that queued them throws', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: (payload) => {
          payload.onCommit(() => void events.push('commit'));
          throw new Error('rejected');
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 2, title: "second" }]) { id } }`);

    expect(res.errors?.[0]?.message).toContain('rejected');
    expect(await articleIds()).toEqual([1]);
    expect(events).toEqual([]);
  });

  it('a throwing callback is logged, the others still run, and the mutation still succeeds', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gqlSchema = buildWith({
      onWrite: {
        Articles: (payload) => {
          payload.onCommit(() => {
            throw new Error('mailer down');
          });
          payload.onCommit(() => void events.push('commit:second'));
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 2, title: "second" }]) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ createArticles: [{ id: 2 }] });
    expect(await articleIds()).toEqual([1, 2]);
    expect(events).toEqual(['commit:second']);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain('onCommit callback threw after the transaction committed');
    expect((logged.mock.calls[0]![1] as Error).message).toBe('mailer down');
  });

  it('refuses a callback queued after the commit', async () => {
    let late: WriteHookPayload | undefined;
    const gqlSchema = buildWith({
      onWrite: {
        Articles: (payload) => {
          late = payload;
        },
      },
    });

    await run(gqlSchema, `mutation { createArticles(values: [{ id: 2, title: "second" }]) { id } }`);

    expect(() => late!.onCommit(() => {})).toThrow(/after the write it belongs to had already committed/);
  });
});

describe.sequential('onCommit under nested writes', () => {
  const nested: Partial<BuildSchemaConfig> = { features: { nestedWrites: true } };

  it("queues nested statements' callbacks in hook order, and runs them after the commit", async () => {
    let seen: { authors: number[]; articles: number[] } | undefined;
    const gqlSchema = buildWith({
      ...nested,
      onWrite: {
        Authors: (payload) => {
          deferLabel(payload);
          payload.onCommit(async () => {
            seen = { authors: await authorIds(), articles: await articleIds() };
          });
        },
        Articles: deferLabel,
      },
    });

    const res = await run(
      gqlSchema,
      `mutation { createAuthorsSingle(values: { id: 2, name: "Grace", articles: {
        create: [{ id: 3, title: "third" }], connect: [{ id: { eq: 1 } }]
      } }) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(events).toEqual([
      'hook:Articles:update:connect',
      'hook:Articles:insert:create',
      'hook:Authors:insert',
      'commit:Articles:update:connect',
      'commit:Articles:insert:create',
      'commit:Authors:insert',
    ]);
    expect(seen).toEqual({ authors: [1, 2], articles: [1, 3] });
  });

  it("drops a nested statement's callbacks when a later hook throws", async () => {
    const gqlSchema = buildWith({
      ...nested,
      onWrite: {
        Authors: () => {
          throw new Error('author rejected');
        },
        Articles: deferLabel,
      },
    });

    const res = await run(
      gqlSchema,
      `mutation { createAuthorsSingle(values: { id: 2, name: "Grace", articles: { create: [{ id: 3, title: "t" }] } }) { id } }`,
    );

    expect(res.errors?.[0]?.message).toContain('author rejected');
    expect(events).toEqual(['hook:Articles:insert:create']);
  });

  it('drops earlier callbacks when a later nested write fails', async () => {
    const gqlSchema = buildWith({
      ...nested,
      onWrite: {
        Authors: {
          before: (payload) => {
            payload.onCommit(() => void events.push('commit:Authors:before'));
          },
        },
      },
    });

    // Article 1 already exists, so the nested create fails on its primary key.
    const res = await run(
      gqlSchema,
      `mutation { createAuthorsSingle(values: { id: 2, name: "Grace", articles: { create: [{ id: 1, title: "dup" }] } }) { id } }`,
    );

    expect(res.errors).toBeDefined();
    expect(await authorIds()).toEqual([1]);
    expect(events).toEqual([]);
  });

  it("drops a parent-side create's callbacks when its savepoint rolls back and keeps the rest", async () => {
    const gqlSchema = buildWith({ ...nested, onWrite: { Authors: deferLabel } });

    // The first entry matches no article, so the author it created is rolled back with its
    // savepoint; the field itself succeeds and the second entry's author stays.
    const res = await run(
      gqlSchema,
      `mutation { updateArticlesMany(updates: [
        { where: { id: { eq: 999 } }, set: { author: { create: { id: 50, name: "orphan" } } } },
        { where: { id: { eq: 1 } }, set: { author: { create: { id: 51, name: "kept" } } } }
      ]) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(await authorIds()).toEqual([1, 51]);
    expect(events).toEqual([
      'hook:Authors:insert:create',
      'hook:Authors:insert:create',
      // Only the kept entry's callback runs.
      'commit:Authors:insert:create',
    ]);
  });

  it('runs after the write when the root field carries no hook and so no transaction of its own', async () => {
    let seen: number[] | undefined;
    const gqlSchema = buildWith({
      ...nested,
      onWrite: {
        Articles: (payload) => {
          payload.onCommit(async () => {
            seen = await articleIds();
          });
        },
      },
    });

    const res = await run(
      gqlSchema,
      `mutation { createAuthorsSingle(values: { id: 2, name: "Grace", articles: { create: [{ id: 3, title: "t" }] } }) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(seen).toEqual([1, 3]);
  });
});

describe.sequential("onCommit under transactions: 'auto'", () => {
  it('runs every field’s callbacks once, after the shared commit, before the last field resolves', async () => {
    let seen: number[] | undefined;
    const gqlSchema = buildWith({
      transactions: 'auto',
      onWrite: {
        Articles: (payload) => {
          deferLabel(payload);
          payload.onCommit(async () => {
            seen = await articleIds();
          });
        },
      },
    });

    const res = await run(
      gqlSchema,
      `mutation {
        a: createArticles(values: [{ id: 2, title: "a" }]) { id }
        b: createArticles(values: [{ id: 3, title: "b" }]) { id }
      }`,
    );

    expect(res.errors).toBeUndefined();
    expect(events).toEqual([
      'hook:Articles:insert',
      'hook:Articles:insert',
      'commit:Articles:insert',
      'commit:Articles:insert',
    ]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("drops an earlier field's callbacks when a later sibling field fails", async () => {
    const gqlSchema = buildWith({ transactions: 'auto', onWrite: { Articles: deferLabel } });

    const res = await run(
      gqlSchema,
      `mutation {
        a: createArticles(values: [{ id: 2, title: "a" }]) { id }
        b: createArticles(values: [{ id: 1, title: "dup" }]) { id }
      }`,
    );

    expect(res.errors).toBeDefined();
    expect(await articleIds()).toEqual([1]);
    expect(events).toEqual(['hook:Articles:insert']);
  });

  it('drops the callbacks when the shared transaction times out', async () => {
    const gqlSchema = buildWith({ transactions: { mode: 'auto', timeoutMs: 50 }, onWrite: { Articles: deferLabel } });

    // Stall the second field's resolver past the timeout, as a host that stopped calling
    // resolvers would.
    const mutation = gqlSchema.getMutationType()!.getFields()['createArticles']!;
    const original = mutation.resolve!;
    let calls = 0;
    mutation.resolve = async (...args) => {
      calls += 1;
      if (calls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return original(...args);
    };
    try {
      const res = await run(
        gqlSchema,
        `mutation {
          a: createArticles(values: [{ id: 2, title: "a" }]) { id }
          b: createArticles(values: [{ id: 3, title: "b" }]) { id }
        }`,
      );
      expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_TRANSACTION_ABORTED');
    } finally {
      mutation.resolve = original;
    }

    expect(await articleIds()).toEqual([1]);
    expect(events).toEqual(['hook:Articles:insert']);
  });
});

describe.sequential('onCommit under a caller-supplied executor', () => {
  it('queues on the context until runCommitCallbacks, after the caller commits', async () => {
    const gqlSchema = buildWith({ onWrite: { Articles: deferLabel } });
    const contextValue: Record<PropertyKey, any> = {};

    await db.transaction(async (tx: any) => {
      contextValue[drizzleExecutorKey] = tx;
      const a = await run(
        gqlSchema,
        `mutation { createArticles(values: [{ id: 2, title: "a" }]) { id } }`,
        contextValue,
      );
      const b = await run(
        gqlSchema,
        `mutation { createArticles(values: [{ id: 3, title: "b" }]) { id } }`,
        contextValue,
      );
      expect(a.errors).toBeUndefined();
      expect(b.errors).toBeUndefined();
      expect(events).toEqual(['hook:Articles:insert', 'hook:Articles:insert']);
    });
    expect(events).toEqual(['hook:Articles:insert', 'hook:Articles:insert']);

    await runCommitCallbacks(contextValue);
    expect(events).toEqual([
      'hook:Articles:insert',
      'hook:Articles:insert',
      'commit:Articles:insert',
      'commit:Articles:insert',
    ]);

    // Run once: the queue is cleared.
    await runCommitCallbacks(contextValue);
    expect(events).toHaveLength(4);
  });

  it('discardCommitCallbacks drops them', async () => {
    const gqlSchema = buildWith({ onWrite: { Articles: deferLabel } });
    const contextValue: Record<PropertyKey, any> = {};

    await db
      .transaction(async (tx: any) => {
        contextValue[drizzleExecutorKey] = tx;
        await run(gqlSchema, `mutation { createArticles(values: [{ id: 2, title: "a" }]) { id } }`, contextValue);
        throw new Error('caller rolls back');
      })
      .catch(() => discardCommitCallbacks(contextValue));

    await runCommitCallbacks(contextValue);
    expect(await articleIds()).toEqual([1]);
    expect(events).toEqual(['hook:Articles:insert']);
  });

  it('a field that fails drops the callbacks it queued', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: (payload) => {
          payload.onCommit(() => void events.push('commit:failed'));
          throw new Error('rejected');
        },
        Authors: deferLabel,
      },
    });
    const contextValue: Record<PropertyKey, any> = {};

    await db.transaction(async (tx: any) => {
      contextValue[drizzleExecutorKey] = tx;
      await run(gqlSchema, `mutation { createAuthors(values: [{ id: 2, name: "g" }]) { id } }`, contextValue);
      const failed = await run(
        gqlSchema,
        `mutation { createArticles(values: [{ id: 2, title: "a" }]) { id } }`,
        contextValue,
      );
      expect(failed.errors?.[0]?.message).toContain('rejected');
    });

    await runCommitCallbacks(contextValue);
    expect(events).toEqual(['hook:Authors:insert', 'commit:Authors:insert']);
  });

  it('runCommitCallbacks runs every callback and rejects with an AggregateError of what threw', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: (payload) => {
          payload.onCommit(() => {
            throw new Error('first');
          });
          payload.onCommit(() => void events.push('commit:second'));
          payload.onCommit(async () => {
            throw new Error('third');
          });
        },
      },
    });
    const contextValue: Record<PropertyKey, any> = {};

    await db.transaction(async (tx: any) => {
      contextValue[drizzleExecutorKey] = tx;
      await run(gqlSchema, `mutation { createArticles(values: [{ id: 2, title: "a" }]) { id } }`, contextValue);
    });

    const flushed = await runCommitCallbacks(contextValue).then(
      () => undefined,
      (error: unknown) => error,
    );
    // `AggregateError` is ES2021, past the lib the tests compile against.
    expect(flushed).toBeInstanceOf((globalThis as any).AggregateError);
    expect((flushed as { errors: Error[] }).errors.map((error) => error.message)).toEqual(['first', 'third']);
    expect(events).toEqual(['commit:second']);
  });
});
