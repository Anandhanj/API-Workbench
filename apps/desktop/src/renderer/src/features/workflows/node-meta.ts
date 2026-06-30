import {
  CircleDot,
  Flag,
  FormInput,
  GitBranch,
  Hourglass,
  Repeat,
  Send,
  Split,
  Variable,
  Wand2,
  Workflow,
} from 'lucide-react';
import type { WorkflowNode, WorkflowNodeKind } from '@shared/workflow';

/**
 * Presentation + default-construction metadata for each node kind. Keeping this
 * in one table lets the palette, the canvas node renderer, and the inspector all
 * agree on labels, icons, and the shape of a freshly-dropped node's config.
 */
export interface NodeKindMeta {
  kind: WorkflowNodeKind;
  label: string;
  description: string;
  icon: typeof Send;
  /** Tailwind accent classes for the node header. */
  accent: string;
  /** Can the user add this kind from the palette? (start is implicit.) */
  addable: boolean;
  /** Builds the default config for a newly added node of this kind. */
  defaultConfig: () => WorkflowNode['config'];
}

export const NODE_META: Record<WorkflowNodeKind, NodeKindMeta> = {
  start: {
    kind: 'start',
    label: 'Start',
    description: 'Entry point of the workflow.',
    icon: CircleDot,
    accent: 'bg-emerald-500/15 text-emerald-400',
    addable: false,
    defaultConfig: () => ({}),
  },
  request: {
    kind: 'request',
    label: 'Request',
    description: 'Send an HTTP request.',
    icon: Send,
    accent: 'bg-sky-500/15 text-sky-400',
    addable: true,
    defaultConfig: () => ({
      method: 'GET',
      url: '',
      headers: {},
      query: {},
      body: { type: 'none' },
    }),
  },
  condition: {
    kind: 'condition',
    label: 'Condition',
    description: 'Branch on a condition (==, >, contains, && …).',
    icon: GitBranch,
    accent: 'bg-teal-500/15 text-teal-400',
    addable: true,
    defaultConfig: () => ({ expression: '' }),
  },
  switch: {
    kind: 'switch',
    label: 'Switch',
    description: 'Branch by matching a value to cases.',
    icon: Split,
    accent: 'bg-cyan-500/15 text-cyan-400',
    addable: true,
    defaultConfig: () => ({ value: '', cases: [] }),
  },
  loop: {
    kind: 'loop',
    label: 'Loop',
    description: 'Repeat a body branch.',
    icon: Repeat,
    accent: 'bg-indigo-500/15 text-indigo-400',
    addable: true,
    defaultConfig: () => ({ mode: 'times', times: 3 }),
  },
  'set-variable': {
    kind: 'set-variable',
    label: 'Set Variable',
    description: 'Write a runtime variable.',
    icon: Variable,
    accent: 'bg-violet-500/15 text-violet-400',
    addable: true,
    defaultConfig: () => ({ key: '', value: '' }),
  },
  transform: {
    kind: 'transform',
    label: 'Transform',
    description: 'Map or extract a value into a variable.',
    icon: Wand2,
    accent: 'bg-lime-500/15 text-lime-400',
    addable: true,
    defaultConfig: () => ({ variable: '', engine: 'template', input: '', expression: '' }),
  },
  delay: {
    kind: 'delay',
    label: 'Delay',
    description: 'Wait for a fixed duration.',
    icon: Hourglass,
    accent: 'bg-amber-500/15 text-amber-400',
    addable: true,
    defaultConfig: () => ({ ms: 1000 }),
  },
  'sub-workflow': {
    kind: 'sub-workflow',
    label: 'Sub-workflow',
    description: 'Run another workflow.',
    icon: Workflow,
    accent: 'bg-fuchsia-500/15 text-fuchsia-400',
    addable: true,
    defaultConfig: () => ({ workflowId: '' }),
  },
  'user-input': {
    kind: 'user-input',
    label: 'User Input',
    description: 'Pause and prompt the user for values.',
    icon: FormInput,
    accent: 'bg-orange-500/15 text-orange-400',
    addable: true,
    defaultConfig: () => ({ message: '', fields: [] }),
  },
  end: {
    kind: 'end',
    label: 'End',
    description: 'Terminate the workflow.',
    icon: Flag,
    accent: 'bg-rose-500/15 text-rose-400',
    addable: true,
    defaultConfig: () => ({}),
  },
};

/** Node kinds offered in the palette, in display order. */
export const PALETTE_KINDS: WorkflowNodeKind[] = [
  'request',
  'condition',
  'switch',
  'loop',
  'set-variable',
  'transform',
  'delay',
  'user-input',
  'sub-workflow',
  'end',
];
