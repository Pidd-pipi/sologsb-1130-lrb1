/**
 * 帧序编排：插入 / 删除 / 移动帧并重排帧序号，显式保存时联动镜头帧区间。
 * 被 /frames 与 /shots/:id 消费。
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useFrameStore } from '../stores/frameStore';
import { useShotStore } from '../stores/shotStore';
import { durationToFrames, framesToDuration } from '../utils/frameMath';
import type { BatchExposure, FrameEntry } from '../types/frame';
import type { FrameConflictResolution } from '../types/frameMerge';
import { conflictKey, type MergeResolutions } from '../utils/frameMerge';

export function useFrameSequence() {
  const frameStore = useFrameStore();
  const shotStore = useShotStore();
  const { frames, selectedFrameNo, dirty, baseRevision, currentRevision, saving, conflict, saveError } =
    storeToRefs(frameStore);

  const shotId = computed(() => frameStore.shotId);
  const shot = computed(() => (shotId.value === null ? undefined : shotStore.byId(shotId.value)));
  const fps = computed(() => shot.value?.fps ?? 24);
  const frameCount = computed(() => frames.value.length);
  const totalDuration = computed(() => framesToDuration(frameCount.value, fps.value));
  const plannedFrames = computed(() => durationToFrames(shot.value?.durationSec ?? 0, fps.value));

  function insertAfter(frameNo: number | null) {
    const index = frameNo === null ? frames.value.length : frames.value.findIndex((f) => f.frameNo === frameNo) + 1;
    frameStore.insertAt(Math.max(0, index));
  }

  function removeAt(frameNo: number) {
    const index = frames.value.findIndex((f) => f.frameNo === frameNo);
    if (index < 0) return;
    frameStore.removeAt(index);
  }

  function move(fromIndex: number, toIndex: number) {
    frameStore.move(fromIndex, toIndex);
  }

  /**
   * 保存时在数据库事务中三方合并，并一次性更新帧条目、镜头帧区间与时长。
   * 冲突已选择时，把字段/删除/帧序选项传给 store，仍在同一个提交动作中完成。
   */
  async function save(resolutions?: MergeResolutions) {
    const result = await frameStore.saveFrameSequence(resolutions);
    if (result) await shotStore.upsert(result.shot);
    return result;
  }

  async function syncShotRange() {
    // “重算时长”只从当前帧条目数刷新镜头元数据，不重排已有帧条目。
    if (shotId.value === null) return;
    const current = shotStore.byId(shotId.value);
    if (!current) return;
    await shotStore.update(shotId.value, {
      startFrame: current.startFrame,
      endFrame: current.startFrame + Math.max(1, frames.value.length) - 1,
      durationSec: framesToDuration(Math.max(1, frames.value.length), current.fps || 24),
    });
  }

  function patch(frameNo: number, patchValue: Partial<FrameEntry>) {
    frameStore.patchFrame(frameNo, patchValue);
  }

  function applyBatch(batch: BatchExposure, indexes?: number[]) {
    frameStore.applyBatch(batch, indexes);
  }

  function select(frameNo: number | null) {
    frameStore.select(frameNo);
  }

  function discard() {
    frameStore.discardChanges();
  }

  function resolutionFromChoices(choices: Record<number, FrameConflictResolution | undefined>): MergeResolutions {
    const resolutions: MergeResolutions = {};
    if (!conflict.value) return resolutions;
    conflict.value.conflicts.forEach((item, index) => {
      const value = choices[index];
      if (value) resolutions[conflictKey(item)] = value;
    });
    return resolutions;
  }

  return {
    frames,
    selectedFrameNo,
    dirty,
    baseRevision,
    currentRevision,
    saving,
    conflict,
    saveError,
    shot,
    fps,
    frameCount,
    totalDuration,
    plannedFrames,
    insertAfter,
    removeAt,
    move,
    save,
    discard,
    resolutionFromChoices,
    patch,
    applyBatch,
    select,
    syncShotRange,
    reload: async (id: number) => {
      const shot = await frameStore.loadForShot(id);
      await shotStore.upsert(shot);
      return shot;
    },
  };
}
