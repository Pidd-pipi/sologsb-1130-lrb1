/** 帧序并发保存时需要做三方合并的字段 */
export type MergeableFrameField =
  | 'shotCount'
  | 'exposureSec'
  | 'aperture'
  | 'iso'
  | 'shutterAngle'
  | 'lighting'
  | 'propOffsetMm'
  | 'note';

export const FRAME_FIELD_LABELS: Record<MergeableFrameField, string> = {
  shotCount: '张数',
  exposureSec: '曝光',
  aperture: '光圈',
  iso: 'ISO',
  shutterAngle: '快门角',
  lighting: '灯光',
  propOffsetMm: '位移',
  note: '备注',
};

export const FRAME_MERGE_FIELDS = Object.keys(FRAME_FIELD_LABELS) as MergeableFrameField[];

export type FieldConflictChoice = 'local' | 'remote';
export type PresenceConflictChoice = 'local' | 'remote';
export type OrderConflictChoice = 'local' | 'remote';

export interface FieldConflict {
  type: 'field';
  frameId: number;
  frameLabel: string;
  field: MergeableFrameField;
  fieldLabel: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  choice: FieldConflictChoice;
}

export interface PresenceConflict {
  type: 'presence';
  frameId: number;
  frameLabel: string;
  /** true 表示本地保留/编辑，远端删除；false 表示本地删除，远端保留/编辑 */
  localHasFrame: boolean;
  localLabel: string;
  remoteLabel: string;
  choice: PresenceConflictChoice;
}

export interface OrderConflict {
  type: 'order';
  message: string;
  localOrder: number[];
  remoteOrder: number[];
  labels: Record<string, string>;
  choice: OrderConflictChoice;
}

export type FrameConflict = FieldConflict | PresenceConflict | OrderConflict;

export interface FrameMergeResult {
  status: 'merged' | 'conflict';
  baseRevision: number;
  currentRevision: number;
  mergedFrames: import('./frame').FrameEntry[];
  conflicts: FrameConflict[];
  message: string;
}

export type FrameConflictResolution = FieldConflictChoice | PresenceConflictChoice | OrderConflictChoice;
