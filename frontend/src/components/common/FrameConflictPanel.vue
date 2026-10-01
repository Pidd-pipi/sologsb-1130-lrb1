<script setup lang="ts">
/**
 * 帧序并发冲突面板：列出冲突帧、冲突字段及本地/远端值。
 * 曝光或位移等同帧字段冲突保留双方值，由摄影助理逐项选择后再提交。
 */
import { computed } from 'vue';
import type { FrameConflict, FrameConflictResolution, FrameMergeResult } from '../../types/frameMerge';
import { FRAME_FIELD_LABELS } from '../../types/frameMerge';

const props = defineProps<{
  merge: FrameMergeResult;
  choices: Record<number, FrameConflictResolution | undefined>;
  saving?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:choices', value: Record<number, FrameConflictResolution | undefined>): void;
  (e: 'confirm'): void;
  (e: 'discard'): void;
}>();

const fieldConflicts = computed(() => props.merge.conflicts.filter((c) => c.type === 'field'));
const presenceConflicts = computed(() => props.merge.conflicts.filter((c) => c.type === 'presence'));
const orderConflict = computed(() => props.merge.conflicts.find((c) => c.type === 'order'));

function choose(index: number, value: FrameConflictResolution) {
  emit('update:choices', { ...props.choices, [index]: value });
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '空';
  return String(value);
}

function orderText(ids: number[], labels: Record<string, string>): string {
  return ids.map((id) => labels[String(id)] ?? `#${id}`).join(' → ');
}

function isChosen(conflict: FrameConflict, index: number, value: FrameConflictResolution): boolean {
  return (props.choices[index] ?? conflict.choice) === value;
}
</script>

<template>
  <section class="conflict-panel" data-testid="frame-conflict-panel">
    <header>
      <div>
        <h2>检测到帧序并发冲突</h2>
        <p>
          打开时修订号 r{{ merge.baseRevision }}，当前本地库已到 r{{ merge.currentRevision }}。
          本次写入已拒绝；不同帧的非冲突修改已自动合并，请确认下列内容。
        </p>
      </div>
      <span class="badge">{{ merge.conflicts.length }} 项需确认</span>
    </header>

    <p v-if="fieldConflicts.length" class="group-title">同帧字段冲突（保留双方值）</p>
    <div
      v-for="conflict in fieldConflicts"
      :key="`${conflict.type}-${conflict.frameId}-${conflict.field}`"
      class="conflict-card"
      :data-testid="`conflict-field-${conflict.frameId}-${conflict.field}`"
    >
      <div class="conflict-title">
        <strong>{{ conflict.frameLabel }}</strong>
        <span>{{ FRAME_FIELD_LABELS[conflict.field] ?? conflict.field }}</span>
      </div>
      <div class="choice-grid">
        <label class="choice" :class="{ active: isChosen(conflict, merge.conflicts.indexOf(conflict), 'local') }">
          <input
            type="radio"
            :name="`conflict-${merge.conflicts.indexOf(conflict)}`"
            :checked="isChosen(conflict, merge.conflicts.indexOf(conflict), 'local')"
            @change="choose(merge.conflicts.indexOf(conflict), 'local')"
          />
          <span class="choice-label">本地值</span>
          <strong>{{ displayValue(conflict.localValue) }}</strong>
        </label>
        <label class="choice remote" :class="{ active: isChosen(conflict, merge.conflicts.indexOf(conflict), 'remote') }">
          <input
            type="radio"
            :name="`conflict-${merge.conflicts.indexOf(conflict)}`"
            :checked="isChosen(conflict, merge.conflicts.indexOf(conflict), 'remote')"
            @change="choose(merge.conflicts.indexOf(conflict), 'remote')"
          />
          <span class="choice-label">对方值</span>
          <strong>{{ displayValue(conflict.remoteValue) }}</strong>
        </label>
      </div>
      <small>打开时：{{ displayValue(conflict.baseValue) }}</small>
    </div>

    <p v-if="presenceConflicts.length" class="group-title">删除 / 保留冲突</p>
    <div
      v-for="conflict in presenceConflicts"
      :key="`${conflict.type}-${conflict.frameId}`"
      class="conflict-card"
      :data-testid="`conflict-presence-${conflict.frameId}`"
    >
      <div class="conflict-title">
        <strong>{{ conflict.frameLabel }}</strong>
        <span>一方删除，另一方保留或修改</span>
      </div>
      <div class="choice-grid two">
        <label class="choice" :class="{ active: isChosen(conflict, merge.conflicts.indexOf(conflict), 'local') }">
          <input
            type="radio"
            :name="`presence-${merge.conflicts.indexOf(conflict)}`"
            :checked="isChosen(conflict, merge.conflicts.indexOf(conflict), 'local')"
            @change="choose(merge.conflicts.indexOf(conflict), 'local')"
          />
          <strong>{{ conflict.localLabel }}</strong>
        </label>
        <label class="choice remote" :class="{ active: isChosen(conflict, merge.conflicts.indexOf(conflict), 'remote') }">
          <input
            type="radio"
            :name="`presence-${merge.conflicts.indexOf(conflict)}`"
            :checked="isChosen(conflict, merge.conflicts.indexOf(conflict), 'remote')"
            @change="choose(merge.conflicts.indexOf(conflict), 'remote')"
          />
          <strong>{{ conflict.remoteLabel }}</strong>
        </label>
      </div>
    </div>

    <template v-if="orderConflict">
      <p class="group-title">帧序骨架冲突</p>
      <div class="conflict-card" data-testid="conflict-order">
        <div class="conflict-title">
          <strong>{{ orderConflict.message }}</strong>
        </div>
        <div class="choice-grid two">
          <label class="choice" :class="{ active: isChosen(orderConflict, merge.conflicts.indexOf(orderConflict), 'local') }">
            <input
              type="radio"
              name="conflict-order"
              :checked="isChosen(orderConflict, merge.conflicts.indexOf(orderConflict), 'local')"
              @change="choose(merge.conflicts.indexOf(orderConflict), 'local')"
            />
            <span class="choice-label">本地帧序</span>
            <small>{{ orderText(orderConflict.localOrder, orderConflict.labels) }}</small>
          </label>
          <label class="choice remote" :class="{ active: isChosen(orderConflict, merge.conflicts.indexOf(orderConflict), 'remote') }">
            <input
              type="radio"
              name="conflict-order"
              :checked="isChosen(orderConflict, merge.conflicts.indexOf(orderConflict), 'remote')"
              @change="choose(merge.conflicts.indexOf(orderConflict), 'remote')"
            />
            <span class="choice-label">远端帧序</span>
            <small>{{ orderText(orderConflict.remoteOrder, orderConflict.labels) }}</small>
          </label>
        </div>
      </div>
    </template>

    <footer>
      <button type="button" class="btn primary" :disabled="saving" data-testid="conflict-confirm" @click="emit('confirm')">
        {{ saving ? '提交中…' : '确认选择并一次性保存' }}
      </button>
      <button type="button" class="btn" :disabled="saving" @click="emit('discard')">放弃本地编辑</button>
    </footer>
  </section>
</template>

<style scoped>
.conflict-panel {
  border: 1px solid #f0b7b7;
  background: #fff8f8;
  border-radius: 10px;
  padding: 16px;
}
header {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
}
h2 {
  margin: 0 0 4px;
  font-size: 17px;
  color: #a83636;
}
p {
  margin: 0;
  color: #6b5b5b;
  font-size: 13px;
}
.badge {
  background: #f4d4d4;
  color: #a23333;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.group-title {
  margin: 14px 0 8px !important;
  color: #7c4a4a !important;
  font-weight: 600;
}
.conflict-card {
  background: #fff;
  border: 1px solid #ecd4d4;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
}
.conflict-title {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 9px;
  font-size: 13px;
  color: #354052;
}
.conflict-title span {
  color: #a83636;
}
.choice-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.choice-grid.two {
  grid-template-columns: 1fr 1fr;
}
.choice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid #d8dee9;
  border-radius: 8px;
  padding: 9px 10px;
  cursor: pointer;
  background: #fbfcff;
  font-size: 13px;
}
.choice.active {
  border-color: #2f6fed;
  box-shadow: 0 0 0 2px rgba(47, 111, 237, 0.12);
}
.choice.remote.active {
  border-color: #20a072;
  box-shadow: 0 0 0 2px rgba(32, 160, 114, 0.12);
}
.choice input {
  margin: 0 0 3px;
}
.choice-label {
  color: #8a94a6;
  font-size: 12px;
}
.choice small {
  color: #5a6472;
  word-break: break-word;
}
footer {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
@media (max-width: 800px) {
  .choice-grid {
    grid-template-columns: 1fr;
  }
}
</style>
