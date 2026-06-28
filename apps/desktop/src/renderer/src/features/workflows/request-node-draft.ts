import type { RequestBody } from '@shared/execution';
import type { ExtractRule, RequestNodeConfig } from '@shared/workflow';
import {
  buildExecutionRequest,
  defaultDraft,
  newRow,
  type KeyValue,
  type RawType,
  type RequestDraft,
} from '../runner/build-request';

/**
 * Bridges a workflow request node's config and the runner's {@link RequestDraft},
 * so the full request editor (the "run window") can configure a workflow request
 * node. `nodeConfigToDraft` seeds the editor; `draftToNodeConfig` applies the
 * edited draft back, reusing the runner's exact draft → request conversion and
 * preserving the node's `extract` rules and collection `requestId`.
 */

function recordToRows(record: Record<string, string>): KeyValue[] {
  const rows: KeyValue[] = Object.entries(record).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value,
    enabled: true,
  }));
  rows.push(newRow());
  return rows;
}

type BodyDraft = Pick<
  RequestDraft,
  'bodyMode' | 'rawType' | 'rawBody' | 'formFields' | 'binaryBase64' | 'binaryFileName'
>;

function bodyToDraft(body: RequestBody): BodyDraft {
  const base: BodyDraft = {
    bodyMode: 'none',
    rawType: 'json',
    rawBody: '',
    formFields: [newRow()],
    binaryBase64: '',
    binaryFileName: '',
  };
  switch (body.type) {
    case 'json':
      return { ...base, bodyMode: 'raw', rawType: 'json', rawBody: body.content };
    case 'text': {
      const rawType: RawType = body.contentType?.includes('xml') ? 'xml' : 'text';
      return { ...base, bodyMode: 'raw', rawType, rawBody: body.content };
    }
    case 'form':
      return {
        ...base,
        bodyMode: 'urlencoded',
        formFields: [
          ...body.fields.map((f) => ({ id: crypto.randomUUID(), key: f.name, value: f.value, enabled: true })),
          newRow(),
        ],
      };
    case 'multipart':
      return {
        ...base,
        bodyMode: 'formdata',
        formFields: [
          ...body.fields.map((f) =>
            f.fileName !== undefined || f.base64 !== undefined
              ? {
                  id: crypto.randomUUID(),
                  key: f.name,
                  value: '',
                  enabled: true,
                  kind: 'file' as const,
                  fileName: f.fileName ?? '',
                  fileBase64: f.base64 ?? '',
                }
              : { id: crypto.randomUUID(), key: f.name, value: f.value ?? '', enabled: true },
          ),
          newRow(),
        ],
      };
    case 'binary':
      return { ...base, bodyMode: 'binary', binaryBase64: body.base64 };
    default:
      return base;
  }
}

export function nodeConfigToDraft(config: RequestNodeConfig): RequestDraft {
  const base = defaultDraft(config.method, config.url);
  return {
    ...base,
    method: config.method,
    url: config.url,
    headers: recordToRows(config.headers ?? {}),
    params: recordToRows(config.query ?? {}),
    auth: config.auth ?? { type: 'none' },
    ...bodyToDraft(config.body ?? { type: 'none' }),
    options: {
      timeoutMs: config.options?.timeoutMs ?? 30_000,
      maxRetries: config.options?.maxRetries ?? 0,
      followRedirects: config.options?.followRedirects ?? true,
    },
  };
}

export function draftToNodeConfig(
  draft: RequestDraft,
  extract: ExtractRule[],
  requestId?: string,
): RequestNodeConfig {
  const exec = buildExecutionRequest(draft);
  return {
    method: exec.method,
    url: exec.url,
    headers: exec.headers ?? {},
    query: exec.query ?? {},
    body: exec.body ?? { type: 'none' },
    ...(exec.auth ? { auth: exec.auth } : {}),
    ...(exec.options ? { options: exec.options } : {}),
    extract,
    ...(requestId ? { requestId } : {}),
  };
}
