<script setup lang="ts">
/**
 * 并发冲突弹窗：镜头详情 / 帧序编排台保存帧序时，若与其它标签页的改动冲突，
 * 在此列出冲突的帧与字段，保留双方值供选择；确认后由 store 一次性提交。
 */
import { computed, reactive, ref, watch } from 'vue';
import type { FrameConflict, Resolution } from '../../utils/frameMerge';
import { formatFieldValue } from '../../utils/frameMerge';

const props = defineProps<{
  visible: boolean;
  conflicts: FrameConflict[];
}>();

const emit = defineEmits<{
  (e: 'resolve', resolution: Resolution): void;
  (e: 'cancel'): void;
}>();

const fieldChoices = reactive<Record<string, Record<string, 'ours' | 'theirs'>>>({});
const deleteChoices = reactive<Record<string, 'keep' | 'restore'>>({});
const orderChoice = ref<'ours' | 'theirs'>('ours');

const hasOrderConflict = computed(() => props.conflicts.some((c) => c.kind === 'order'));
const hasDeleteConflict = computed(() => props.conflicts.some((c) => c.kind === 'delete'));

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    for (const c of props.conflicts) {
      if (c.kind === 'field') {
        fieldChoices[c.key] = {};
        for (const f of c.fields) fieldChoices[c.key][f.field] = 'ours';
      } else if (c.kind === 'delete') {
        deleteChoices[c.key] = 'restore';
      }
    }
    orderChoice.value = 'ours';
  },
);

function confirm() {
  emit('resolve', {
    fieldChoices: { ...fieldChoices },
    orderChoice: hasOrderConflict.value ? orderChoice.value : null,
    deleteChoices: { ...deleteChoices },
  });
}
</script>

<template>
  <div v-if="visible" class="mask" data-testid="conflict-dialog">
    <div class="dialog">
      <header class="dialog-head">
        <h2>保存冲突</h2>
        <p class="sub">
          另一个标签页先保存了同一镜头的帧序，以下帧 / 字段双方都做了改动。
          请选择保留哪一方的值，确认后一次性写入帧条目、镜头帧区间与时长。
        </p>
      </header>

      <div class="conflict-list">
        <section v-for="c in conflicts" :key="c.key" class="conflict-card" :data-testid="`conflict-${c.key}`">
          <div class="card-head">
            <span class="frame-no">第 {{ c.ourFrameNo }} 帧</span>
            <span class="kind-tag" :class="c.kind">{{ c.kind === 'field' ? '字段冲突' : c.kind === 'order' ? '帧序冲突' : '删除冲突' }}</span>
          </div>

          <!-- 字段冲突：逐字段选择我方 / 对方 -->
          <div v-if="c.kind === 'field'" class="field-rows">
            <div v-for="f in c.fields" :key="f.field" class="field-row">
              <span class="field-label">{{ f.label }}</span>
              <label class="opt" :class="{ active: fieldChoices[c.key]?.[f.field] === 'ours' }">
                <input type="radio" :name="`${c.key}-${f.field}`" value="ours" v-model="fieldChoices[c.key][f.field]" />
                <span class="opt-tag ours">我方</span>
                <span class="opt-value">{{ formatFieldValue(f.field, f.ours) }}</span>
              </label>
              <label class="opt" :class="{ active: fieldChoices[c.key]?.[f.field] === 'theirs' }">
                <input type="radio" :name="`${c.key}-${f.field}`" value="theirs" v-model="fieldChoices[c.key][f.field]" />
                <span class="opt-tag theirs">对方</span>
                <span class="opt-value">{{ formatFieldValue(f.field, f.theirs) }}</span>
              </label>
            </div>
          </div>

          <!-- 帧序冲突：选择采用哪一方的完整帧序 -->
          <div v-else-if="c.kind === 'order'" class="order-rows">
            <p class="muted">双方都移动了该帧，帧序无法自动合并。</p>
            <label class="opt" :class="{ active: orderChoice === 'ours' }">
              <input type="radio" name="order-choice" value="ours" v-model="orderChoice" />
              <span class="opt-tag ours">保留我方帧序</span>
            </label>
            <label class="opt" :class="{ active: orderChoice === 'theirs' }">
              <input type="radio" name="order-choice" value="theirs" v-model="orderChoice" />
              <span class="opt-tag theirs">采用对方帧序</span>
            </label>
          </div>

          <!-- 删除冲突：保留删除 / 恢复帧 -->
          <div v-else-if="c.kind === 'delete'" class="delete-rows">
            <p class="muted">
              {{ c.ourFrame ? '我方修改了该帧，对方删除了该帧。' : '对方修改了该帧，我方删除了该帧。' }}
              <template v-if="c.theirFrame && c.theirFrame.exposureSec !== undefined">
                对方值：曝光 {{ formatFieldValue('exposureSec', c.theirFrame.exposureSec) }} ·
                位移 {{ formatFieldValue('propOffsetMm', c.theirFrame.propOffsetMm) }}。
              </template>
            </p>
            <label class="opt" :class="{ active: deleteChoices[c.key] === 'restore' }">
              <input type="radio" :name="`delete-${c.key}`" value="restore" v-model="deleteChoices[c.key]" />
              <span class="opt-tag theirs">恢复该帧（采用对方值）</span>
            </label>
            <label class="opt" :class="{ active: deleteChoices[c.key] === 'keep' }">
              <input type="radio" :name="`delete-${c.key}`" value="keep" v-model="deleteChoices[c.key]" />
              <span class="opt-tag ours">保留删除</span>
            </label>
          </div>
        </section>
      </div>

      <footer class="dialog-foot">
        <button type="button" class="btn" data-testid="conflict-cancel" @click="emit('cancel')">稍后处理</button>
        <button type="button" class="btn primary" data-testid="conflict-confirm" @click="confirm">确认并保存</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(20, 28, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}
.dialog {
  background: #fff;
  border-radius: 12px;
  width: 720px;
  max-width: 100%;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 18px 50px rgba(20, 28, 40, 0.28);
}
.dialog-head {
  padding: 18px 22px 10px;
}
.dialog-head h2 {
  margin: 0;
  font-size: 18px;
  color: #1f2d3d;
}
.sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7686;
  line-height: 1.6;
}
.conflict-list {
  padding: 8px 22px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.conflict-card {
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 12px 14px;
  background: #fbfcfe;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.frame-no {
  font-weight: 700;
  font-size: 14px;
  color: #1f2d3d;
}
.kind-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
}
.kind-tag.field {
  background: #fff4e5;
  color: #b25e09;
}
.kind-tag.order {
  background: #f0e8ff;
  color: #6d3fd1;
}
.kind-tag.delete {
  background: #fdecec;
  color: #c0392b;
}
.field-rows,
.order-rows,
.delete-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field-row {
  display: grid;
  grid-template-columns: 90px 1fr 1fr;
  gap: 8px;
  align-items: center;
}
.field-label {
  font-size: 12px;
  color: #5a6472;
}
.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid #d8dee9;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  background: #fff;
  font-size: 13px;
}
.opt.active {
  border-color: #2f6fed;
  background: #f0f5ff;
}
.opt input {
  margin: 0;
}
.opt-tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 4px;
  color: #fff;
}
.opt-tag.ours {
  background: #2f6fed;
}
.opt-tag.theirs {
  background: #e67e22;
}
.opt-value {
  color: #1f2d3d;
  word-break: break-all;
}
.muted {
  margin: 0 0 4px;
  font-size: 12px;
  color: #8a94a6;
}
.dialog-foot {
  padding: 14px 22px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid #eef1f6;
}
.btn {
  height: 34px;
  padding: 0 16px;
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
</style>
