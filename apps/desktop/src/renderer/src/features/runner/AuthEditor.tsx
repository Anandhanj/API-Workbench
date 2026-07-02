import type { AuthConfig, AuthType } from '@shared/auth';
import { formDefaults } from '@shared/forms';
import { qualifiedContributionId } from '@shared/plugins';
import type { ResolvedKey } from '@shared/variable';
import { SchemaForm } from '../../components/forms/SchemaForm';
import { usePluginContributions } from '../plugins/use-plugins';
import { VariableField } from '../variables/VariableField';
import type { EditorAuthConfig, PluginAuthConfig } from './build-request';

export interface AuthEditorProps {
  auth: EditorAuthConfig;
  onChange: (auth: EditorAuthConfig) => void;
  suggestions?: ResolvedKey[];
  /**
   * When set, offer an "Inherit from parent" option. Requests and nested folders
   * enable this so they can defer to their parent folder's authorization; the
   * effective config is resolved in the main process at execution time.
   */
  allowInherit?: boolean;
}

const TYPES: { value: AuthType; label: string }[] = [
  { value: 'none', label: 'No Auth' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'apiKey', label: 'API Key' },
  { value: 'oauth2', label: 'OAuth 2.0' },
];

const INHERIT_TYPE: { value: AuthType; label: string } = {
  value: 'inherit',
  label: 'Inherit from parent',
};

function defaultFor(type: AuthType): AuthConfig {
  switch (type) {
    case 'inherit':
      return { type: 'inherit' };
    case 'bearer':
      return { type: 'bearer', token: '' };
    case 'basic':
      return { type: 'basic', username: '', password: '' };
    case 'apiKey':
      return { type: 'apiKey', key: '', value: '', in: 'header' };
    case 'oauth2':
      return { type: 'oauth2', accessToken: '', headerPrefix: 'Bearer' };
    default:
      return { type: 'none' };
  }
}

const field = 'w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm';

/** Authorization tab: scheme selector + variable-aware fields for each scheme. */
export function AuthEditor({
  auth,
  onChange,
  suggestions = [],
  allowInherit = false,
}: AuthEditorProps): JSX.Element {
  const types = allowInherit ? [TYPES[0], INHERIT_TYPE, ...TYPES.slice(1)] : TYPES;
  const contributions = usePluginContributions();
  const providers = contributions.authProviders;
  // A qualified plugin type narrows to its provider; everything else is built-in.
  const provider = auth.type.startsWith('plugin:')
    ? providers.find((p) => qualifiedContributionId(p.pluginId, p.type) === auth.type)
    : undefined;
  const builtin = auth.type.startsWith('plugin:') ? null : (auth as AuthConfig);

  const selectType = (value: string): void => {
    const next = providers.find((p) => qualifiedContributionId(p.pluginId, p.type) === value);
    if (next) {
      onChange({ type: value, ...formDefaults(next.configSchema) });
    } else {
      onChange(defaultFor(value as AuthType));
    }
  };

  // Form values for a plugin provider: the config minus its discriminator.
  const { type: _type, ...pluginValues } = auth as PluginAuthConfig;

  return (
    <div className="space-y-3">
      <select
        aria-label="Auth type"
        value={auth.type}
        onChange={(e) => selectType(e.target.value)}
        className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
      >
        {types.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
        {providers.map((p) => {
          const qualified = qualifiedContributionId(p.pluginId, p.type);
          return (
            <option key={qualified} value={qualified}>
              {p.label}
            </option>
          );
        })}
      </select>

      {builtin?.type === 'bearer' && (
        <VariableField className={field} aria-label="Token" placeholder="Token (supports {{vars}})" suggestions={suggestions} value={builtin.token} onChange={(v) => onChange({ ...builtin, token: v })} />
      )}
      {builtin?.type === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
          <VariableField className={field} aria-label="Username" placeholder="Username" suggestions={suggestions} value={builtin.username} onChange={(v) => onChange({ ...builtin, username: v })} />
          <VariableField className={field} aria-label="Password" placeholder="Password" suggestions={suggestions} value={builtin.password} onChange={(v) => onChange({ ...builtin, password: v })} />
        </div>
      )}
      {builtin?.type === 'apiKey' && (
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <VariableField className={field} aria-label="Key" placeholder="Key" suggestions={suggestions} value={builtin.key} onChange={(v) => onChange({ ...builtin, key: v })} />
          <VariableField className={field} aria-label="Value" placeholder="Value" suggestions={suggestions} value={builtin.value} onChange={(v) => onChange({ ...builtin, value: v })} />
          <select className="rounded-md border border-border bg-bg px-2 text-sm" aria-label="Add to" value={builtin.in} onChange={(e) => onChange({ ...builtin, in: e.target.value as 'header' | 'query' })}>
            <option value="header">Header</option>
            <option value="query">Query</option>
          </select>
        </div>
      )}
      {builtin?.type === 'oauth2' && (
        <VariableField className={field} aria-label="Access token" placeholder="Access token" suggestions={suggestions} value={builtin.accessToken} onChange={(v) => onChange({ ...builtin, accessToken: v })} />
      )}
      {builtin?.type === 'none' && <p className="text-sm text-muted">This request does not use authorization.</p>}
      {builtin?.type === 'inherit' && (
        <p className="text-sm text-muted">
          Uses the authorization set on the parent folder. If that folder also inherits, the setting
          is taken from the next folder up, and so on.
        </p>
      )}

      {provider && (
        <>
          <SchemaForm
            schema={provider.configSchema}
            value={pluginValues}
            onChange={(values) => onChange({ ...values, type: auth.type })}
          />
          <p className="text-[11px] text-muted">From plugin: {provider.pluginName}</p>
        </>
      )}
      {!provider && !builtin && (
        <p className="text-sm text-muted">
          This request uses a plugin auth type ({auth.type}) that is not currently available.
        </p>
      )}
    </div>
  );
}
