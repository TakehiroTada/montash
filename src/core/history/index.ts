/**
 * git ライク履歴モデル（docs/11）の公開 API。
 */

export {
  ancestors,
  buildIndex,
  type ChildChoice,
  childrenOf,
  descendants,
  headEvents,
  isAncestor,
  isValidTagName,
  type OpIndex,
  pathToRoot,
  preferredChild,
  RESERVED_REFS,
  type RefContext,
  type ResolvedRef,
  resolveRef,
  suggest,
  tipOf,
} from "./dag.ts";
export {
  applyChanges,
  deepEqual,
  diffJson,
  escapeToken,
  extractAffects,
  findConflicts,
  getAt,
  invertChanges,
  parsePointer,
  summarizeChanges,
  unescapeToken,
} from "./diff.ts";
export { canonicalHash, canonicalJson, type HashFn } from "./hash.ts";
export {
  autoMessage,
  type BlameHit,
  type CommitInput,
  computeStats,
  type ExportResult,
  History,
  type HistoryOptions,
  type ImportResult,
  type LogEntry,
  type LogOptions,
  type LogResult,
  type MoveResult,
  type PruneOptions,
  type PruneResult,
  type RecordOpInput,
  type RecordOpResult,
  type ResetResult,
  type RevertResult,
  type ShowResult,
  type TagEntry,
  type VerifyResult,
} from "./history.ts";
export { formatId, HISTORY_DIR, HistoryStore, type HistoryStoreOptions } from "./store.ts";
export * from "./types.ts";
