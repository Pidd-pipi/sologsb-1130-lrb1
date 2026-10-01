/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { framesToDuration } from '../utils/frameMath';
import { mergeFrameSnapshots, type MergeResolutions } from '../utils/frameMerge';
import type { FrameMergeResult } from '../types/frameMerge';

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/** 保存时帧序修订号已变化：调用方需要展示冲突，不能继续写入旧快照 */
export class StaleFrameRevisionError extends Error {
  merge: FrameMergeResult;

  constructor(merge: FrameMergeResult) {
    super('帧序修订号已过期');
    this.name = 'StaleFrameRevisionError';
    this.merge = merge;
  }
}

export interface CommitFrameSequenceInput {
  shotId: number;
  expectedRevision: number;
  baseFrames: FrameEntry[];
  localFrames: FrameEntry[];
  /** 用户在冲突面板中看到的远端修订号，重试时必须仍为当前值 */
  expectedCurrentRevision?: number;
  resolutions?: MergeResolutions;
}

export interface CommitFrameSequenceResult {
  shot: Shot;
  frames: FrameEntry[];
  revision: number;
  merge: FrameMergeResult;
}

/**
 * 一次性提交帧序：核对修订号、必要时三方合并，再在同一事务中替换帧条目、
 * 更新镜头帧区间/时长并递增修订号。事务中止时 IndexedDB 自动回滚原帧序。
 */
export async function commitFrameSequence(input: CommitFrameSequenceInput): Promise<CommitFrameSequenceResult> {
  const resolutions = input.resolutions ?? {};
  const hasResolutions = Object.keys(resolutions).length > 0;
  const timestamp = Date.now();

  return db.transaction('rw', db.shots, db.frames, async () => {
    const shot = await db.shots.get(input.shotId);
    if (!shot) throw new Error('镜头不存在，无法保存帧序');

    const remoteFrames = await db.frames.where('shotId').equals(input.shotId).toArray();
    remoteFrames.sort((a, b) => a.frameNo - b.frameNo);
    const currentRevision = shot.frameRevision ?? 1;

    const basePlain = toPlain(input.baseFrames);
    const localPlain = toPlain(input.localFrames);
    const merge = mergeFrameSnapshots(basePlain, localPlain, remoteFrames, input.expectedRevision, currentRevision, resolutions);

    const revisionMovedDuringReview =
      hasResolutions &&
      typeof input.expectedCurrentRevision === 'number' &&
      input.expectedCurrentRevision !== currentRevision;

    if (currentRevision !== input.expectedRevision && merge.status === 'conflict' && (!hasResolutions || revisionMovedDuringReview)) {
      throw new StaleFrameRevisionError(merge);
    }

    const startFrame = Number.isFinite(shot.startFrame) && shot.startFrame >= 1 ? Math.floor(shot.startFrame) : 1;
    const frames = merge.mergedFrames.map((frame, index) => {
      const stored = toPlain({
        ...frame,
        id: typeof frame.id === 'number' && frame.id > 0 ? frame.id : undefined,
        shotId: input.shotId,
        frameNo: startFrame + index,
        updatedAt: timestamp,
      });
      return stored;
    });

    await db.frames.where('shotId').equals(input.shotId).delete();
    if (frames.length) await db.frames.bulkAdd(frames);

    const nextRevision = currentRevision + 1;
    const durationSec = framesToDuration(Math.max(1, frames.length), shot.fps);
    const nextShot: Shot = {
      ...shot,
      startFrame,
      endFrame: startFrame + Math.max(1, frames.length) - 1,
      durationSec,
      frameRevision: nextRevision,
      updatedAt: timestamp,
    };
    await db.shots.put(toPlain(nextShot));

    return {
      shot: nextShot,
      frames: await db.frames.where('shotId').equals(input.shotId).toArray(),
      revision: nextRevision,
      merge,
    };
  });
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function getShot(id: number): Promise<Shot | undefined> {
  return db.shots.get(id);
}

export async function addShot(shot: Shot): Promise<number> {
  return db.shots.add(toPlain(shot));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  const { frameRevision, ...rest } = patch;
  await db.shots.update(
    id,
    toPlain({
      ...rest,
      ...(typeof frameRevision === 'number' ? { frameRevision } : {}),
      updatedAt: Date.now(),
    }),
  );
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.shots.delete(id);
  });
}

/* ---------------- frames ---------------- */

export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  return db.frames.toArray();
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain(frame));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(f)));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function updateFrames(rows: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    for (const row of rows) {
      if (typeof row.id !== 'number') continue;
      const { id, ...rest } = row;
      await db.frames.update(id, toPlain({ ...rest, updatedAt: Date.now() }));
    }
  });
}

export async function deleteFrame(id: number): Promise<void> {
  await db.frames.delete(id);
}

export async function replaceShotFrames(shotId: number, frames: FrameEntry[]): Promise<void> {
  const plain = frames.map((f) => toPlain(f));
  await db.transaction('rw', db.frames, async () => {
    await db.frames.where('shotId').equals(shotId).delete();
    if (plain.length) await db.frames.bulkAdd(plain);
  });
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  return db.props.toArray();
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(prop));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  await db.props.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/* ---------------- takes ---------------- */

export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  return db.takes.where('shotId').equals(shotId).toArray();
}

export async function addTake(take: TakeLog): Promise<number> {
  return db.takes.add(toPlain(take));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}
