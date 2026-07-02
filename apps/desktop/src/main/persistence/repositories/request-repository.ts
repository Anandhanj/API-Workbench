import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, like, max, or } from 'drizzle-orm';
import type { HttpMethod, RequestSummary } from '@shared/collection';
import type { WireAuthConfig } from '@shared/auth';
import type { RequestSource } from '@shared/sync';
import { RequestDetails, type RequestDetailFull } from '@shared/request-details';
import type { AppDatabase } from '../types';
import { NotFoundError } from '../types';
import { requests } from '../schema';
import type { RequestRow } from '../schema';

function toDto(row: RequestRow): RequestSummary {
  return {
    id: row.id,
    collectionId: row.collectionId,
    folderId: row.folderId,
    name: row.name,
    type: row.type,
    method: row.method as HttpMethod,
    url: row.url,
    favorite: row.favorite,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFull(row: RequestRow): RequestDetailFull {
  return {
    id: row.id,
    collectionId: row.collectionId,
    folderId: row.folderId,
    name: row.name,
    type: row.type,
    method: row.method as HttpMethod,
    url: row.url,
    favorite: row.favorite,
    details: RequestDetails.parse(row.details ?? {}),
  };
}

export interface CreateRequestRow {
  collectionId: string;
  folderId?: string | null;
  name: string;
  /** Request type (ADR-0009); defaults to 'http'. */
  type?: string;
  method?: HttpMethod;
  url?: string;
  details?: RequestDetails | null;
}

/** A spec-originated request with its sync baseline, for the sync engine. */
export interface SpecRequestRecord {
  id: string;
  collectionId: string;
  folderId: string | null;
  name: string;
  method: HttpMethod;
  url: string;
  favorite: boolean;
  source: RequestSource;
  details: RequestDetails | null;
}

/** Data access for requests. */
export class RequestRepository {
  constructor(private readonly db: AppDatabase) {}

  private nextPosition(collectionId: string): number {
    const row = this.db
      .select({ value: max(requests.position) })
      .from(requests)
      .where(eq(requests.collectionId, collectionId))
      .get();
    return (row?.value ?? -1) + 1;
  }

  create(input: CreateRequestRow): RequestSummary {
    return this.insert({ ...input, source: null });
  }

  /** Creates a request linked to a spec operation (sets the sync baseline). */
  createFromSpec(input: CreateRequestRow & { source: RequestSource }): RequestSummary {
    return this.insert(input);
  }

  private insert(input: CreateRequestRow & { source: RequestSource | null }): RequestSummary {
    const now = Date.now();
    const row: RequestRow = {
      id: randomUUID(),
      collectionId: input.collectionId,
      folderId: input.folderId ?? null,
      name: input.name,
      type: input.type ?? 'http',
      method: input.method ?? 'GET',
      url: input.url ?? '',
      favorite: false,
      position: this.nextPosition(input.collectionId),
      source: input.source,
      details: input.details ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(requests).values(row).run();
    return toDto(row);
  }

  findById(id: string): RequestSummary | undefined {
    const row = this.db.select().from(requests).where(eq(requests.id, id)).get();
    return row ? toDto(row) : undefined;
  }

  get(id: string): RequestSummary {
    const found = this.findById(id);
    if (!found) throw new NotFoundError('Request', id);
    return found;
  }

  /** Returns the request with its full, default-filled editable definition. */
  getFull(id: string): RequestDetailFull {
    const row = this.db.select().from(requests).where(eq(requests.id, id)).get();
    if (!row) throw new NotFoundError('Request', id);
    return toFull(row);
  }

  /** Persists an edited request: identity patch plus the full definition. */
  save(
    id: string,
    input: { name?: string; type?: string; method?: HttpMethod; url?: string; details: RequestDetails },
  ): RequestSummary {
    return this.patch(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      details: input.details,
    });
  }

  listByCollection(collectionId: string): RequestSummary[] {
    return this.db.select().from(requests).where(eq(requests.collectionId, collectionId)).all().map(toDto);
  }

  listByFolder(folderId: string): RequestSummary[] {
    return this.db.select().from(requests).where(eq(requests.folderId, folderId)).all().map(toDto);
  }

  /**
   * Overwrites just the `auth` slice of a request's stored definition, leaving
   * the rest of `details` intact. Used by the folder "apply to children" cascade
   * to set requests to `{ type: 'inherit' }`.
   */
  setAuth(id: string, auth: WireAuthConfig): RequestSummary {
    const row = this.db.select().from(requests).where(eq(requests.id, id)).get();
    if (!row) throw new NotFoundError('Request', id);
    const details = RequestDetails.parse(row.details ?? {});
    return this.patch(id, { details: { ...details, auth } });
  }

  /** Spec-originated requests (source not null), with their baseline, for syncing. */
  listSpecOrigin(collectionId: string): SpecRequestRecord[] {
    return this.db
      .select()
      .from(requests)
      .where(and(eq(requests.collectionId, collectionId), isNotNull(requests.source)))
      .all()
      .map((row) => ({
        id: row.id,
        collectionId: row.collectionId,
        folderId: row.folderId,
        name: row.name,
        method: row.method as HttpMethod,
        url: row.url,
        favorite: row.favorite,
        source: row.source as RequestSource,
        details: row.details ?? null,
      }));
  }

  countByCollection(collectionId: string): number {
    return this.listByCollection(collectionId).length;
  }

  listFavorites(collectionId: string): RequestSummary[] {
    return this.db
      .select()
      .from(requests)
      .where(and(eq(requests.collectionId, collectionId), eq(requests.favorite, true)))
      .all()
      .map(toDto);
  }

  search(collectionId: string, query: string): RequestSummary[] {
    const q = `%${query}%`;
    return this.db
      .select()
      .from(requests)
      .where(
        and(
          eq(requests.collectionId, collectionId),
          or(like(requests.name, q), like(requests.url, q), like(requests.method, q)),
        ),
      )
      .all()
      .map(toDto);
  }

  rename(id: string, name: string): RequestSummary {
    return this.patch(id, { name });
  }

  setFolder(id: string, folderId: string | null): RequestSummary {
    return this.patch(id, { folderId });
  }

  setFavorite(id: string, favorite: boolean): RequestSummary {
    return this.patch(id, { favorite });
  }

  update(
    id: string,
    patch: Partial<Pick<RequestRow, 'name' | 'method' | 'url' | 'folderId' | 'favorite'>>,
  ): RequestSummary {
    return this.patch(id, patch);
  }

  /** Applies a sync update, including the refreshed spec baseline. */
  updateFromSync(
    id: string,
    patch: Partial<Pick<RequestRow, 'name' | 'method' | 'url' | 'source' | 'details'>>,
  ): RequestSummary {
    return this.patch(id, patch);
  }

  private patch(
    id: string,
    patch: Partial<
      Pick<RequestRow, 'name' | 'type' | 'method' | 'url' | 'folderId' | 'favorite' | 'source' | 'details'>
    >,
  ): RequestSummary {
    const row = this.db.select().from(requests).where(eq(requests.id, id)).get();
    if (!row) throw new NotFoundError('Request', id);
    const next: RequestRow = { ...row, ...patch, updatedAt: Date.now() };
    this.db.update(requests).set(next).where(eq(requests.id, id)).run();
    return toDto(next);
  }

  duplicate(id: string, targetFolderId?: string | null): RequestSummary {
    const row = this.db.select().from(requests).where(eq(requests.id, id)).get();
    if (!row) throw new NotFoundError('Request', id);
    const now = Date.now();
    const copy: RequestRow = {
      id: randomUUID(),
      collectionId: row.collectionId,
      folderId: targetFolderId === undefined ? row.folderId : targetFolderId,
      name: `${row.name} (copy)`,
      type: row.type,
      method: row.method,
      url: row.url,
      favorite: false,
      position: this.nextPosition(row.collectionId),
      source: null,
      details: row.details,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(requests).values(copy).run();
    return toDto(copy);
  }

  delete(id: string): void {
    this.get(id);
    this.db.delete(requests).where(eq(requests.id, id)).run();
  }
}
