<script setup lang="ts">
import type { TogetherSnapshot } from "@shared/types/together";
defineProps<{ members: TogetherSnapshot["members"]; compact?: boolean }>();
</script>
<template>
  <div class="flex items-center justify-center" :class="compact ? '-space-x-2' : 'gap-4'">
    <template v-for="index in 2" :key="index">
      <div class="flex min-w-0 flex-col items-center" :class="compact ? '' : 'w-24 gap-2.5'">
        <div
          class="relative shrink-0 rounded-full border-3 border-solid border-surface bg-primary/10 flex items-center justify-center"
          :class="compact ? 'size-7' : 'size-18 shadow-sm'"
        >
          <img
            v-if="members[index - 1]?.avatar"
            :src="members[index - 1].avatar"
            :alt="members[index - 1].name"
            referrerpolicy="no-referrer"
            decoding="async"
            class="size-full rounded-full object-cover"
          />
          <span
            v-else-if="members[index - 1]"
            class="font-semibold text-primary"
            :class="compact ? 'text-xs' : 'text-xl'"
          >
            {{ members[index - 1].name.slice(0, 1) }}
          </span>
          <IconLucideUserRound
            v-else
            class="text-on-surface-variant/40"
            :class="compact ? 'size-3.5' : 'size-6'"
          />
          <span
            v-if="members[index - 1]?.online"
            class="absolute bottom-0 right-0 rounded-full bg-emerald-500 border-2 border-solid border-surface"
            :class="compact ? 'size-2' : 'size-3.5'"
          />
        </div>
        <span v-if="!compact" class="w-full truncate text-center text-sm text-on-surface">
          {{ members[index - 1]?.name || "等待听友加入" }}
        </span>
      </div>
      <div v-if="index === 1 && !compact" class="-mt-7 flex items-center gap-1.5 text-primary/45">
        <span class="h-px w-4 bg-primary/20" />
        <IconLucideHeadphones class="size-5" />
        <span class="h-px w-4 bg-primary/20" />
      </div>
    </template>
  </div>
</template>
