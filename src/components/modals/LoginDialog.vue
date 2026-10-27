<script setup lang="ts">
import { useStatusStore } from "@/stores/status";
import { useAccountStore } from "@/stores/account";
import { toast } from "@/composables/useToast";
import { dialog } from "@/composables/useDialog";
import { REPO_NAME } from "@/utils/config";
import { qqmusicQrLoginAdapter, qqmusicWxQrLoginAdapter } from "@/apis/login/qqmusic";
import { neteaseQrLoginAdapter, syncNeteaseDeviceName } from "@/apis/login/netease";

const props = defineProps<{ open: boolean; initialPlatform?: "netease" | "qqmusic" }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const { t } = useI18n();
const user = useAccountStore();
const status = useStatusStore();
const loginPlatform = ref<"netease" | "qqmusic">("qqmusic");
watch(
  () => props.open,
  (open) => {
    if (open) loginPlatform.value = props.initialPlatform ?? user.platform;
  },
);
const connectedAccount = computed(() =>
  user.accounts.find((a) => a.platform === loginPlatform.value && a.isLoggedIn),
);
const qqMethod = ref<"qq" | "wx">("qq");
const adapter = computed(() =>
  loginPlatform.value === "netease"
    ? neteaseQrLoginAdapter
    : qqMethod.value === "qq"
      ? qqmusicQrLoginAdapter
      : qqmusicWxQrLoginAdapter,
);
const panelRef = useTemplateRef("panelRef");
const loading = ref(false);
const cookieDialogOpen = ref(false);

/** 同步登录结果并切换当前平台 */
const finishLogin = async (): Promise<boolean> => {
  const ok = await user.selectPlatform(loginPlatform.value);
  if (ok) {
    status.searchPlatform = loginPlatform.value;
    status.myPlaylistSource = "online";
    status.likedPageTab = "online";
    toast.success(t("login.success"));
    emit("update:open", false);
    return true;
  }
  toast.error(t("login.failed"));
  return false;
};

/** 处理扫码成功并更新账号状态 */
const handleQrSuccess = async (): Promise<void> => {
  loading.value = true;
  try {
    if (!(await finishLogin())) void panelRef.value?.refresh();
  } catch {
    toast.error(t("login.failed"));
  } finally {
    loading.value = false;
  }
};

/** 通过平台网页获取网易云登录状态 */
const startAutoFetch = async (): Promise<void> => {
  if (loading.value) return;
  const ok = await dialog.confirm({
    title: t("login.autoFetchTitle"),
    content: t("login.autoFetchTip"),
    confirmText: t("login.autoFetchConfirm"),
    type: "warning",
  });
  if (!ok) return;
  loading.value = true;
  panelRef.value?.pause();
  try {
    const result = await window.api.apis.openLoginWeb("netease");
    if (!result.ok) {
      if (result.error !== "canceled") toast.error(t("login.failed"));
      panelRef.value?.resume();
      return;
    }
    if (!(await finishLogin())) void panelRef.value?.refresh();
    else if (loginPlatform.value === "netease") void syncNeteaseDeviceName();
  } catch {
    toast.error(t("login.failed"));
  } finally {
    loading.value = false;
  }
};

/** 打开手动登录入口 */
const openManualCookie = (): void => {
  panelRef.value?.pause();
  cookieDialogOpen.value = true;
};

/** 同步手动登录弹窗与扫码轮询状态 */
const onCookieDialogOpen = (open: boolean): void => {
  cookieDialogOpen.value = open;
  if (!open && props.open) panelRef.value?.resume();
};
</script>

<template>
  <SDialog :open="open" :closable="false" width="380px" @update:open="emit('update:open', $event)">
    <div class="flex flex-col items-center gap-4 py-3">
      <div class="flex flex-col items-center gap-2">
        <SLogo :size="48" />
        <div class="text-xl font-semibold text-on-surface">{{ REPO_NAME }}</div>
      </div>
      <p class="text-xs text-on-surface-variant text-center">{{ t("login.dualAccountHint") }}</p>
      <div class="flex gap-2" role="group" :aria-label="t('login.platform')">
        <SButton
          :variant="loginPlatform === 'netease' ? 'secondary' : 'ghost'"
          :disabled="loading"
          @click="loginPlatform = 'netease'"
        >
          {{ t("login.netease") }}
        </SButton>
        <SButton
          :variant="loginPlatform === 'qqmusic' ? 'secondary' : 'ghost'"
          :disabled="loading"
          @click="loginPlatform = 'qqmusic'"
        >
          QQ 音乐
        </SButton>
      </div>
      <div v-if="loginPlatform === 'qqmusic'" class="flex gap-2">
        <SButton
          size="small"
          :variant="qqMethod === 'qq' ? 'secondary' : 'ghost'"
          :disabled="loading"
          @click="qqMethod = 'qq'"
        >
          {{ t("settings.platformLogin.loginQrQQ") }}
        </SButton>
        <SButton
          size="small"
          :variant="qqMethod === 'wx' ? 'secondary' : 'ghost'"
          :disabled="loading"
          @click="qqMethod = 'wx'"
        >
          {{ t("settings.platformLogin.loginQrWX") }}
        </SButton>
      </div>
      <SButton v-if="connectedAccount" variant="text" :disabled="loading" @click="handleQrSuccess">
        {{
          t("login.useConnectedAccount", {
            name: connectedAccount?.profile?.nickname || t("login.unknownUser"),
          })
        }}
      </SButton>
      <QrLoginPanel
        :key="`${loginPlatform}:${qqMethod}`"
        ref="panelRef"
        class="mt-4"
        :active="open"
        :adapter="adapter"
        @success="handleQrSuccess"
      />
      <div v-if="loginPlatform === 'netease'" class="flex items-center gap-2 pt-1">
        <SButton variant="ghost" size="small" :disabled="loading" @click="startAutoFetch">
          <template #icon><IconLucideScanLine /></template>
          {{ t("login.autoFetch") }}
        </SButton>
        <div class="h-3 w-px bg-outline-variant/40" />
        <SButton variant="ghost" size="small" :disabled="loading" @click="openManualCookie">
          <template #icon><IconLucideKeyRound /></template>
          {{ t("login.manualCookie") }}
        </SButton>
      </div>
    </div>
    <template #footer="{ close }">
      <SButton variant="tertiary" class="mx-auto" :disabled="loading" @click="close">
        <template #icon><IconLucideX /></template>
        {{ t("common.cancel") }}
      </SButton>
    </template>
  </SDialog>
  <LoginCookieDialog
    :open="cookieDialogOpen"
    @update:open="onCookieDialogOpen"
    @success="emit('update:open', false)"
  />
</template>
