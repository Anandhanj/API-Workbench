import { join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import appIcon from '../../resources/icon.png?asset';
import { registerIpcHandlers, attachDispatchStream } from './ipc';
import { logger } from './services/logger';
import { FileLogSink } from './services/file-log-sink';
import { createBetterSqliteConnection, PersistenceService } from './persistence';
import { WorkspaceManager } from './workspace';
import { CollectionExplorer } from './collections';
import { ImportService, SyncService } from './openapi';
import { VersioningService } from './versioning';
import { VariableService, SafeStorageEncryptor } from './variables';
import { AuthService } from './auth';
import { ExecutionService, FetchTransport } from './execution';
import { TestRunner } from './testing';
import { WorkflowService } from './workflows';

/**
 * Main process entry point.
 *
 * Owns the application lifecycle, opens the local database, composes the
 * application services, and creates the single hardened BrowserWindow. Security
 * posture (ADR-0003): context isolation on, node integration off, sandbox on,
 * navigation and new-window creation blocked by default.
 */

const isDev = !app.isPackaged;
const RENDERER_DEV_URL = process.env['ELECTRON_RENDERER_URL'];

let persistence: PersistenceService | undefined;

interface Services {
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
}

function initServices(): Services {
  const userData = app.getPath('userData');
  const dbPath = join(userData, 'data', 'workbench.db');
  const backupDir = join(userData, 'backups');
  const connection = createBetterSqliteConnection(dbPath);
  const service = new PersistenceService(connection, {
    backupDir,
    appVersion: app.getVersion(),
    log: (level, message, context) => logger.log(level, 'persistence', message, context),
  });
  persistence = service;
  logger.info('persistence', 'Database ready', {
    schemaVersion: service.schemaVersion(),
    dbPath,
  });
  const collections = new CollectionExplorer(service);
  const variables = new VariableService(service, new SafeStorageEncryptor());
  const auth = new AuthService(service, new SafeStorageEncryptor());
  const execution = new ExecutionService(new FetchTransport(), {
    evaluate: (template, context) => variables.evaluate({ template, context }),
  });
  // Workflow nodes reuse the execution and variable engines: request nodes run
  // through the same execution path (with stored-credential resolution), and
  // set-variable nodes evaluate templates against the run's variable context.
  const workflows = new WorkflowService(service, {
    executeRequest: (config, ctx, signal) => {
      const cfg =
        config.credentialId && !config.auth
          ? { ...config, auth: auth.getConfig(config.credentialId) }
          : config;
      return execution.run(
        {
          ...cfg,
          variableContext: {
            ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
            workflowId: ctx.workflowId,
            runtime: ctx.runtime,
          },
        },
        signal,
      );
    },
    evaluate: (template, ctx) =>
      variables.evaluate({
        template,
        context: {
          ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
          workflowId: ctx.workflowId,
          runtime: ctx.runtime,
        },
      }),
    setVariable: (scope, key, value, ctx) =>
      variables.set({
        scope,
        ...(scope === 'workspace' && ctx.workspaceId ? { scopeId: ctx.workspaceId } : {}),
        key,
        value,
      }),
    appVersion: app.getVersion(),
  });
  return {
    persistence: service,
    workspaces: new WorkspaceManager(service, { appVersion: app.getVersion() }),
    collections,
    imports: new ImportService(service),
    sync: new SyncService(service),
    versioning: new VersioningService(service),
    variables,
    auth,
    execution,
    testRunner: new TestRunner(),
    workflows,
  };
}

/** Presents a fatal startup error clearly instead of crashing with an unhandled rejection. */
function handleFatalStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('app', 'Fatal startup error', { message });

  const isAbiMismatch = /NODE_MODULE_VERSION|was compiled against a different Node/i.test(message);
  const hint = isAbiMismatch
    ? '\n\nThe native SQLite module was built for a different runtime. ' +
      'Rebuild it for Electron by running:\n\n  npm run rebuild:native\n\n' +
      '(or: npx @electron/rebuild -f -w better-sqlite3)'
    : '';

  dialog.showErrorBox('API Workbench failed to start', `${message}${hint}`);
  app.quit();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'API Workbench',
    // Windows takes the taskbar icon from the packaged exe; on Linux (and dev)
    // the window/taskbar icon comes from here. macOS uses the .app bundle icon.
    ...(process.platform !== 'darwin' ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
    logger.info('app', 'Main window shown');
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (RENDERER_DEV_URL && url.startsWith(RENDERER_DEV_URL)) return;
    event.preventDefault();
    logger.warn('app', 'Blocked in-app navigation', { url });
  });

  const detach = attachDispatchStream(window);
  window.on('closed', detach);

  if (isDev && RENDERER_DEV_URL) {
    void window.loadURL(RENDERER_DEV_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

app.whenReady().then(() => {
  try {
    // Start persistent file logging first so everything below — including a fatal
    // startup error — is captured to disk for debugging.
    const logDir = app.getPath('logs');
    const sink = new FileLogSink(logDir);
    sink.attach(logger);
    logger.info('app', 'File logging started', { file: sink.filePath });

    const services = initServices();
    registerIpcHandlers(services, { logFilePath: () => sink.filePath });
    logger.info('app', 'Application ready', {
      version: app.getVersion(),
      platform: process.platform,
    });
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  } catch (error) {
    handleFatalStartupError(error);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  persistence?.close();
});

process.on('uncaughtException', (error) => {
  logger.error('app', 'Uncaught exception in main process', {
    message: error.message,
    stack: error.stack,
  });
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : undefined;
  logger.error('app', 'Unhandled promise rejection in main process', {
    message: error?.message ?? String(reason),
    stack: error?.stack,
  });
});
