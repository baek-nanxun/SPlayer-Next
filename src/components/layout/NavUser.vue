<script setup lang="ts">
import { useStatusStore } from "@/stores/status";
import { useAccountStore } from "@/stores/account";
import { dialog } from "@/composables/useDialog";
import { toast } from "@/composables/useToast";
import vipImg from "@/assets/images/vip.png";
import IconLucideListMusic from "~icons/lucide/list-music";
import IconLucideDisc3 from "~icons/lucide/disc-3";
import IconLucideUserRound from "~icons/lucide/user-round";

const { t } = useI18n();
const router = useRouter();
const user = useAccountStore();

const status = useStatusStore();
watch(
  () => user.platform,
  (platform) => {
    status.searchPlatform = platform;
    status.myPlaylistSource = "online";
    status.likedPageTab = "online";
  },
);
const loginPlatform = ref<"netease" | "qqmusic">(user.platform);
const switching = ref(false);
const loginOpen = ref(false);
/** 选择已连接账号或打开对应登录入口 */
const chooseAccount = async (
  platform: "netease" | "qqmusic",
  connected: boolean,
): Promise<void> => {
  if (switching.value) return;
  if (!connected) {
    loginPlatform.value = platform;
    popoverOpen.value = false;
    loginOpen.value = true;
    return;
  }
  switching.value = true;
  try {
    if (await user.selectPlatform(platform)) {
      status.searchPlatform = platform;
      status.myPlaylistSource = "online";
      status.likedPageTab = "online";
      popoverOpen.value = false;
    } else toast.error(t("login.failed"));
  } catch {
    toast.error(t("login.failed"));
  } finally {
    switching.value = false;
  }
};
const popoverOpen = ref(false);
watch(
  () => user.contentError,
  (message) => {
    if (message) toast.error(message);
  },
);

/** 启动、恢复窗口及可见期间校验凭据 */
onMounted(() => {
  void user.restoreAccounts();
});
useEventListener(window, "focus", () => {
  if (user.isLoggedIn) void user.fetchStatus();
});
useIntervalFn(
  () => {
    if (document.visibilityState === "visible" && user.isLoggedIn) {
      void user.fetchStatus(false);
    }
  },
  5 * 60 * 1000,
);

const isVip = computed(
  () => user.platform === "netease" && !!user.profile?.vipType && user.profile.vipType !== 0,
);

/** 收藏计数 */
const stats = computed(() =>
  [
    {
      key: "playlist" as const,
      label: t("collection.playlist"),
      icon: markRaw(IconLucideListMusic),
      value:
        (user.subcount.createdPlaylistCount || 0) + (user.subcount.subPlaylistCount || 0) ||
        user.playlists.length,
    },
    {
      key: "album" as const,
      label: t("collection.album"),
      icon: markRaw(IconLucideDisc3),
      value: user.albums.length,
    },
    {
      key: "artist" as const,
      label: t("artist.label"),
      icon: markRaw(IconLucideUserRound),
      value: user.subcount.artistCount ?? user.artists.length,
    },
  ].filter((item) => user.platform === "netease" || item.key === "playlist"),
);

const onTriggerClick = (): void => {
  if (!user.isLoggedIn) loginOpen.value = true;
};

const handleStatClick = (key: "playlist" | "album" | "artist"): void => {
  popoverOpen.value = false;
  router.push({ path: "/favorites", query: { tab: key } });
};

const handleLogout = async (): Promise<void> => {
  popoverOpen.value = false;
  const ok = await dialog.confirm({
    title: t("login.logoutConfirmTitle"),
    content: t("login.logoutConfirmDesc"),
    type: "warning",
  });
  if (!ok) return;
  await user.logout();
  toast.success(t("login.logoutDone"));
};
</script>

<template>
  <SPopover
    v-if="user.isLoggedIn"
    v-model:open="popoverOpen"
    trigger="click"
    align="end"
    content-class="w-56"
  >
    <template #trigger>
      <div
        class="app-no-drag inline-flex items-center gap-2 h-10 pl-1 pr-3 lt-sidebar:pr-1 rounded-full bg-on-surface/6 hover:bg-on-surface/10 transition-colors cursor-pointer select-none"
      >
        <span
          class="size-8 rounded-full overflow-hidden bg-on-surface/10 flex items-center justify-center"
        >
          <img
            v-if="user.profile?.avatarUrl"
            :src="user.profile.avatarUrl"
            alt="avatar"
            class="size-full object-cover"
            referrerpolicy="no-referrer"
          />
          <IconLucideUserRound v-else class="size-4 text-on-surface-variant" />
        </span>
        <span class="text-sm text-on-surface max-w-[7rem] truncate lt-sidebar:hidden">
          {{ user.profile?.nickname || t("login.unknownUser") }}
        </span>
        <img v-if="isVip" :src="vipImg" alt="VIP" class="h-4 shrink-0 lt-sidebar:hidden" />
        <QQMembershipBadge
          v-if="user.platform === 'qqmusic' && user.qqProfile?.isVip"
          :profile="user.qqProfile"
          compact
        />
        <IconLucideChevronDown
          :class="[
            'size-3 text-on-surface-variant transition-transform duration-200 lt-sidebar:hidden',
            popoverOpen && 'rotate-180',
          ]"
        />
      </div>
    </template>

    <div class="flex flex-col items-center gap-2">
      <span
        class="size-12 rounded-full overflow-hidden bg-on-surface/10 flex items-center justify-center"
      >
        <img
          v-if="user.profile?.avatarUrl"
          :src="user.profile.avatarUrl"
          alt="avatar"
          class="size-full object-cover"
          referrerpolicy="no-referrer"
        />
        <IconLucideUserRound v-else class="size-5 text-on-surface-variant" />
      </span>
      <span class="w-full text-sm font-semibold text-on-surface text-center truncate">
        {{ user.profile?.nickname || t("login.unknownUser") }}
      </span>
      <div
        v-if="user.level !== undefined || isVip || user.platform === 'qqmusic'"
        class="flex flex-wrap justify-center items-center gap-1.5"
      >
        <span
          v-if="user.level !== undefined"
          class="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none bg-amber-500/15 text-amber-600 dark:text-amber-400 tabular-nums"
        >
          Lv.{{ user.level }}
        </span>
        <img v-if="isVip" :src="vipImg" alt="VIP" class="h-4 shrink-0" />
        <QQMembershipBadge v-if="user.platform === 'qqmusic'" :profile="user.qqProfile" />
      </div>
      <span
        v-if="user.profile?.signature"
        class="text-xs text-on-surface-variant text-center line-clamp-2"
      >
        {{ user.profile.signature }}
      </span>
      <SDivider class="w-full" />
      <!-- 收藏计数 -->
      <div class="w-full flex items-stretch justify-around gap-1">
        <div
          v-for="item in stats"
          :key="item.key"
          :title="item.label"
          class="group flex flex-1 flex-col items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors duration-200 hover:bg-on-surface/8 active:bg-on-surface/12"
          @click="handleStatClick(item.key)"
        >
          <component
            :is="item.icon"
            class="size-4 text-on-surface-variant/70 transition-colors duration-200 group-hover:text-primary"
          />
          <span
            class="text-sm font-semibold text-on-surface tabular-nums leading-none transition-colors duration-200 group-hover:text-primary"
          >
            {{ item.value }}
          </span>
        </div>
      </div>
      <SDivider class="w-full" />
      <div class="w-full flex flex-col gap-1" :aria-label="t('login.accounts')">
        <button
          v-for="account in user.accounts"
          :key="account.platform"
          type="button"
          class="flex items-center gap-2 w-full rounded-lg border-0 p-2 text-left cursor-pointer hover:bg-on-surface/8 disabled:opacity-50"
          :class="account.platform === user.platform ? 'bg-on-surface/6' : 'bg-transparent'"
          :disabled="switching"
          :aria-pressed="account.platform === user.platform"
          @click="chooseAccount(account.platform, account.isLoggedIn)"
        >
          <img
            v-if="account.profile?.avatarUrl"
            :src="account.profile.avatarUrl"
            alt=""
            referrerpolicy="no-referrer"
            class="size-7 shrink-0 rounded-full"
          />
          <IconLucideUserRound v-else class="size-7 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block text-xs">
              {{ account.platform === "qqmusic" ? "QQ 音乐" : t("login.netease") }}
            </span>
            <span class="block truncate text-xs text-on-surface-variant">
              {{
                account.isLoggedIn
                  ? account.profile?.nickname || t("login.unknownUser")
                  : t("login.connectAccount")
              }}
            </span>
          </span>
          <span class="shrink-0 text-[10px] text-primary">
            {{
              account.isLoggedIn
                ? t(
                    account.platform === user.platform
                      ? "login.currentAccount"
                      : "login.connectedAccount",
                  )
                : "+"
            }}
          </span>
        </button>
      </div>
      <SButton
        variant="secondary"
        size="small"
        block
        @click="
          popoverOpen = false;
          loginPlatform = user.platform;
          loginOpen = true;
        "
      >
        {{ t("login.switchAccount") }}
      </SButton>
      <SButton variant="secondary" size="small" block @click="handleLogout">
        <template #icon><IconLucideLogOut /></template>
        {{ t("login.logoutCurrent") }}
      </SButton>
    </div>
  </SPopover>

  <SButton v-else class="app-no-drag" variant="tertiary" :size="40" circle @click="onTriggerClick">
    <template #icon><IconLucideUserRound /></template>
  </SButton>

  <LoginDialog v-model:open="loginOpen" :initial-platform="loginPlatform" />
</template>
