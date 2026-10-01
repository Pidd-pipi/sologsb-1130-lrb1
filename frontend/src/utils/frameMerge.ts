/**
 * 帧序三方合并：base 为打开镜头时的快照，local 为本标签页编辑结果，
 * remote 为保存前从 IndexedDB 读到的最新帧序。
 */
import type { FrameEntry } from '../types/frame';
import {
  FRAME_FIELD_LABELS,
  FRAME_MERGE_FIELDS,
  type FieldConflict,
  type FrameConflict,
  type FrameConflictResolution,
  type FrameMergeResult,
  type MergeableFrameField,
  type OrderConflict,
  type PresenceConflict,
} from '../types/frameMerge';

export type MergeResolutions = Record<string, FrameConflictResolution>;

function cloneFrames(frames: FrameEntry[]): FrameEntry[] {
  return JSON.parse(JSON.stringify(frames)) as FrameEntry[];
}

function sortFrames(frames: FrameEntry[]): FrameEntry[] {
  return cloneFrames(frames).sort((a, b) => a.frameNo - b.frameNo);
}

function idOf(frame: FrameEntry): number {
  return typeof frame.id === 'number' ? frame.id : 0;
}

function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

function frameLabel(frame: FrameEntry | undefined, id: number): string {
  if (!frame) return id < 0 ? '本地新帧' : `帧条目 #${id}`;
  return id < 0 ? `本地新帧（当前位次 ${frame.frameNo}）` : `帧条目 #${id}（打开时第 ${frame.frameNo} 帧）`;
}

function byId(frames: FrameEntry[]): Map<number, FrameEntry> {
  return new Map(frames.map((frame) => [idOf(frame), frame]));
}

function idsOf(frames: FrameEntry[]): number[] {
  return frames.map(idOf);
}

function equalOrder(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function conflictKey(conflict: FrameConflict): string {
  return conflict.type === 'field'
    ? `field:${conflict.frameId}:${conflict.field}`
    : conflict.type === 'presence'
      ? `presence:${conflict.frameId}`
      : 'order:sequence';
}

function choiceOf(resolutions: MergeResolutions, key: string): FrameConflictResolution {
  return resolutions[key] === 'remote' ? 'remote' : 'local';
}

/** 找出一次“移动单帧”的 id；无法安全判定时返回 null。 */
function findSingleMovedFrame(baseOrder: number[], nextOrder: number[]): number | null {
  if (baseOrder.length !== nextOrder.length) return null;
  const candidates = baseOrder.filter((id, index) => id !== nextOrder[index]);
  if (!candidates.length) return null;

  for (const id of candidates) {
    const withoutBase = baseOrder.filter((item) => item !== id);
    const withoutNext = nextOrder.filter((item) => item !== id);
    if (equalOrder(withoutBase, withoutNext)) return id;
  }
  return null;
}

/** 在已经应用本地移动的序列上，按远端拖拽目标位次再应用一次单帧移动。 */
function applyRemoteMove(order: number[], movedId: number, remoteOrder: number[]): number[] {
  const next = order.filter((id) => id !== movedId);
  next.splice(remoteOrder.indexOf(movedId), 0, movedId);
  return next;
}

function makeFieldConflict(
  base: FrameEntry,
  local: FrameEntry,
  remote: FrameEntry,
  field: MergeableFrameField,
  resolutions: MergeResolutions,
): FieldConflict {
  const key = `field:${idOf(base)}:${field}`;
  return {
    type: 'field',
    frameId: idOf(base),
    frameLabel: frameLabel(base, idOf(base)),
    field,
    fieldLabel: FRAME_FIELD_LABELS[field],
    baseValue: base[field],
    localValue: local[field],
    remoteValue: remote[field],
    choice: choiceOf(resolutions, key) as FieldConflict['choice'],
  };
}

function makePresenceConflict(params: {
  id: number;
  labelFrame?: FrameEntry;
  localHasFrame: boolean;
  localLabel: string;
  remoteLabel: string;
  resolutions: MergeResolutions;
}): PresenceConflict {
  const key = `presence:${params.id}`;
  return {
    type: 'presence',
    frameId: params.id,
    frameLabel: frameLabel(params.labelFrame, params.id),
    localHasFrame: params.localHasFrame,
    localLabel: params.localLabel,
    remoteLabel: params.remoteLabel,
    choice: choiceOf(params.resolutions, key) as PresenceConflict['choice'],
  };
}

export function mergeFrameSnapshots(
  baseFrames: FrameEntry[],
  localFrames: FrameEntry[],
  remoteFrames: FrameEntry[],
  baseRevision: number,
  currentRevision: number,
  resolutions: MergeResolutions = {},
): FrameMergeResult {
  const base = sortFrames(baseFrames);
  const local = sortFrames(localFrames);
  const remote = sortFrames(remoteFrames);
  const baseMap = byId(base);
  const localMap = byId(local);
  const remoteMap = byId(remote);
  const baseIds = idsOf(base);
  const localIds = idsOf(local);
  const remoteIds = idsOf(remote);

  const baseIdSet = new Set(baseIds);
  const localIdSet = new Set(localIds);
  const remoteIdSet = new Set(remoteIds);

  const commonIds = baseIds.filter((id) => localIdSet.has(id) && remoteIdSet.has(id));
  const localAddedIds = localIds.filter((id) => !baseIdSet.has(id));
  const remoteAddedIds = remoteIds.filter((id) => !baseIdSet.has(id));
  const localDeletedIds = baseIds.filter((id) => !localIdSet.has(id) && remoteIdSet.has(id));
  const remoteDeletedIds = baseIds.filter((id) => localIdSet.has(id) && !remoteIdSet.has(id));

  const conflicts: FrameConflict[] = [];

  // 同一帧的同一字段双方都改且值不同，需要人工二选一。
  for (const id of commonIds) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    if (!b || !l || !r) continue;
    for (const field of FRAME_MERGE_FIELDS) {
      if (!sameValue(b[field], l[field]) && !sameValue(b[field], r[field]) && !sameValue(l[field], r[field])) {
        conflicts.push(makeFieldConflict(b, l, r, field, resolutions));
      }
    }
  }

  // 删除 / 保留冲突。
  for (const id of localDeletedIds) {
    conflicts.push(
      makePresenceConflict({
        id,
        labelFrame: baseMap.get(id) ?? remoteMap.get(id),
        localHasFrame: false,
        localLabel: '采用本地：删除该帧',
        remoteLabel: '采用远端：保留远端修改',
        resolutions,
      }),
    );
  }
  for (const id of remoteDeletedIds) {
    conflicts.push(
      makePresenceConflict({
        id,
        labelFrame: baseMap.get(id) ?? localMap.get(id),
        localHasFrame: true,
        localLabel: '采用本地：保留本地修改',
        remoteLabel: '采用远端：删除该帧',
        resolutions,
      }),
    );
  }

  const localStructural = localAddedIds.length > 0 || localDeletedIds.length > 0;
  const remoteStructural = remoteAddedIds.length > 0 || remoteDeletedIds.length > 0;
  const localOrderChanged = !equalOrder(baseIds, localIds);
  const remoteOrderChanged = !equalOrder(baseIds, remoteIds);

  let mergedOrder: number[];
  let autoMergedMoves = false;

  const localMoved = !localStructural && localOrderChanged ? findSingleMovedFrame(baseIds, localIds) : null;
  const remoteMoved = !remoteStructural && remoteOrderChanged ? findSingleMovedFrame(baseIds, remoteIds) : null;
  const canAutoMergeMoves =
    !localStructural &&
    !remoteStructural &&
    localOrderChanged &&
    remoteOrderChanged &&
    localMoved !== null &&
    remoteMoved !== null &&
    localMoved !== remoteMoved;

  if (canAutoMergeMoves) {
    mergedOrder = applyRemoteMove(localIds, remoteMoved as number, remoteIds);
    autoMergedMoves = true;
  } else {
    const bothChangedSequences = (localStructural || localOrderChanged) && (remoteStructural || remoteOrderChanged);
    if (bothChangedSequences) {
      const labels: Record<string, string> = {};
      for (const id of new Set([...baseIds, ...localIds, ...remoteIds])) {
        labels[String(id)] = frameLabel(localMap.get(id) ?? remoteMap.get(id) ?? baseMap.get(id), id);
      }
      const key = 'order:sequence';
      conflicts.push({
        type: 'order',
        message:
          localStructural || remoteStructural
            ? '双方帧序结构都已变化，需选择一版作为帧序骨架'
            : '双方移动了同一帧或移动方式无法自动叠加，需选择一版帧序',
        localOrder: localIds,
        remoteOrder: remoteIds,
        labels,
        choice: choiceOf(resolutions, key) as OrderConflict['choice'],
      } satisfies OrderConflict);
      mergedOrder = resolutions[key] === 'remote' ? remoteIds : localIds;
    } else if (localStructural || localOrderChanged) {
      mergedOrder = localIds;
    } else {
      mergedOrder = remoteIds;
    }
  }

  const fieldConflicts = new Map(
    conflicts.filter((c): c is FieldConflict => c.type === 'field').map((c) => [`${c.frameId}:${c.field}`, c]),
  );
  const presenceConflicts = new Map(
    conflicts.filter((c): c is PresenceConflict => c.type === 'presence').map((c) => [c.frameId, c]),
  );

  // 新增帧默认双方都保留；基础帧的删除/保留由冲突选项决定。
  const selectedOrder = [...mergedOrder];
  for (const id of [...localAddedIds, ...remoteAddedIds]) {
    if (!selectedOrder.includes(id)) selectedOrder.push(id);
  }

  const includeIds = selectedOrder.filter((id) => {
    if (!baseIdSet.has(id)) return true;
    const presence = presenceConflicts.get(id);
    if (!presence) return localIdSet.has(id) || remoteIdSet.has(id);
    if (presence.localHasFrame) return presence.choice === 'local';
    return presence.choice === 'remote';
  });

  const mergedFrames = includeIds
    .map((id, index) => {
      const b = baseMap.get(id);
      const l = localMap.get(id);
      const r = remoteMap.get(id);

      if (b && l && r) {
        const merged: FrameEntry = { ...l, frameNo: index + 1, updatedAt: Date.now() };
        for (const field of FRAME_MERGE_FIELDS) {
          const conflict = fieldConflicts.get(`${id}:${field}`);
          if (conflict) {
            Object.assign(merged, { [field]: conflict.choice === 'local' ? l[field] : r[field] } satisfies Partial<FrameEntry>);
          } else if (!sameValue(b[field], l[field])) {
            Object.assign(merged, { [field]: l[field] } satisfies Partial<FrameEntry>);
          } else if (!sameValue(b[field], r[field])) {
            Object.assign(merged, { [field]: r[field] } satisfies Partial<FrameEntry>);
          } else {
            Object.assign(merged, { [field]: b[field] } satisfies Partial<FrameEntry>);
          }
        }
        return merged;
      }
      const source = l ?? r ?? b;
      return source ? { ...source, frameNo: index + 1, updatedAt: Date.now() } : undefined;
    })
    .filter((frame): frame is FrameEntry => Boolean(frame));

  const hasConflict = conflicts.length > 0;
  return {
    status: hasConflict ? 'conflict' : 'merged',
    baseRevision,
    currentRevision,
    mergedFrames,
    conflicts,
    message: autoMergedMoves
      ? '已自动合并双方对不同帧的移动'
      : hasConflict
        ? '帧序已被另一标签页修改，请核对冲突帧与字段后确认'
        : '已自动合并非冲突修改',
  };
}
