<script setup lang="ts">
import { useTogetherStore } from "@/stores/together";
import { queue as playerQueue } from "@/stores/queue";
import { useStatusStore } from "@/stores/status";
import { toast } from "@/composables/useToast";
const open = defineModel<boolean>("open", { default: false });
const room = useTogetherStore();
const status = useStatusStore();
const official = computed(() => room.state.mode === "netease" || room.state.mode === "qqmusic");
/** 从当前 QQ 歌曲与完整队列创建官方房间 */
const hostQQMusic = (): Promise<void> =>
  window.api.together.hostQQMusic(
    JSON.parse(JSON.stringify(playerQueue.value)),
    status.playIndex,
    status.position,
  );
const invite = ref("");
const address = ref("");
const busy = ref(false);
const active = computed(() => room.state.connection !== "idle");
const snapshot = computed(() => room.state.snapshot);
/** 创建可与网易云官方客户端互通的房间 */
const hostNetease = (): Promise<void> => window.api.together.hostNetease();
/** 执行连接操作并展示错误
 * @param task - 创建或加入操作
 */
const run = async (task: () => Promise<void>): Promise<void> => {
  busy.value = true;
  try {
    await task();
  } catch (e) {
    toast.error(String(e));
  } finally {
    busy.value = false;
  }
};
/** 复制房间邀请码 */
const copy = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(room.state.invite);
    toast.success("邀请码已复制");
  } catch {
    toast.warning("请手动复制邀请码");
  }
};
/** 打开聊天侧栏，让播放器继续可操作 */
const chat = (): void => {
  room.chatOpen = true;
  open.value = false;
};
</script>
<template>
  <SDialog
    v-model:open="open"
    :title="
      room.state.mode === 'qqmusic'
        ? 'QQ 音乐 · 一起听'
        : room.state.mode === 'netease'
          ? '网易云 · 一起听'
          : '一起听'
    "
    width="460px"
  >
    <div v-if="active" class="flex flex-col items-center gap-6 px-2 pb-1">
      <div class="w-full rounded-2xl bg-primary/5 px-3 py-7 flex flex-col items-center gap-6">
        <TogetherAvatars :members="snapshot?.members || []" />
        <div class="text-center">
          <div class="text-xs text-on-surface-variant tracking-wide">
            {{ official ? "本次一起听的时光" : "一起听过的时光" }}
          </div>
          <div class="mt-2 text-4xl font-semibold text-on-surface tabular-nums tracking-tight">
            {{ room.durationLabel }}
          </div>
          <div
            class="mt-2 flex justify-center items-center gap-1.5 text-xs text-on-surface-variant"
          >
            <span
              class="size-1.5 rounded-full"
              :class="snapshot?.counting ? 'bg-emerald-500' : 'bg-on-surface-variant/30'"
            />
            {{
              room.state.connection !== "connected"
                ? "正在重新连接"
                : snapshot?.counting
                  ? "音乐正在你们之间流动"
                  : snapshot?.members.filter((m) => m.online).length === 2
                    ? snapshot?.desiredPlaying
                      ? "正在缓冲，恢复后继续计时"
                      : "已连接，随时开始一起听"
                    : "等待听友加入"
            }}
          </div>
        </div>
      </div>
      <div class="w-full text-center">
        <p class="text-sm text-on-surface truncate">
          {{ snapshot?.tracks[snapshot.index]?.title || "选一个喜欢的歌单，开始一起听" }}
        </p>
        <p class="mt-1.5 text-xs text-on-surface-variant">
          直接播放歌单或添加歌曲，会自动同步给听友
        </p>
      </div>
      <div class="w-full grid gap-3" :class="official ? 'grid-cols-1' : 'grid-cols-2'">
        <SButton variant="secondary" @click="copy">
          <template #icon><IconLucideLink /></template>
          邀请听友
        </SButton>
        <SButton v-if="!official" variant="secondary" @click="chat">
          <template #icon><IconLucideMessageCircle /></template>
          聊聊天
        </SButton>
      </div>
      <div
        class="flex w-full items-center justify-between border-t border-t-solid border-t-on-surface/8 pt-3 text-xs text-on-surface-variant"
      >
        <span>
          {{ official ? "按本机播放状态累计本次时长" : "暂停、缓冲或断线时不计入时长" }}
        </span>
        <SButton variant="text" size="small" @click="room.leave">
          {{ room.state.mode === "netease" ? "结束官方一起听" : "退出一起听" }}
        </SButton>
      </div>
    </div>
    <div v-else class="flex flex-col gap-4 py-1">
      <div class="mb-1 text-center">
        <div
          class="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-primary/8 text-primary"
        >
          <IconLucideHeadphones class="size-6" />
        </div>
        <p class="text-base font-semibold text-on-surface">让音乐陪你们待在一起</p>
        <p class="mt-2 text-xs text-on-surface-variant">双方都可以选歌和控制播放</p>
      </div>
      <SInput v-model="invite" placeholder="粘贴邀请码，或 QQ／网易云一起听分享链接" />
      <SButton :disabled="!invite.trim() || busy" @click="run(() => room.join(invite))">
        加入一起听
      </SButton>
      <SButton variant="secondary" :disabled="busy" @click="run(() => hostNetease())">
        创建网易云官方一起听
      </SButton>
      <p class="text-xs text-on-surface-variant">
        官方房间可与网易云 App 一起听，使用已登录的网易云账号和歌曲
      </p>
      <SButton variant="secondary" :disabled="busy" @click="run(hostQQMusic)">
        创建 QQ 音乐官方一起听
      </SButton>
      <p class="text-xs text-on-surface-variant">创建 QQ 房间前，先选择并播放一个 QQ 音乐歌单</p>
      <SDivider />
      <SInput v-model="address" placeholder="可选：这台电脑的 Tailscale / 局域网 IP" />
      <p class="text-xs text-on-surface-variant">
        已连接 Tailscale 时会优先使用其地址。异地双方需能通过 VPN 或房间服务互相连接。
      </p>
      <SButton
        variant="secondary"
        :disabled="busy"
        @click="run(() => room.host(address.trim() || undefined))"
      >
        创建一起听
      </SButton>
    </div>
    <p v-if="room.state.error || room.playbackError" class="mt-3 text-sm text-red-500">
      {{ room.playbackError || room.state.error }}
    </p>
  </SDialog>
</template>
