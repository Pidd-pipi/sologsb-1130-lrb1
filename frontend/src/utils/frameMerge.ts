/**
 * 帧序三路合并（three-way merge）。
 *
 * 背景：两名摄影助理在两个标签页同时编辑同一镜头，后保存的页面会覆盖对方刚改的帧。
 * 打开镜头时记录修订号 revision 与基线帧序 baseFrames；保存前在本地数据库核对：
 *   - 库中修订号 === 基线修订号：期间无人保存，直接写入我方帧序；
 *   - 库中修订号 > 基线修订号：对方先保存过，取「基线 / 我方 / 对方」三路合并。
 *
 * 合并规则：
 *   - 同一字段只有一方改动 → 采用改动方；
 *   - 同一字段双方都改且值不同 → 记为字段冲突（曝光 / 位移等），保留双方值供选择；
 *   - 双方只移动不同帧 → 自动合并双方帧序；
 *   - 双方移动了同一帧 → 记为帧序冲突，保留双方帧序供选择；
 *   - 一方删除、另一方未改 → 采纳删除；一方删除、另一方改了 → 记为删除冲突。
 */
import type { FrameEntry } from '../types/frame';

/** 参与并发合并的字段（id / shotId / frameNo 为结构字段，不做字段级冲突） */
const FIELD_LABELS: Record<string, string> = {
  shotCount: '拍摄张数',
  exposureSec: '曝光时间',
  aperture: '光圈',
  iso: 'ISO',
  shutterAngle: '快门角度',
  lighting: '灯光',
  propOffsetMm: '位移量',
  note: '备注',
};

const MERGE_FIELDS = Object.keys(FIELD_LABELS) as (keyof FrameEntry)[];

export interface FieldConflict {
  field: string;
  label: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export interface FrameConflict {
  /** 稳定键：已有帧为 id:<id>，新插入帧不参与冲突 */
  key: string;
  frameId?: number;
  baseFrameNo?: number;
  ourFrameNo: number;
  kind: 'field' | 'order' | 'delete';
  fields: FieldConflict[];
  /** order 冲突：双方完整帧序键（id: 或 new: 开头） */
  ourOrder?: string[];
  theirOrder?: string[];
  /** delete 冲突：对方删除 / 我方修改 时对方帧的快照 */
  theirFrame?: FrameEntry;
  /** delete 冲突：我方删除 / 对方修改 时我方帧的快照 */
  ourFrame?: FrameEntry;
}

export interface MergeOutcome {
  /** 合并后的帧序（已按顺序重排 frameNo） */
  frames: FrameEntry[];
  /** 冲突列表；非空时拒绝写入，交由镜头详情页列出并由用户选择 */
  conflicts: FrameConflict[];
}

/** 用户在冲突弹窗中做出的选择 */
export interface Resolution {
  /** 帧键 -> 字段 -> 选择我方 / 对方 */
  fieldChoices: Record<string, Record<string, 'ours' | 'theirs'>>;
  /** 帧序冲突时采用哪一方的完整帧序 */
  orderChoice: 'ours' | 'theirs' | null;
  /** 帧键 -> 保留删除 / 恢复帧 */
  deleteChoices: Record<string, 'keep' | 'restore'>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (isObject(a) && isObject(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function fieldsDiffer(base: FrameEntry, other: FrameEntry): boolean {
  return MERGE_FIELDS.some((f) => !eq(other[f], base[f]));
}

/** 帧的稳定键：已有帧用 id，新帧用对象引用缓存的临时键 */
function makeKeyer() {
  const cache = new WeakMap<FrameEntry, string>();
  let n = 0;
  return {
    key(f: FrameEntry): string {
      if (typeof f.id === 'number') return `id:${f.id}`;
      let k = cache.get(f);
      if (!k) {
        k = `new:${++n}`;
        cache.set(f, k);
      }
      return k;
    },
  };
}

/** 最长公共子序列（用于识别被移动的帧） */
function lcs(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * 三路合并帧序。
 * @param base 打开镜头时的基线帧序
 * @param ours 当前标签页工作副本
 * @param theirs 本地库中对方已保存的帧序
 */
export function mergeFrameSequences(
  base: FrameEntry[],
  ours: FrameEntry[],
  theirs: FrameEntry[],
): MergeOutcome {
  const conflicts: FrameConflict[] = [];
  const keyer = makeKeyer();

  const baseById = new Map<number, FrameEntry>();
  base.forEach((f) => {
    if (typeof f.id === 'number') baseById.set(f.id, f);
  });
  const oursById = new Map<number, FrameEntry>();
  ours.forEach((f) => {
    if (typeof f.id === 'number') oursById.set(f.id, f);
  });
  const theirsById = new Map<number, FrameEntry>();
  theirs.forEach((f) => {
    if (typeof f.id === 'number') theirsById.set(f.id, f);
  });

  // 合并结果：键 -> 帧（已有帧用 id 键，新帧用临时键）
  const resultMap = new Map<string, FrameEntry>();

  // 1. 已有帧：字段级三路合并 + 删除判定
  for (const [id, baseF] of baseById) {
    const ourF = oursById.get(id);
    const theirF = theirsById.get(id);
    const key = `id:${id}`;

    if (!ourF && !theirF) {
      // 双方都删除：不保留
      continue;
    }
    if (!ourF && theirF) {
      // 我方删除，对方保留
      if (fieldsDiffer(baseF, theirF)) {
        conflicts.push({
          key,
          frameId: id,
          baseFrameNo: baseF.frameNo,
          ourFrameNo: baseF.frameNo,
          kind: 'delete',
          fields: [],
          ourFrame: undefined,
          theirFrame: { ...theirF },
        });
        // 默认保留对方修改，待用户选择
        resultMap.set(key, { ...theirF });
      }
      // 对方未改：采纳我方删除
      continue;
    }
    if (ourF && !theirF) {
      // 对方删除，我方保留
      if (fieldsDiffer(baseF, ourF)) {
        conflicts.push({
          key,
          frameId: id,
          baseFrameNo: baseF.frameNo,
          ourFrameNo: ourF.frameNo,
          kind: 'delete',
          fields: [],
          ourFrame: { ...ourF },
          theirFrame: undefined,
        });
        resultMap.set(key, { ...ourF });
      }
      // 我方未改：采纳对方删除
      continue;
    }

    // 双方都保留：逐字段合并
    const merged: FrameEntry = { ...baseF };
    const fieldConflicts: FieldConflict[] = [];
    for (const field of MERGE_FIELDS) {
      const bv = baseF[field] as unknown;
      const ov = ourF![field] as unknown;
      const tv = theirF![field] as unknown;
      const ourChanged = !eq(ov, bv);
      const theirChanged = !eq(tv, bv);
      if (ourChanged && theirChanged) {
        if (!eq(ov, tv)) {
          fieldConflicts.push({ field, label: FIELD_LABELS[field], base: bv, ours: ov, theirs: tv });
          merged[field] = ov as never; // 默认我方值，待用户选择
        } else {
          merged[field] = ov as never;
        }
      } else if (ourChanged) {
        merged[field] = ov as never;
      } else if (theirChanged) {
        merged[field] = tv as never;
      }
    }
    if (fieldConflicts.length) {
      conflicts.push({
        key,
        frameId: id,
        baseFrameNo: baseF.frameNo,
        ourFrameNo: ourF!.frameNo,
        kind: 'field',
        fields: fieldConflicts,
      });
    }
    resultMap.set(key, merged);
  }

  // 2. 新插入帧（基线中不存在）：双方各自保留，不产生字段冲突
  for (const f of ours) {
    if (!baseById.has(f.id ?? -1)) resultMap.set(keyer.key(f), { ...f });
  }
  for (const f of theirs) {
    if (!baseById.has(f.id ?? -1)) {
      const k = keyer.key(f);
      if (!resultMap.has(k)) resultMap.set(k, { ...f });
    }
  }

  // 3. 帧序合并：以基线帧序为底，应用双方各自的移动；移动了不同帧可自动合并，
  //    移动了同一帧则记为帧序冲突。新插入的帧按其在各方中相对基线帧的位置插入。
  const resultKeys = new Set(resultMap.keys());
  const ourKeys = ours.map((f) => keyer.key(f)).filter((k) => resultKeys.has(k));
  const theirKeys = theirs.map((f) => keyer.key(f)).filter((k) => resultKeys.has(k));
  const baseKeys = base.map((f) => `id:${f.id}`);

  const commonKeys = baseKeys.filter((k) => resultMap.has(k));
  const ourCommon = ourKeys.filter((k) => commonKeys.includes(k));
  const theirCommon = theirKeys.filter((k) => commonKeys.includes(k));

  const ourPos = new Map(ourKeys.map((k, i) => [k, i]));
  const theirPos = new Map(theirKeys.map((k, i) => [k, i]));

  // 移动检测：以 LCS（最长公共子序列）为未移动骨干，不在骨干上的帧视为被移动。
  // 帧集不同（有插入 / 删除）时同样适用。
  const lcsO = lcs(commonKeys, ourCommon);
  const lcsT = lcs(commonKeys, theirCommon);
  const movedByUs = commonKeys.filter((k) => !lcsO.includes(k));
  const movedByThem = commonKeys.filter((k) => !lcsT.includes(k));
  const bothMoved = movedByUs.filter((k) => movedByThem.includes(k));

  if (bothMoved.length) {
    for (const k of bothMoved) {
      const f = resultMap.get(k);
      conflicts.push({
        key: k,
        frameId: f?.id,
        baseFrameNo: baseById.get(f?.id ?? -1)?.frameNo,
        ourFrameNo: oursById.get(f?.id ?? -1)?.frameNo ?? 0,
        kind: 'order',
        fields: [],
        ourOrder: ourKeys,
        theirOrder: theirKeys,
      });
    }
  }

  // 以基线帧序为底（仅保留仍存活的基线帧）
  const mergedKeys: string[] = commonKeys.slice();

  // 应用我方移动
  for (const k of movedByUs) {
    const at = mergedKeys.indexOf(k);
    if (at >= 0) mergedKeys.splice(at, 1);
    const target = ourPos.get(k) ?? mergedKeys.length;
    mergedKeys.splice(Math.min(target, mergedKeys.length), 0, k);
  }
  // 应用对方移动
  for (const k of movedByThem) {
    const at = mergedKeys.indexOf(k);
    if (at >= 0) mergedKeys.splice(at, 1);
    const target = theirPos.get(k) ?? mergedKeys.length;
    mergedKeys.splice(Math.min(target, mergedKeys.length), 0, k);
  }

  // 插入我方新帧：按其在我方帧序中前一个基线帧定位
  for (const k of ourKeys) {
    if (commonKeys.includes(k)) continue;
    if (mergedKeys.includes(k)) continue;
    const idx = ourKeys.indexOf(k);
    let insertAt = mergedKeys.length;
    for (let i = idx - 1; i >= 0; i--) {
      const prev = ourKeys[i];
      const posInMerged = mergedKeys.indexOf(prev);
      if (posInMerged >= 0) {
        insertAt = posInMerged + 1;
        break;
      }
    }
    mergedKeys.splice(Math.min(insertAt, mergedKeys.length), 0, k);
  }
  // 插入对方新帧
  for (const k of theirKeys) {
    if (commonKeys.includes(k)) continue;
    if (mergedKeys.includes(k)) continue;
    const idx = theirKeys.indexOf(k);
    let insertAt = mergedKeys.length;
    for (let i = idx - 1; i >= 0; i--) {
      const prev = theirKeys[i];
      const posInMerged = mergedKeys.indexOf(prev);
      if (posInMerged >= 0) {
        insertAt = posInMerged + 1;
        break;
      }
    }
    mergedKeys.splice(Math.min(insertAt, mergedKeys.length), 0, k);
  }

  // 4. 按合并后的顺序重排 frameNo（从 1 开始）
  const frames: FrameEntry[] = mergedKeys.map((key, idx) => {
    const f = resultMap.get(key)!;
    return { ...f, frameNo: idx + 1 };
  });

  return { frames, conflicts };
}

/** 按用户在冲突弹窗中的选择，在工作副本上应用选择 */
export function applyResolution(
  ours: FrameEntry[],
  theirs: FrameEntry[],
  conflicts: FrameConflict[],
  resolution: Resolution,
): FrameEntry[] {
  const result = ours.map((f) => ({ ...f }));
  const keyOf = (f: FrameEntry): string => (typeof f.id === 'number' ? `id:${f.id}` : `new:${f.id ?? 0}`);

  // 字段冲突：按选择覆盖字段值
  for (const c of conflicts) {
    if (c.kind !== 'field') continue;
    const choices = resolution.fieldChoices[c.key];
    if (!choices) continue;
    const idx = result.findIndex((f) => keyOf(f) === c.key);
    if (idx < 0) continue;
    for (const fc of c.fields) {
      const choice = choices[fc.field];
      const target = result[idx] as Record<string, unknown>;
      if (choice === 'ours') target[fc.field] = fc.ours;
      else if (choice === 'theirs') target[fc.field] = fc.theirs;
    }
  }

  // 删除冲突：恢复 / 保留删除
  for (const c of conflicts) {
    if (c.kind !== 'delete') continue;
    const choice = resolution.deleteChoices[c.key];
    if (choice === 'restore') {
      const source = c.theirFrame ?? c.ourFrame;
      if (source && !result.some((f) => keyOf(f) === c.key)) {
        result.push({ ...source });
      }
    } else if (choice === 'keep') {
      const idx = result.findIndex((f) => keyOf(f) === c.key);
      if (idx >= 0) result.splice(idx, 1);
    }
  }

  // 帧序冲突：采用对方帧序重排
  const hasOrderConflict = conflicts.some((c) => c.kind === 'order');
  if (hasOrderConflict && resolution.orderChoice === 'theirs') {
    const order = conflicts.find((c) => c.kind === 'order')?.theirOrder ?? [];
    const byKey = new Map<string, FrameEntry>();
    result.forEach((f) => byKey.set(keyOf(f), f));
    const theirsByKey = new Map<string, FrameEntry>();
    theirs.forEach((f) => byKey.set(keyOf(f), f));
    const reordered: FrameEntry[] = [];
    const used = new Set<string>();
    for (const k of order) {
      let f = byKey.get(k);
      if (!f && k.startsWith('new:')) f = theirsByKey.get(k);
      if (f) {
        reordered.push(f);
        used.add(k);
      }
    }
    for (const f of result) {
      if (!used.has(keyOf(f))) reordered.push(f);
    }
    result.splice(0, result.length, ...reordered);
  }

  return result;
}

/** 字段值格式化（冲突弹窗展示用） */
export function formatFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (field) {
    case 'exposureSec':
      return `${Number(value)} s`;
    case 'aperture':
      return `f/${Number(value)}`;
    case 'iso':
      return `ISO ${Number(value)}`;
    case 'shutterAngle':
      return `${Number(value)}°`;
    case 'propOffsetMm':
      return `${Number(value)} mm`;
    case 'shotCount':
      return `${Number(value)} 张`;
    default:
      return String(value);
  }
}
