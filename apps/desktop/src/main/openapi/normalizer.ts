import type { HttpMethod } from '@shared/collection';
import type { NormalizedOperation, NormalizedSpec, SpecVersion } from '@shared/openapi';
import type { KeyValueEntry, RequestBodyDef, RequestDetails } from '@shared/request-details';
import { makeRefResolver, schemaToExample, scalarString } from './schema-example';

/** HTTP method keys recognised on an OpenAPI/Swagger path item. */
const OPERATION_METHODS: Array<[string, HttpMethod]> = [
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
];

/** Matches a single-brace OpenAPI path template token, e.g. `{userId}`. */
const PATH_TOKEN_RE = /\{([^{}]+)\}/g;

/**
 * Rewrites OpenAPI single-brace path tokens (`{userId}`) into the variable
 * engine's `{{userId}}` form so they resolve as request-scoped variables.
 */
function toTemplateVars(segment: string): string {
  return segment.replace(PATH_TOKEN_RE, (_match, name: string) => `{{${name.trim()}}}`);
}

/** Distinct template-variable names appearing in a path string, in order. */
function pathTokenNames(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(PATH_TOKEN_RE)) {
    const name = match[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveBaseUrl(document: Record<string, unknown>, version: SpecVersion): string {
  if (version === 'openapi-3') {
    const servers = document['servers'];
    if (Array.isArray(servers) && servers.length > 0) {
      const first = asRecord(servers[0]);
      return str(first?.['url']) ?? '';
    }
    return '';
  }
  // swagger-2: scheme://host + basePath
  const schemes = document['schemes'];
  const scheme = Array.isArray(schemes) && schemes.length ? str(schemes[0]) ?? 'https' : 'https';
  const host = str(document['host']);
  const basePath = str(document['basePath']) ?? '';
  return host ? `${scheme}://${host}${basePath}` : basePath;
}

/** Recursively counts `example` / `examples` occurrences (a rough richness metric). */
function countExamples(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, item) => sum + countExamples(item), 0);
  }
  const record = asRecord(node);
  if (!record) return 0;
  let count = 0;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'example') count += 1;
    else if (key === 'examples') {
      const examples = asRecord(value);
      count += examples ? Object.keys(examples).length : 0;
    }
    count += countExamples(value);
  }
  return count;
}

function countSchemas(document: Record<string, unknown>, version: SpecVersion): number {
  if (version === 'openapi-3') {
    const components = asRecord(document['components']);
    const schemas = asRecord(components?.['schemas']);
    return schemas ? Object.keys(schemas).length : 0;
  }
  const definitions = asRecord(document['definitions']);
  return definitions ? Object.keys(definitions).length : 0;
}

type Resolver = (ref: string) => Record<string, unknown> | null;

/** Resolves a possible `$ref` wrapper to its target record. */
function deref(value: unknown, resolve: Resolver): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref = str(record['$ref']);
  return ref ? resolve(ref) : record;
}

/** Collects path-item-level and operation-level parameters, resolving refs. */
function collectParameters(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  resolve: Resolver,
): Record<string, unknown>[] {
  const raw = [
    ...(Array.isArray(pathItem['parameters']) ? (pathItem['parameters'] as unknown[]) : []),
    ...(Array.isArray(operation['parameters']) ? (operation['parameters'] as unknown[]) : []),
  ];
  const result: Record<string, unknown>[] = [];
  for (const item of raw) {
    const param = deref(item, resolve);
    if (param) result.push(param);
  }
  return result;
}

/** Derives a scalar value for a header/query parameter from its schema/example. */
function parameterValue(param: Record<string, unknown>, resolve: Resolver): string {
  if (param['example'] !== undefined) return scalarString(param['example']);
  if (param['default'] !== undefined) return scalarString(param['default']);
  if (param['schema'] !== undefined) return scalarString(schemaToExample(param['schema'], resolve));
  // Swagger 2 inlines type/format/enum directly on the parameter.
  return scalarString(
    schemaToExample(
      { type: param['type'], format: param['format'], enum: param['enum'] },
      resolve,
    ),
  );
}

function firstExampleValue(examples: unknown): unknown {
  const record = asRecord(examples);
  if (!record) return undefined;
  for (const entry of Object.values(record)) {
    const ex = asRecord(entry);
    if (ex && 'value' in ex) return ex['value'];
  }
  return undefined;
}

function mediaExample(media: Record<string, unknown>, resolve: Resolver): unknown {
  if (media['example'] !== undefined) return media['example'];
  const fromExamples = firstExampleValue(media['examples']);
  if (fromExamples !== undefined) return fromExamples;
  if (media['schema'] !== undefined) return schemaToExample(media['schema'], resolve);
  return undefined;
}

function formFieldsFromSchema(schema: unknown, resolve: Resolver): KeyValueEntry[] {
  const resolved = deref(schema, resolve);
  const props = asRecord(resolved?.['properties']);
  if (!props) return [];
  return Object.entries(props).map(([key, propSchema]) => ({
    key,
    value: scalarString(schemaToExample(propSchema, resolve)),
    enabled: true,
  }));
}

const NONE_BODY: RequestBodyDef = {
  mode: 'none',
  rawType: 'json',
  rawBody: '',
  formFields: [],
  binaryBase64: '',
  binaryFileName: '',
};

/**
 * Path-template variables for an operation: a value per `{token}` in the path,
 * sourced from the declared `in: path` parameter's example/default when present.
 * Seeded as request-scoped variables on import so `{{token}}` in the URL resolves
 * and the value persists with the request.
 */
function extractPathVariables(
  params: Record<string, unknown>[],
  path: string,
  resolve: Resolver,
): { key: string; value: string }[] {
  const declared = new Map<string, string>();
  for (const param of params) {
    if (str(param['in']) !== 'path') continue;
    const name = str(param['name']);
    if (name) declared.set(name, parameterValue(param, resolve));
  }

  const result: { key: string; value: string }[] = [];
  for (const name of pathTokenNames(path)) {
    result.push({ key: name, value: declared.get(name) ?? '' });
  }
  // Declared path params that don't appear literally in the path (rare).
  for (const [name, value] of declared) {
    if (!result.some((r) => r.key === name)) result.push({ key: name, value });
  }
  return result;
}

function jsonBody(example: unknown): RequestBodyDef {
  if (example === undefined || example === null) return NONE_BODY;
  return { ...NONE_BODY, mode: 'raw', rawType: 'json', rawBody: JSON.stringify(example, null, 2) };
}

/** Extracts the request body definition from an OpenAPI 3 operation. */
function extractBodyOas3(operation: Record<string, unknown>, resolve: Resolver): RequestBodyDef {
  const body = deref(operation['requestBody'], resolve);
  const content = asRecord(body?.['content']);
  if (!content) return NONE_BODY;

  const json = asRecord(content['application/json']);
  if (json) return jsonBody(mediaExample(json, resolve));

  const urlencoded = asRecord(content['application/x-www-form-urlencoded']);
  if (urlencoded) {
    return { ...NONE_BODY, mode: 'urlencoded', formFields: formFieldsFromSchema(urlencoded['schema'], resolve) };
  }
  const multipart = asRecord(content['multipart/form-data']);
  if (multipart) {
    return { ...NONE_BODY, mode: 'formdata', formFields: formFieldsFromSchema(multipart['schema'], resolve) };
  }
  const firstType = Object.keys(content)[0];
  const firstMedia = firstType ? asRecord(content[firstType]) : null;
  if (firstMedia) {
    const example = mediaExample(firstMedia, resolve);
    if (example !== undefined && example !== null) {
      return { ...NONE_BODY, mode: 'raw', rawType: 'text', rawBody: scalarString(example) };
    }
  }
  return NONE_BODY;
}

/** Extracts the request body definition from a Swagger 2 operation. */
function extractBodySwagger2(
  operation: Record<string, unknown>,
  params: Record<string, unknown>[],
  resolve: Resolver,
): RequestBodyDef {
  const bodyParam = params.find((p) => str(p['in']) === 'body');
  if (bodyParam) return jsonBody(schemaToExample(bodyParam['schema'], resolve));

  const formParams = params.filter((p) => str(p['in']) === 'formData');
  if (formParams.length > 0) {
    const consumes = Array.isArray(operation['consumes']) ? (operation['consumes'] as unknown[]) : [];
    const multipart = consumes.some((c) => str(c) === 'multipart/form-data');
    return {
      ...NONE_BODY,
      mode: multipart ? 'formdata' : 'urlencoded',
      formFields: formParams.map((p) => ({
        key: str(p['name']) ?? '',
        value: parameterValue(p, resolve),
        enabled: true,
      })),
    };
  }
  return NONE_BODY;
}

/** Builds the persisted request definition from a spec operation. */
function extractDetails(
  params: Record<string, unknown>[],
  operation: Record<string, unknown>,
  version: SpecVersion,
  resolve: Resolver,
): RequestDetails | undefined {
  const headers: KeyValueEntry[] = [];
  const query: KeyValueEntry[] = [];
  for (const param of params) {
    const name = str(param['name']);
    if (!name) continue;
    const location = str(param['in']);
    if (location === 'header') {
      headers.push({ key: name, value: parameterValue(param, resolve), enabled: true });
    } else if (location === 'query') {
      query.push({ key: name, value: parameterValue(param, resolve), enabled: true });
    }
  }

  const body =
    version === 'openapi-3'
      ? extractBodyOas3(operation, resolve)
      : extractBodySwagger2(operation, params, resolve);

  if (headers.length === 0 && query.length === 0 && body.mode === 'none') return undefined;

  return {
    headers,
    params: query,
    auth: { type: 'none' },
    body,
    options: { timeoutMs: 30_000, maxRetries: 0, followRedirects: true },
  };
}

/** Reduces a parsed spec document to the model the generator consumes. */
export function normalizeSpec(
  document: Record<string, unknown>,
  version: SpecVersion,
): NormalizedSpec {
  const info = asRecord(document['info']) ?? {};
  const title = str(info['title']) ?? 'Imported API';
  const apiVersion = str(info['version']) ?? '';
  const baseUrl = resolveBaseUrl(document, version);

  const paths = asRecord(document['paths']) ?? {};
  const operations: NormalizedOperation[] = [];
  const tags: string[] = [];
  const resolve = makeRefResolver(document);

  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = asRecord(rawItem);
    if (!pathItem) continue;
    for (const [methodKey, method] of OPERATION_METHODS) {
      const operation = asRecord(pathItem[methodKey]);
      if (!operation) continue;

      const opTags = Array.isArray(operation['tags']) ? (operation['tags'] as unknown[]) : [];
      const tag = opTags.length ? str(opTags[0]) ?? null : null;
      if (tag && !tags.includes(tag)) tags.push(tag);

      const name =
        str(operation['summary']) ?? str(operation['operationId']) ?? `${method} ${path}`;

      const params = collectParameters(pathItem, operation, resolve);
      const details = extractDetails(params, operation, version, resolve);
      const pathVariables = extractPathVariables(params, path, resolve);

      operations.push({
        method,
        path,
        url: `${baseUrl}${toTemplateVars(path)}`,
        name,
        tag,
        ...(str(operation['operationId']) ? { operationId: str(operation['operationId']) } : {}),
        ...(details ? { details } : {}),
        ...(pathVariables.length ? { pathVariables } : {}),
      });
    }
  }

  return {
    specVersion: version,
    title,
    apiVersion,
    baseUrl,
    tags,
    operations,
    schemaCount: countSchemas(document, version),
    exampleCount: countExamples(document['paths']),
  };
}
