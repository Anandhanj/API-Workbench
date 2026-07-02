import type { Migration } from './types';
import { migration0001 } from './0001-initial';
import { migration0002 } from './0002-collections';
import { migration0003 } from './0003-sync';
import { migration0004 } from './0004-versions';
import { migration0005 } from './0005-variables';
import { migration0006 } from './0006-auth';
import { migration0007 } from './0007-request-details';
import { migration0008 } from './0008-collection-source-url';
import { migration0009 } from './0009-workflows';
import { migration0010 } from './0010-request-type';
import { migration0011 } from './0011-plugins';
import { migration0012 } from './0012-folder-auth';

export type { Migration } from './types';

/**
 * The ordered list of all migrations. Append new migrations here with the next
 * version number; never edit or reorder an already-released migration.
 */
export const MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
];
