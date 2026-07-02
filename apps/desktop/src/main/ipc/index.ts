import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { IpcChannels, type DispatchEvent, type IpcChannelName } from '@shared/ipc-contract';
import type { WorkflowInputRequest, WorkflowInputResult } from '@shared/workflow';
import { logger } from '../services/logger';
import type { PersistenceService } from '../persistence';
import type { WorkspaceManager } from '../workspace';
import type { CollectionExplorer } from '../collections';
import type { ImportService, SyncService } from '../openapi';
import type { VersioningService } from '../versioning';
import type { VariableService } from '../variables';
import { type AuthService, resolveInheritedAuth, type InheritanceLookups } from '../auth';
import type { ExecutionService } from '../execution';
import type { TestRunner } from '../testing';
import { type WorkflowService, RunController } from '../workflows';
import type { PluginService } from '../plugins';
import { runPostResponseScript, runPreRequestScript } from '../scripting';

/**
 * Registers every IPC channel handler. Each inbound payload is validated against
 * its Zod schema before the handler runs; the response is validated before it is
 * returned. A validation failure is rejected and logged rather than processed.
 *
 * See ADR-0003: Electron security model and typed IPC contract.
 */

export interface IpcContext {
  persistence: PersistenceService;
  workspaces: WorkspaceManager;
  collections: CollectionExplorer;
  imports: ImportService;
  sync: SyncService;
  versioning: VersioningService;
  variables: VariableService;
  auth: AuthService;
  execution: ExecutionService;
  testRunner: TestRunner;
  workflows: WorkflowService;
  plugins: PluginService;
}

/** Extra, non-service dependencies the IPC layer needs. */
export interface IpcOptions {
  /** Resolves the current on-disk debug log path (it changes daily). */
  logFilePath: () => string;
}

/** Tracks in-flight executions by id so they can be cancelled. */
const inflightExecutions = new Map<string, AbortController>();
/** Tracks in-flight workflow runs by workflow id so they can be cancelled/paused. */
const inflightWorkflows = new Map<string, RunController>();
/**
 * Resolvers for user-input nodes currently suspended awaiting a renderer reply,
 * keyed by `workflowId:nodeId`. `workflow.provideInput` (or cancellation) settles
 * them, unblocking the engine.
 */
const pendingInputs = new Map<string, (result: WorkflowInputResult) => void>();

/** Sends an event payload to the first live renderer window, if any. */
function sendToRenderer(channel: string, payload: unknown): void {
  const window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  window?.webContents.send(channel, payload);
}

/** Pushes a `plugins.changed` event so renderer queries refetch (Phase 16). */
export function notifyPluginsChanged(reason: string): void {
  sendToRenderer('plugins.changed', { reason });
}

/**
 * Pushes a user-input request to the renderer and resolves once the user replies
 * via `workflow.provideInput` or the run is cancelled. Resolves cancelled when no
 * window can receive the prompt.
 */
function awaitUserInput(
  request: WorkflowInputRequest,
  controller: RunController,
): Promise<WorkflowInputResult> {
  const key = `${request.workflowId}:${request.nodeId}`;
  const window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!window) return Promise.resolve({ values: {}, cancelled: true });

  return new Promise<WorkflowInputResult>((resolve) => {
    const settle = (result: WorkflowInputResult): void => {
      if (!pendingInputs.has(key)) return;
      pendingInputs.delete(key);
      controller.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => settle({ values: {}, cancelled: true });
    pendingInputs.set(key, settle);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    window.webContents.send('workflow.awaitingInput', request);
  });
}

type Handler<C extends IpcChannelName> = (
  request: ReturnType<(typeof IpcChannels)[C]['request']['parse']>,
) => Promise<unknown> | unknown;

export function registerIpcHandlers(context: IpcContext, options: IpcOptions): void {
  const {
    persistence,
    workspaces,
    collections,
    imports,
    sync,
    versioning,
    variables,
    auth,
    execution,
    testRunner,
    workflows,
    plugins,
  } = context;
  const { logFilePath } = options;

  // Adapter exposing just what the script sandbox needs from the variable engine.
  const scriptVariables = {
    set: (input: Parameters<typeof variables.set>[0]) => {
      variables.set(input);
    },
    delete: (scope: Parameters<typeof variables.delete>[0], key: string, scopeId?: string) =>
      variables.delete(scope, key, scopeId),
    resolve: (ctx: Parameters<typeof variables.resolve>[0]) => {
      const map = new Map<string, { value: string }>();
      for (const [key, resolved] of variables.resolve(ctx)) map.set(key, { value: resolved.value });
      return map;
    },
  };

  // Folder/request lookups the inheritance resolver walks to turn an `inherit`
  // request auth into the effective config from its parent folder chain (ADR-0009).
  const inheritanceLookups: InheritanceLookups = {
    folder: (id) => {
      const f = persistence.folders.findById(id);
      return f ? { parentId: f.parentId, auth: f.auth } : undefined;
    },
    requestFolderId: (id) => persistence.requests.findById(id)?.folderId,
  };

  const handlers: { [C in IpcChannelName]: Handler<C> } = {
    'app.getInfo': () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      platform: process.platform,
    }),
    'dispatch.getBuffer': () => logger.getBuffer(),
    'log.getPath': () => ({ path: logFilePath() }),
    'log.reveal': () => {
      shell.showItemInFolder(logFilePath());
      return {};
    },
    'dispatch.emit': (request) => {
      logger.log(request.level, `renderer:${request.source}`, request.message, request.context);
      return {};
    },

    'workspace.list': () => workspaces.listWorkspaces(),
    'workspace.create': (request) => workspaces.createWorkspace(request),
    'workspace.rename': (request) => workspaces.renameWorkspace(request.id, request.name),
    'workspace.delete': (request) => {
      workspaces.deleteWorkspace(request.id);
      return {};
    },
    'workspace.detail': (request) => workspaces.getWorkspaceDetail(request.id),
    'workspace.setActive': (request) => {
      workspaces.setActiveWorkspace(request.id);
      return {};
    },
    'workspace.getActive': () => workspaces.getActiveSelection(),
    'workspace.updateSettings': (request) =>
      workspaces.updateWorkspaceSettings(request.id, request.settings),
    'workspace.export': (request) => workspaces.exportWorkspace(request.id),
    'workspace.import': (request) => workspaces.importWorkspace(request.data),

    'project.listByWorkspace': (request) => workspaces.listProjects(request.workspaceId),
    'project.create': (request) => workspaces.createProject(request),
    'project.rename': (request) => workspaces.renameProject(request.id, request.name),
    'project.delete': (request) => {
      workspaces.deleteProject(request.id);
      return {};
    },
    'project.open': (request) => {
      workspaces.openProject(request.id);
      return {};
    },
    'project.close': () => {
      workspaces.closeProject();
      return {};
    },
    'project.recent': (request) => workspaces.listRecentProjects(request.limit),

    'collection.list': (request) => collections.listCollections(request.projectId),
    'collection.create': (request) => collections.createCollection(request),
    'collection.rename': (request) => collections.renameCollection(request.id, request.name),
    'collection.delete': (request) => {
      collections.deleteCollection(request.id);
      return {};
    },
    'collection.tree': (request) => collections.getTree(request.collectionId),
    'collection.source': (request) => collections.getSource(request.collectionId),

    'folder.create': (request) => collections.createFolder(request),
    'folder.get': (request) => collections.getFolder(request.id),
    'folder.rename': (request) => collections.renameFolder(request.id, request.name),
    'folder.move': (request) => collections.moveFolder(request.id, request.parentId),
    'folder.updateAuth': (request) => collections.updateFolderAuth(request.id, request.auth),
    'folder.applyAuthToChildren': (request) => collections.applyAuthToChildren(request.id),
    'folder.delete': (request) => {
      collections.deleteFolder(request.id);
      return {};
    },

    'request.create': (request) => collections.createRequest(request),
    'request.rename': (request) => collections.renameRequest(request.id, request.name),
    'request.update': (request) =>
      collections.updateRequest(request.id, {
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.method !== undefined ? { method: request.method } : {}),
        ...(request.url !== undefined ? { url: request.url } : {}),
      }),
    'request.move': (request) => collections.moveRequest(request.id, request.folderId),
    'request.copy': (request) => collections.copyRequest(request.id, request.folderId),
    'request.delete': (request) => {
      collections.deleteRequest(request.id);
      return {};
    },
    'request.toggleFavorite': (request) => collections.toggleFavorite(request.id),
    'request.favorites': (request) => collections.listFavorites(request.collectionId),
    'request.search': (request) => collections.searchRequests(request.collectionId, request.query),
    'request.open': (request) => collections.openRequest(request.id),
    'request.get': (request) => collections.getRequest(request.id),
    'request.save': (request) => collections.saveRequest(request),
    'request.history': (request) => collections.listHistory(request.limit),
    'request.clearHistory': () => {
      collections.clearHistory();
      return {};
    },

    'dialog.openFile': async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
        : await dialog.showOpenDialog({ properties: ['openFile'] });
      const filePath = result.filePaths[0];
      if (result.canceled || !filePath) return { canceled: true };
      const data = await readFile(filePath);
      return {
        canceled: false,
        name: basename(filePath),
        base64: data.toString('base64'),
        size: data.length,
      };
    },

    'openapi.import': async (request) => {
      const result = await imports.import(request);
      // Auto-snapshot the freshly imported collection as a baseline version.
      try {
        versioning.snapshot(result.collectionId, 'Imported');
      } catch (error) {
        logger.warn('versioning', 'Auto-snapshot after import failed', {
          message: (error as Error).message,
        });
      }
      return result;
    },
    'openapi.sync': async (request) => {
      // Snapshot the pre-sync state first so the merge can be rolled back.
      try {
        versioning.snapshot(request.collectionId, 'Before sync');
      } catch (error) {
        logger.warn('versioning', 'Auto-snapshot before sync failed', {
          message: (error as Error).message,
        });
      }
      const result = await sync.sync(request);
      // Snapshot the post-sync state so the merged result is also versioned.
      try {
        versioning.snapshot(request.collectionId, 'After sync');
      } catch (error) {
        logger.warn('versioning', 'Auto-snapshot after sync failed', {
          message: (error as Error).message,
        });
      }
      return result;
    },

    'auth.list': (request) => auth.list(request.scope, request.scopeId),
    'auth.save': (request) => auth.save(request),
    'auth.delete': (request) => {
      auth.delete(request.id);
      return {};
    },

    'request.execute': async (payload) => {
      // Stored credentials are resolved inside the execution dispatcher via the
      // AuthService port (ADR-0009), so the envelope passes through as-is.
      let req = payload.request;
      // Folder-auth inheritance: an `inherit` request takes its effective auth
      // from the nearest ancestor folder. Resolve it here (main owns the folder
      // chain) before the envelope reaches execution; a `none` result drops auth.
      if (req.auth?.type === 'inherit') {
        const resolved = resolveInheritedAuth(
          {
            ...(req.variableContext?.requestId ? { requestId: req.variableContext.requestId } : {}),
            ...(req.variableContext?.folderId !== undefined
              ? { folderId: req.variableContext.folderId }
              : {}),
          },
          inheritanceLookups,
        );
        const { auth: _inherit, ...rest } = req;
        req = resolved.type === 'none' ? rest : { ...rest, auth: resolved };
      }
      const id = req.id;
      const controller = id ? new AbortController() : undefined;
      if (id && controller) inflightExecutions.set(id, controller);
      try {
        return await execution.run(req, controller?.signal);
      } finally {
        if (id) inflightExecutions.delete(id);
      }
    },
    'request.cancel': (payload) => {
      inflightExecutions.get(payload.id)?.abort();
      return {};
    },

    'test.run': (payload) => testRunner.run(payload.response, payload.assertions),

    'script.run': (payload) =>
      runPostResponseScript({
        code: payload.script,
        response: payload.response,
        context: payload.context ?? {},
        variables: scriptVariables,
      }),

    'script.runPre': (payload) =>
      runPreRequestScript({
        code: payload.script,
        request: payload.request,
        context: payload.context ?? {},
        variables: scriptVariables,
      }),

    'version.snapshot': (request) => versioning.snapshot(request.collectionId, request.label),
    'version.list': (request) => versioning.listVersions(request.collectionId),
    'version.diff': (request) => versioning.diff(request.versionId),
    'version.get': (request) => versioning.getSnapshot(request.versionId),
    'version.restore': (request) => versioning.restore(request.versionId),

    'variable.list': (request) => variables.list(request.scope, request.scopeId),
    'variable.set': (request) =>
      variables.set({
        scope: request.scope,
        ...(request.scopeId !== undefined ? { scopeId: request.scopeId } : {}),
        key: request.key,
        value: request.value,
        ...(request.secret !== undefined ? { secret: request.secret } : {}),
      }),
    'variable.delete': (request) => {
      variables.delete(request.scope, request.key, request.scopeId);
      return {};
    },
    'variable.evaluate': (request) => ({
      value: variables.evaluate({
        template: request.template,
        ...(request.context !== undefined ? { context: request.context } : {}),
      }),
    }),
    'variable.resolvedKeys': (request) => variables.resolvedKeys(request.context),

    'workflow.list': (request) => workflows.list(request.projectId),
    'workflow.get': (request) => workflows.get(request.id),
    'workflow.create': (request) => workflows.create(request),
    'workflow.rename': (request) => workflows.rename(request.id, request.name),
    'workflow.save': (request) => workflows.save(request),
    'workflow.duplicate': (request) => workflows.duplicate(request.id),
    'workflow.delete': (request) => {
      workflows.delete(request.id);
      return {};
    },
    'workflow.export': (request) => workflows.exportWorkflow(request.id),
    'workflow.import': (request) => workflows.importWorkflow(request),
    'workflow.run': async (request) => {
      const controller = new RunController();
      inflightWorkflows.set(request.workflowId, controller);
      // Step mode: run the start node, then suspend before each node via workflow.step.
      if (request.stepMode) controller.startStepping();
      try {
        return await workflows.run(
          request,
          controller,
          (input) => awaitUserInput(input, controller),
          (event) => sendToRenderer('workflow.nodeProgress', event),
        );
      } finally {
        inflightWorkflows.delete(request.workflowId);
        // Drop any input that was still pending for this workflow.
        for (const key of [...pendingInputs.keys()]) {
          if (key.startsWith(`${request.workflowId}:`)) {
            pendingInputs.get(key)?.({ values: {}, cancelled: true });
          }
        }
      }
    },
    'workflow.cancel': (request) => {
      inflightWorkflows.get(request.id)?.cancel();
      return {};
    },
    'workflow.pause': (request) => {
      inflightWorkflows.get(request.id)?.pause();
      return {};
    },
    'workflow.resume': (request) => {
      inflightWorkflows.get(request.id)?.resume();
      return {};
    },
    'workflow.step': (request) => {
      inflightWorkflows.get(request.id)?.step();
      return {};
    },
    'workflow.provideInput': (request) => {
      pendingInputs.get(`${request.workflowId}:${request.nodeId}`)?.({
        values: request.values,
        cancelled: request.cancelled,
      });
      return {};
    },

    'preferences.get': (request) => ({ value: persistence.preferences.get(request.key) ?? null }),
    'preferences.set': (request) => {
      persistence.preferences.set(request.key, request.value);
      return {};
    },
    'preferences.list': () => persistence.preferences.list(),

    'plugins.list': () => ({ plugins: plugins.list() }),
    'plugins.inspect': (request) => plugins.inspect(request.path),
    'plugins.install': async (request) => {
      const installed = await plugins.install(request.path, request.grantedCapabilities);
      notifyPluginsChanged('installed');
      return installed;
    },
    'plugins.installDev': async (request) => {
      const installed = await plugins.installDev(request.path, request.grantedCapabilities);
      notifyPluginsChanged('installed');
      return installed;
    },
    'plugins.uninstall': async (request) => {
      await plugins.uninstall(request.id);
      notifyPluginsChanged('uninstalled');
      return {};
    },
    'plugins.setEnabled': async (request) => {
      const updated = await plugins.setEnabled(request.id, request.enabled);
      notifyPluginsChanged(request.enabled ? 'enabled' : 'disabled');
      return updated;
    },
    'plugins.contributions': () => plugins.contributions(),

    'backup.create': () => persistence.createBackup(),
    'backup.list': () => persistence.listBackups(),
    'backup.restore': (request) => persistence.restoreBackup(request.id),
  };

  for (const channel of Object.keys(IpcChannels) as IpcChannelName[]) {
    const spec = IpcChannels[channel];
    ipcMain.handle(channel, async (_event, rawRequest: unknown) => {
      const parsed = spec.request.safeParse(rawRequest);
      if (!parsed.success) {
        logger.warn('ipc', `Rejected invalid request on "${channel}"`, {
          issues: parsed.error.issues,
        });
        throw new Error(`Invalid IPC request payload for "${channel}"`);
      }
      let result: unknown;
      try {
        result = await handlers[channel](parsed.data as never);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('ipc', `Handler for "${channel}" failed`, { message });
        throw error;
      }
      const validated = spec.response.safeParse(result);
      if (!validated.success) {
        logger.error('ipc', `Handler for "${channel}" produced an invalid response`, {
          issues: validated.error.issues,
        });
        throw new Error(`Invalid IPC response payload for "${channel}"`);
      }
      return validated.data;
    });
  }
  logger.info('ipc', 'IPC handlers registered', { channels: Object.keys(IpcChannels).length });
}

/**
 * Streams dispatch events from the logger to a renderer window. The returned
 * disposer detaches the listener (call on window close).
 */
export function attachDispatchStream(window: BrowserWindow): () => void {
  const forward = (event: DispatchEvent): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('dispatch.event', event);
    }
  };
  logger.on('event', forward);
  logger.info('app', 'Dispatch stream attached to window', { traceId: randomUUID() });
  return () => logger.off('event', forward);
}
