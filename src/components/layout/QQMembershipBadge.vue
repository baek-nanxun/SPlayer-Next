<script setup lang="ts">
import type { PlatformProfile } from "@shared/types/platform";

const props = defineProps<{ profile: PlatformProfile | null; compact?: boolean }>();
const { t } = useI18n();
const membership = computed(() => props.profile?.membershipType ?? "unknown");
const active = computed(() => !!props.profile?.isVip && membership.value !== "unknown");
const label = computed(() => t(`login.qqMembership.${membership.value}`));
const grade = computed(() =>
  active.value && (props.profile?.vipLevel ?? 0) > 0 ? props.profile!.vipLevel : undefined,
);
const badgeText = computed(() =>
  props.compact && active.value
    ? `${membership.value === "super" ? "SVIP" : "VIP"}${grade.value === undefined ? "" : ` ${grade.value}`}`
    : `${label.value}${grade.value === undefined ? "" : ` · VIP${grade.value}`}`,
);
</script>

<template>
  <span
    :title="label"
    :aria-label="badgeText"
    class="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none tabular-nums"
    :class="
      active
        ? membership === 'super'
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
        : 'bg-on-surface/6 text-on-surface-variant'
    "
  >
    <IconLucideGem v-if="active" class="size-3" />
    {{ badgeText }}
  </span>
</template>
