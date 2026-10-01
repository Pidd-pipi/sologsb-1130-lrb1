/** 帧条目 store：条带选中、帧序编辑缓冲、批量曝光、带修订号的并发持久化 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { StaleFrameRevisionError } from '../db/api';
import { accumulateOffsets, estimateSpeed, frameColor, framesToDuration } from '../utils/frameMath';
import type { BatchExposure, FrameEntry } from '../types/frame';
import { createEmptyFrame } from '../types/frame';
import type { FrameMergeResult } from '../types/frameMerge';
import type { MergeResolutions } from '../utils/frameMerge';
import type { Shot } from '../types/shot';

interface FrameState {
  frames: FrameEntry[];
  baseFrames: FrameEntry[];
  shotId: number | null;
  selectedFrameNo: number | null;
  dirty: boolean;
  baseRevision: number;
  currentRevision: number;
  saving: boolean;
  conflict: FrameMergeResult | null;
  saveError: string;
}

let tempFrameSeed = 0;
function nextTempFrameId(): number {
  tempFrameSeed -= 1;
  return tempFrameSeed;
}

function cloneFrames(frames: FrameEntry[]): FrameEntry[] {
  return JSON.parse(JSON.stringify(frames)) as FrameEntry[];
}

function sameFrames(a: FrameEntry[], b: FrameEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const useFrameStore = defineStore('frame', {
  state: (): FrameState => ({
    frames: [],
    baseFrames: [],
    shotId: null,
    selectedFrameNo: null,
    dirty: false,
    baseRevision: 1,
    currentRevision: 1,
    saving: false,
    conflict: null,
    saveError: '',
  }),
  getters: {
    count(state): number {
      return state.frames.length;
    },
    selected(state): FrameEntry | undefined {
      if (state.selectedFrameNo === null) return undefined;
      return state.frames.find((f) => f.frameNo === state.selectedFrameNo);
    },
    /** 全部帧的累计位移轨迹（mm） */
    offsets(state): number[] {
      return accumulateOffsets(state.frames.map((f) => f.propOffsetMm));
    },
    /** 整段帧序按张数折算的总时长（秒） */
    totalDuration(state): number {
      return Math.round(state.frames.reduce((sum, f) => sum + 1 / (f.shotCount || 1), 0) * 100) / 100;
    },
    /** 帧序在给定帧率下的实际时长（秒） */
    durationAtFps(state) {
      return (fps: number) => framesToDuration(state.frames.length, fps);
    },
  },
  actions: {
    async loadForShot(shotId: number) {
      const [shot, rows] = await Promise.all([api.getShot(shotId), api.listFrames(shotId)]);
      if (!shot) throw new Error('镜头不存在');
      this.shotId = shotId;
      this.baseFrames = cloneFrames(rows);
      this.frames = cloneFrames(rows);
      this.baseRevision = shot.frameRevision ?? 1;
      this.currentRevision = shot.frameRevision ?? 1;
      this.dirty = false;
      this.conflict = null;
      this.saveError = '';
      this.renumberLocally(shot.startFrame);
      if (this.frames.length && !this.frames.some((f) => f.frameNo === this.selectedFrameNo)) {
        this.selectedFrameNo = this.frames[0].frameNo;
      }
      return shot as Shot;
    },
    select(frameNo: number | null) {
      this.selectedFrameNo = frameNo;
    },
    markChanged() {
      this.dirty = !sameFrames(this.frames, this.baseFrames);
      this.saveError = '';
    },
    renumberLocally(startFrame?: number) {
      const startSource = startFrame ?? this.baseFrames[0]?.frameNo ?? 1;
      const start = Number.isFinite(startSource) && startSource >= 1 ? Math.floor(startSource) : 1;
      this.frames = this.frames.map((f, index) => ({ ...f, frameNo: start + index }));
    },
    /**
     * 保存编辑缓冲。第一次遇到过期修订号只返回冲突，不落库；
     * 用户确认冲突选择后携带 resolutions 重试。
     */
    async saveFrameSequence(resolutions?: MergeResolutions): Promise<api.CommitFrameSequenceResult | null> {
      if (this.shotId === null || this.saving) return null;
      if (!this.dirty && !this.conflict) return null;

      this.saving = true;
      this.saveError = '';
      const pending = cloneFrames(this.frames);
      try {
        const result = await api.commitFrameSequence({
          shotId: this.shotId,
          expectedRevision: this.baseRevision,
          baseFrames: this.baseFrames,
          localFrames: pending,
          expectedCurrentRevision: this.currentRevision,
          resolutions,
        });
        this.frames = cloneFrames(result.frames);
        this.baseFrames = cloneFrames(result.frames);
        this.baseRevision = result.revision;
        this.currentRevision = result.revision;
        this.dirty = false;
        this.conflict = null;
        this.selectedFrameNo = this.frames[0]?.frameNo ?? null;
        return result;
      } catch (e) {
        if (e instanceof StaleFrameRevisionError) {
          this.currentRevision = e.merge.currentRevision;
          this.conflict = e.merge;
          this.saveError = e.merge.message;
          return null;
        }
        // 事务未提交时数据库已由 IndexedDB 回滚；本地也恢复打开镜头时的帧序。
        this.frames = cloneFrames(this.baseFrames);
        this.frames = this.frames.map((f, index) => ({
          ...f,
          frameNo: (this.baseFrames[0]?.frameNo ?? 1) + index,
        }));
        this.dirty = false;
        this.saveError = e instanceof Error ? e.message : '帧序保存失败，已恢复原帧序';
        throw e;
      } finally {
        this.saving = false;
      }
    },
    discardChanges() {
      this.frames = cloneFrames(this.baseFrames);
      this.frames = this.frames.map((f, index) => ({ ...f, frameNo: (this.baseFrames[0]?.frameNo ?? 1) + index }));
      this.dirty = false;
      this.conflict = null;
      this.saveError = '';
      this.selectedFrameNo = this.frames[0]?.frameNo ?? null;
    },
    insertAt(index: number, seed?: Partial<FrameEntry>) {
      if (this.shotId === null) return;
      const start = this.baseFrames[0]?.frameNo ?? this.frames[0]?.frameNo ?? 1;
      const safeIndex = Math.max(0, Math.min(index, this.frames.length));
      const base = createEmptyFrame(this.shotId, start + safeIndex);
      const anchor = this.frames[safeIndex - 1] ?? this.frames[0];
      const merged: FrameEntry = {
        ...base,
        ...(anchor
          ? {
              shotCount: anchor.shotCount,
              exposureSec: anchor.exposureSec,
              aperture: anchor.aperture,
              iso: anchor.iso,
              shutterAngle: anchor.shutterAngle,
              lighting: anchor.lighting,
            }
          : {}),
        ...seed,
        id: nextTempFrameId(),
      };
      this.frames = [...this.frames.slice(0, safeIndex), merged, ...this.frames.slice(safeIndex)];
      this.renumberLocally(start);
      this.markChanged();
    },
    removeAt(index: number) {
      if (this.frames.length <= 1) return;
      const start = this.baseFrames[0]?.frameNo ?? this.frames[0]?.frameNo ?? 1;
      this.frames = this.frames.filter((_, i) => i !== index);
      this.renumberLocally(start);
      this.markChanged();
    },
    move(from: number, to: number) {
      if (from === to || from < 0 || to < 0 || from >= this.frames.length || to >= this.frames.length) return;
      const start = this.baseFrames[0]?.frameNo ?? this.frames[0]?.frameNo ?? 1;
      const next = this.frames.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      this.frames = next;
      this.renumberLocally(start);
      this.markChanged();
    },
    /** 批量套用曝光参数（仅改本地编辑缓冲，点击保存后统一落库） */
    applyBatch(batch: BatchExposure, indexes?: number[]) {
      const target = indexes && indexes.length ? new Set(indexes) : null;
      this.frames = this.frames.map((f, idx) => {
        if (target && !target.has(idx)) return f;
        return {
          ...f,
          exposureSec: batch.exposureSec,
          aperture: batch.aperture,
          iso: batch.iso,
          shutterAngle: batch.shutterAngle,
          updatedAt: Date.now(),
        };
      });
      this.markChanged();
    },
    /** 就地更新单帧字段（镜头详情页表格 / 条带位移量），保存前不直接写库 */
    patchFrame(frameNo: number, patch: Partial<FrameEntry>) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      this.frames = this.frames.map((f, i) => (i === idx ? { ...f, ...patch, updatedAt: Date.now() } : f));
      this.markChanged();
    },
    /** 条带单帧颜色：按曝光与位移量着色 */
    colorOf(frame: FrameEntry): string {
      return frameColor({ propOffsetMm: frame.propOffsetMm, exposureSec: frame.exposureSec });
    },
    speedOf(frame: FrameEntry, fps: number): number {
      return estimateSpeed(frame.propOffsetMm, fps);
    },
  },
});
