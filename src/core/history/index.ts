/**
 * git ライク履歴モデル（docs/11）の公開 API。
 */

export * from "./types.ts";
export { canonicalJson, canonicalHash, type HashFn } from "./hash.ts";
export { HistoryStore, HISTORY_DIR, formatId, type HistoryStoreOptions } from "./store.ts";
export {
  buildIndex,
  childrenOf,
  pathToRoot,
  ancestors,
  descendants,
  isAncestor,
  tipOf,
  preferredChild,
  headEvents,
  resolveRef,
  isValidTagName,
  suggest,
  RESERVED_REFS,
  type OpIndex,
  type ChildChoice,
  type RefContext,
  type ResolvedRef,
} from "./dag.ts";
export {
  diffJson,
  applyChanges,
  findConflicts,
  invertChanges,
  summarizeChanges,
  extractAffects,
  deepEqual,
  getAt,
  parsePointer,
  escapeToken,
  unescapeToken,
} from "./diff.ts";
export {
  History,
  autoMessage,
  computeStats,
  type HistoryOptions,
  type RecordOpInput,
  type RecordOpResult,
  type CommitInput,
  type MoveResult,
  type LogOptions,
  type LogEntry,
  type LogResult,
  type ShowResult,
  type RevertResult,
  type VerifyResult,
  type TagEntry,
} from "./history.ts";
