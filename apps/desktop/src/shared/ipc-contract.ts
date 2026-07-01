import { z } from 'zod';
import {
  Workspace,
  Project,
  Preference,
  BackupInfo,
  CreateWorkspaceInput,
  CreateProjectInput,
} from './persistence';
import { ActiveSelection, RecentProject, WorkspaceDetail, WorkspaceExport } from './workspace';
import {
  Collection,
  Folder,
  RequestSummary,
  TreeNode,
  RequestHistoryEntry,
  HttpMethod,
  CollectionSourceInfo,
  CreateCollectionInput,
  CreateFolderInput,
  CreateRequestInput,
} from './collection';
import { RequestDetailFull, SaveRequestInput } from './request-details';
import { ImportRequest, ImportResult } from './openapi';
import { SyncRequest, SyncResult } from './sync';
import { CredentialMeta, SaveCredentialInput } from './auth';
import { ExecutionRequest, ExecutionResponse } from './execution';
import { RunTestsRequest, TestReport } from './testing';
import { ScriptRunRequest, ScriptRunResult, PreScriptRunRequest } from './scripting';
import { CollectionVersion, VersionDiff, VersionSnapshot, RestoreResult } from './version';
import { Variable, VariableScope, VariableContext, EvaluateRequest, ResolvedKey } from './variable';
import {
  Workflow,
  WorkflowDetail,
  CreateWorkflowInput,
  SaveWorkflowInput,
  WorkflowRunRequest,
  WorkflowRunResult,
  WorkflowInputRequest,
  WorkflowInputResponse,
  WorkflowExport,
  ImportWorkflowInput,
  WorkflowProgressEvent,
} from './workflow';

/**
 * Single source of truth for the cross-process IPC contract.
 *
 * Every channel is defined here with a Zod schema for its request and response.
 * Both the main process (handler validation) and the renderer (typed client)
 * import from this module so the wire format cannot drift between the two sides.
 *
 * See ADR-0003: Electron security model and typed IPC contract.
 */

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export const DispatchEvent = z.object({
  id: z.string(),
  timestamp: z.number(),
  level: LogLevel,
  source: z.string(),
  message: z.string(),
  context: z.record(z.unknown()).optional(),
});
export type DispatchEvent = z.infer<typeof DispatchEvent>;

export const AppInfo = z.object({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
});
export type AppInfo = z.infer<typeof AppInfo>;

const Empty = z.object({}).strict();
const IdOnly = z.object({ id: z.string() });
const NullableId = z.string().nullable();

export const IpcChannels = {
  'app.getInfo': { request: Empty, response: AppInfo },
  'dispatch.getBuffer': { request: Empty, response: z.array(DispatchEvent) },
  'dispatch.emit': { request: DispatchEvent.omit({ id: true, timestamp: true }), response: Empty },

  // --- Diagnostics: on-disk log for debugging ---
  'log.getPath': { request: Empty, response: z.object({ path: z.string() }) },
  'log.reveal': { request: Empty, response: Empty },

  // --- Workspaces ---
  'workspace.list': { request: Empty, response: z.array(Workspace) },
  'workspace.create': { request: CreateWorkspaceInput, response: Workspace },
  'workspace.rename': {
    request: z.object({ id: z.string(), name: z.string().min(1) }),
    response: Workspace,
  },
  'workspace.delete': { request: IdOnly, response: Empty },
  'workspace.detail': { request: IdOnly, response: WorkspaceDetail },
  'workspace.setActive': { request: IdOnly, response: Empty },
  'workspace.getActive': { request: Empty, response: ActiveSelection },
  'workspace.updateSettings': {
    request: z.object({ id: z.string(), settings: z.record(z.unknown()) }),
    response: Workspace,
  },
  'workspace.export': { request: IdOnly, response: WorkspaceExport },
  'workspace.import': { request: z.object({ data: WorkspaceExport }), response: Workspace },

  // --- Projects ---
  'project.listByWorkspace': {
    request: z.object({ workspaceId: z.string() }),
    response: z.array(Project),
  },
  'project.create': { request: CreateProjectInput, response: Project },
  'project.rename': {
    request: z.object({ id: z.string(), name: z.string().min(1) }),
    response: Project,
  },
  'project.delete': { request: IdOnly, response: Empty },
  'project.open': { request: IdOnly, response: Empty },
  'project.close': { request: Empty, response: Empty },
  'project.recent': {
    request: z.object({ limit: z.number().optional() }),
    response: z.array(RecentProject),
  },

  // --- Collections ---
  'collection.list': {
    request: z.object({ projectId: z.string() }),
    response: z.array(Collection),
  },
  'collection.create': { request: CreateCollectionInput, response: Collection },
  'collection.rename': {
    request: z.object({ id: z.string(), name: z.string().min(1) }),
    response: Collection,
  },
  'collection.delete': { request: IdOnly, response: Empty },
  'collection.tree': {
    request: z.object({ collectionId: z.string() }),
    response: z.array(TreeNode),
  },
  'collection.source': {
    request: z.object({ collectionId: z.string() }),
    response: CollectionSourceInfo.nullable(),
  },

  // --- Folders ---
  'folder.create': { request: CreateFolderInput, response: Folder },
  'folder.rename': {
    request: z.object({ id: z.string(), name: z.string().min(1) }),
    response: Folder,
  },
  'folder.move': { request: z.object({ id: z.string(), parentId: NullableId }), response: Folder },
  'folder.delete': { request: IdOnly, response: Empty },

  // --- Requests ---
  'request.create': { request: CreateRequestInput, response: RequestSummary },
  'request.rename': {
    request: z.object({ id: z.string(), name: z.string().min(1) }),
    response: RequestSummary,
  },
  'request.update': {
    request: z.object({
      id: z.string(),
      name: z.string().optional(),
      method: HttpMethod.optional(),
      url: z.string().optional(),
    }),
    response: RequestSummary,
  },
  'request.move': {
    request: z.object({ id: z.string(), folderId: NullableId }),
    response: RequestSummary,
  },
  'request.copy': {
    request: z.object({ id: z.string(), folderId: NullableId.optional() }),
    response: RequestSummary,
  },
  'request.delete': { request: IdOnly, response: Empty },
  'request.toggleFavorite': { request: IdOnly, response: RequestSummary },
  'request.favorites': {
    request: z.object({ collectionId: z.string() }),
    response: z.array(RequestSummary),
  },
  'request.search': {
    request: z.object({ collectionId: z.string(), query: z.string() }),
    response: z.array(RequestSummary),
  },
  'request.open': { request: IdOnly, response: RequestSummary },
  'request.get': { request: IdOnly, response: RequestDetailFull },
  'request.save': { request: SaveRequestInput, response: RequestSummary },
  'request.history': {
    request: z.object({ limit: z.number().optional() }),
    response: z.array(RequestHistoryEntry),
  },
  'request.clearHistory': { request: Empty, response: Empty },

  // --- Native file picker (for form-data / binary bodies) ---
  'dialog.openFile': {
    request: Empty,
    response: z.object({
      canceled: z.boolean(),
      name: z.string().optional(),
      base64: z.string().optional(),
      size: z.number().optional(),
    }),
  },

  // --- OpenAPI import / sync ---
  'openapi.import': { request: ImportRequest, response: ImportResult },
  'openapi.sync': { request: SyncRequest, response: SyncResult },

  // --- Authentication credentials (Phase 9) ---
  'auth.list': {
    request: z.object({ scope: z.string(), scopeId: z.string().optional() }),
    response: z.array(CredentialMeta),
  },
  'auth.save': { request: SaveCredentialInput, response: CredentialMeta },
  'auth.delete': { request: z.object({ id: z.string() }), response: z.object({}).strict() },

  // --- Request execution (Phase 10) ---
  'request.execute': {
    request: z.object({ request: ExecutionRequest }),
    response: ExecutionResponse,
  },
  'request.cancel': { request: z.object({ id: z.string() }), response: z.object({}).strict() },

  // --- Testing & assertions (Phase 11) ---
  'test.run': { request: RunTestsRequest, response: TestReport },

  // --- Scripting (pm API) ---
  'script.run': { request: ScriptRunRequest, response: ScriptRunResult },
  'script.runPre': { request: PreScriptRunRequest, response: ScriptRunResult },

  // --- Version control ---
  'version.snapshot': {
    request: z.object({ collectionId: z.string(), label: z.string().optional() }),
    response: CollectionVersion,
  },
  'version.list': {
    request: z.object({ collectionId: z.string() }),
    response: z.array(CollectionVersion),
  },
  'version.diff': { request: z.object({ versionId: z.string() }), response: VersionDiff },
  'version.get': { request: z.object({ versionId: z.string() }), response: VersionSnapshot },
  'version.restore': { request: z.object({ versionId: z.string() }), response: RestoreResult },

  // --- Variables ---
  'variable.list': {
    request: z.object({ scope: VariableScope, scopeId: z.string().optional() }),
    response: z.array(Variable),
  },
  'variable.set': {
    request: z.object({
      scope: VariableScope,
      scopeId: z.string().optional(),
      key: z.string().min(1),
      value: z.string(),
      secret: z.boolean().optional(),
    }),
    response: Variable,
  },
  'variable.delete': {
    request: z.object({ scope: VariableScope, scopeId: z.string().optional(), key: z.string() }),
    response: Empty,
  },
  'variable.evaluate': { request: EvaluateRequest, response: z.object({ value: z.string() }) },
  'variable.resolvedKeys': {
    request: z.object({ context: VariableContext.optional() }),
    response: z.array(ResolvedKey),
  },

  // --- Workflows (Phase 12) ---
  'workflow.list': { request: z.object({ projectId: z.string() }), response: z.array(Workflow) },
  'workflow.get': { request: z.object({ id: z.string() }), response: WorkflowDetail },
  'workflow.create': { request: CreateWorkflowInput, response: WorkflowDetail },
  'workflow.rename': {
    request: z.object({ id: z.string(), name: z.string().min(1) }),
    response: Workflow,
  },
  'workflow.save': { request: SaveWorkflowInput, response: WorkflowDetail },
  'workflow.duplicate': { request: IdOnly, response: WorkflowDetail },
  'workflow.delete': { request: IdOnly, response: Empty },
  'workflow.export': { request: IdOnly, response: WorkflowExport },
  'workflow.import': { request: ImportWorkflowInput, response: WorkflowDetail },
  'workflow.run': { request: WorkflowRunRequest, response: WorkflowRunResult },
  'workflow.cancel': { request: IdOnly, response: Empty },
  'workflow.pause': { request: IdOnly, response: Empty },
  'workflow.resume': { request: IdOnly, response: Empty },
  'workflow.step': { request: IdOnly, response: Empty },
  'workflow.provideInput': { request: WorkflowInputResponse, response: Empty },

  // --- Preferences ---
  'preferences.get': {
    request: z.object({ key: z.string() }),
    response: z.object({ value: z.unknown() }),
  },
  'preferences.set': {
    request: z.object({ key: z.string(), value: z.unknown() }),
    response: Empty,
  },
  'preferences.list': { request: Empty, response: z.array(Preference) },

  // --- Backups ---
  'backup.create': { request: Empty, response: BackupInfo },
  'backup.list': { request: Empty, response: z.array(BackupInfo) },
  'backup.restore': { request: IdOnly, response: BackupInfo },
} as const;

export type IpcChannelName = keyof typeof IpcChannels;
export type IpcRequest<C extends IpcChannelName> = z.infer<(typeof IpcChannels)[C]['request']>;
export type IpcResponse<C extends IpcChannelName> = z.infer<(typeof IpcChannels)[C]['response']>;

export const IpcEvents = {
  'dispatch.event': DispatchEvent,
  'workflow.awaitingInput': WorkflowInputRequest,
  'workflow.nodeProgress': WorkflowProgressEvent,
} as const;

export type IpcEventName = keyof typeof IpcEvents;
export type IpcEventPayload<E extends IpcEventName> = z.infer<(typeof IpcEvents)[E]>;

export const INVOKE_CHANNEL_NAMES = Object.keys(IpcChannels) as IpcChannelName[];
export const EVENT_CHANNEL_NAMES = Object.keys(IpcEvents) as IpcEventName[];

export interface WorkbenchApi {
  invoke<C extends IpcChannelName>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  onDispatchEvent(listener: (event: DispatchEvent) => void): () => void;
  onWorkflowAwaitingInput(listener: (event: WorkflowInputRequest) => void): () => void;
  onWorkflowNodeProgress(listener: (event: WorkflowProgressEvent) => void): () => void;
}
