import type { RequestDetailFull } from '@shared/request-details';
import type { ExtractRule, RequestNodeConfig } from '@shared/workflow';
import { buildExecutionRequest, detailToDraft } from '../runner/build-request';

/**
 * Maps a collection request's full definition into a workflow request-node config
 * (Phase: link workflows to collections). It reuses the runner's exact
 * draft → ExecutionRequest conversion so a node imported from a collection
 * behaves identically to running that request in the runner: same method, URL,
 * headers, query params, body, auth, and options.
 *
 * `extract` rules already on the node are preserved (importing replaces the
 * request definition, not the response mappings), and the node records its
 * source `requestId` for display and re-sync.
 */
export function requestDetailToNodeConfig(
  detail: RequestDetailFull,
  extract: ExtractRule[] = [],
): RequestNodeConfig {
  const exec = buildExecutionRequest(detailToDraft(detail));
  return {
    method: exec.method,
    url: exec.url,
    headers: exec.headers ?? {},
    query: exec.query ?? {},
    body: exec.body ?? { type: 'none' },
    ...(exec.auth ? { auth: exec.auth } : {}),
    ...(exec.options ? { options: exec.options } : {}),
    extract,
    requestId: detail.id,
  };
}
