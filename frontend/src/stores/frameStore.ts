/**
 * 帧条目 store：条带选中、帧序数组、批量曝光、持久化。
 *
 * 并发保护（乐观并发控制）：
 *   - loadForShot 时记录镜头修订号 baseRevision 与基线帧序 baseFrames；
 *   - persist 前在本地数据库核对修订号：未过期直接写，过期则做「基线 / 我方 / 对方」三路合并；
 *   - 合并无冲突（对方只动了不同帧 / 不同字段）→ 自动合并并一次性提交帧条目、镜头帧区间与时长；
 *   - 合并有冲突（同一字段双方改值不同、同一帧双方都移动、删除 vs 修改）→ 拒绝写入并列出冲突，
 *     交由镜头详情页让用户选择保留哪一方；
 *   - 提交失败则恢复到基线帧序（原帧序），并提示错误。
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { toPlain } from '../db';
import { accumulateOffsets, estimateSpeed, frameColor, framesToDuration } from '../utils/frameMath';
import {
  applyResolution,
  mergeFrameSequences,
  type FrameConflict,
  type Resolution,
} from '../utils/frameMerge';
import type { BatchExposure, FrameEntry } from '../types/frame';
import { createEmptyFrame } from '../types/frame';

interface FrameState {
  frames: FrameEntry[];
  shotId: number | null;
  selectedFrameNo: number | null;
  dirty: boolean;
  /** 打开镜头时的修订号（并发基线） */
  baseRevision: number | null;
  /** 打开镜头时的基线帧序（三路合并的 base，也是失败回滚的目标） */
  baseFrames: FrameEntry[];
  /** 待用户处理的并发冲突 */
  conflicts: FrameConflict[];
  /** 保存状态：idle 空闲 / saving 提交中 / conflict 有冲突待选择 / error 提交失败 */
  saveStatus: 'idle' | 'saving' | 'conflict' | 'error';
  saveError: string | null;
}

/** 串行化 persist，避免连续操作并发提交 */
let saveChain: Promise<unknown> = Promise.resolve();

export const useFrameStore = defineStore('frame', {
  state: (): FrameState => ({
    frames: [],
    shotId: null,
    selectedFrameNo: null,
    dirty: false,
    baseRevision: null,
    baseFrames: [],
    conflicts: [],
    saveStatus: 'idle',
    saveError: null,
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
    /** 是否存在待处理冲突 */
    hasConflicts(state): boolean {
      return state.saveStatus === 'conflict' && state.conflicts.length > 0;
    },
  },
  actions: {
    async loadForShot(shotId: number) {
      this.shotId = shotId;
      const [rows, shot] = await Promise.all([api.listFrames(shotId), api.getShot(shotId)]);
      this.frames = rows;
      this.baseFrames = toPlain(rows);
      this.baseRevision = shot?.revision ?? 1;
      this.conflicts = [];
      this.saveStatus = 'idle';
      this.saveError = null;
      this.dirty = false;
      if (this.frames.length && !this.frames.some((f) => f.frameNo === this.selectedFrameNo)) {
        this.selectedFrameNo = this.frames[0].frameNo;
      }
    },
    select(frameNo: number | null) {
      this.selectedFrameNo = frameNo;
    },
    /**
     * 整段帧序落库（并发保护）。
     * 核对修订号 → 三路合并 → 无冲突则一次性提交帧条目 / 镜头区间 / 时长 / 修订号；
     * 有冲突则拒绝写入并列出冲突；失败则恢复原帧序。
     */
    async persist(): Promise<{ ok: boolean; conflicts?: FrameConflict[] }> {
      if (this.shotId === null) return { ok: false };
      const shotId = this.shotId;
      // 串行化：同一镜头的保存排队执行
      const run = saveChain.then(() => this._persist(shotId));
      saveChain = run.catch(() => undefined);
      return run;
    },
    async _persist(shotId: number): Promise<{ ok: boolean; conflicts?: FrameConflict[] }> {
      this.saveStatus = 'saving';
      this.saveError = null;
      try {
        const [currentShot, currentFrames] = await Promise.all([
          api.getShot(shotId),
          api.listFrames(shotId),
        ]);
        if (!currentShot) throw new Error('镜头不存在，可能已被删除');

        const ours = toPlain(this.frames);
        const base = this.baseFrames.length ? toPlain(this.baseFrames) : toPlain(currentFrames);
        const theirs = toPlain(currentFrames);

        const { frames: merged, conflicts } = mergeFrameSequences(base, ours, theirs);

        if (conflicts.length) {
          // 修订号过期且存在冲突：拒绝写入，保留双方值供选择
          this.conflicts = conflicts;
          this.saveStatus = 'conflict';
          this.dirty = true;
          return { ok: false, conflicts };
        }

        // 自动合并通过：一次性提交帧条目、镜头帧区间与时长
        const nextRevision = (currentShot.revision ?? 1) + 1;
        const fps = currentShot.fps || 24;
        const count = merged.length;
        const durationSec = Math.round((count / fps) * 1000) / 1000;
        const startFrame = currentShot.startFrame ?? 1;
        const endFrame = startFrame + count - 1;
        await api.commitFrameSequence(shotId, merged, {
          startFrame,
          endFrame,
          durationSec,
          revision: nextRevision,
        });

        // 以库中最新状态刷新工作副本与基线
        const saved = await api.listFrames(shotId);
        this.frames = saved;
        this.baseFrames = toPlain(saved);
        this.baseRevision = nextRevision;
        this.conflicts = [];
        this.saveStatus = 'idle';
        this.saveError = null;
        this.dirty = false;
        return { ok: true };
      } catch (e) {
        // 提交失败：恢复到基线帧序（原帧序）
        this.frames = toPlain(this.baseFrames);
        this.conflicts = [];
        this.saveStatus = 'error';
        this.saveError = e instanceof Error ? e.message : '保存失败，已恢复原帧序';
        this.dirty = false;
        return { ok: false };
      }
    },
    /** 用户在冲突弹窗中做出选择后，应用选择并重新提交 */
    async resolveConflicts(resolution: Resolution) {
      if (this.shotId === null) return;
      const shotId = this.shotId;
      const [shot, currentFrames] = await Promise.all([api.getShot(shotId), api.listFrames(shotId)]);
      // 在工作副本上应用选择（字段值 / 帧序 / 删除）
      this.frames = applyResolution(this.frames, currentFrames, this.conflicts, resolution);
      // 以库中最新状态作为新基线，使本次选择成为「我方改动」
      this.baseFrames = toPlain(currentFrames);
      this.baseRevision = shot?.revision ?? this.baseRevision;
      this.conflicts = [];
      this.saveStatus = 'idle';
      await this.persist();
    },
    /** 放弃冲突选择：保留工作副本继续编辑，暂不写入 */
    dismissConflicts() {
      this.conflicts = [];
      this.saveStatus = 'idle';
    },
    async insertAt(index: number, seed?: Partial<FrameEntry>) {
      const base = createEmptyFrame(this.shotId ?? 0, index + 1);
      const anchor = this.frames[index - 1] ?? this.frames[0];
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
        frameNo: index + 1,
        id: undefined,
      };
      this.frames = [...this.frames.slice(0, index), merged, ...this.frames.slice(index)];
      this.frames = this.frames.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    async removeAt(index: number) {
      if (this.frames.length <= 1) return;
      this.frames = this.frames.filter((_, i) => i !== index);
      this.frames = this.frames.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    async move(from: number, to: number) {
      if (from === to || from < 0 || to < 0 || from >= this.frames.length || to >= this.frames.length) return;
      const next = this.frames.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      this.frames = next.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    /** 批量套用曝光参数 */
    async applyBatch(batch: BatchExposure, indexes?: number[]) {
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
      this.dirty = true;
      await this.persist();
    },
    /** 就地更新单帧字段（镜头详情页表格 / 条带位移量），同样走并发保护的保存 */
    async patchFrame(frameNo: number, patch: Partial<FrameEntry>) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      const next = { ...this.frames[idx], ...patch, updatedAt: Date.now() };
      this.frames = this.frames.map((f, i) => (i === idx ? next : f));
      this.dirty = true;
      await this.persist();
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
