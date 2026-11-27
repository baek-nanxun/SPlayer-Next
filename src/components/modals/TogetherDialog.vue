<script setup lang="ts">
import { useTogetherStore } from "@/stores/together";
import { toast } from "@/composables/useToast";
import { openExternal } from "@/utils/url";
const open = defineModel<boolean>("open", { default: false });
const room = useTogetherStore();
const official = computed(() => room.state.mode === "netease" || room.state.mode === "qqmusic");
const invite = ref("");
const address = ref("");
const busy = ref(false);
const active = computed(() => room.state.connection !== "idle");
const snapshot = computed(() => room.state.snapshot);
/**
 * 静默写入剪贴板并返回是否成功
 * @param text - 待写入剪贴板的文本
 * @returns 是否成功写入剪贴板
 */
const writeClipboard = async (text: string): Promise<boolean> => {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
/**
 * 构造 QQ 官方分享文案
 * @returns 包含歌名与房间链接的完整官方分享文案
 */
const formatQQInvite = (): string =>
  `#QQ音乐# 快来跟我一起听《${snapshot.value?.tracks[snapshot.value.index]?.title || "歌曲"}》 ${room.state.appInvite} @QQ音乐`;
/** 创建自建房间并自动复制邀请码、释放模态遮罩 */
const startSelfHost = async (): Promise<void> => {
  const createdInvite = await room.host(address.value.trim() || undefined);
  if (await writeClipboard(createdInvite || room.state.invite)) {
    toast.success("房间已创建，邀请码已复制");
    open.value = false;
  } else {
    toast.warning("房间已创建，请手动复制邀请码");
  }
};
/** 创建可与网易云官方客户端互通的房间并自动复制邀请链接 */
const startNetease = async (): Promise<void> => {
  await (room.hostNetease ? room.hostNetease() : window.api.together.hostNetease());
  if (await writeClipboard(room.state.invite)) {
    toast.success("房间已创建，邀请链接已复制");
    open.value = false;
  } else {
    toast.warning("房间已创建，请手动复制邀请链接");
  }
};
/** 创建 QQ 音乐官方一起听房间并复制对应邀请 */
const startQQMusic = async (): Promise<void> => {
  await (room.hostQQMusic ? room.hostQQMusic() : window.api.together.hostQQMusic([], 0, 0));
  const text = room.state.appInvite ? formatQQInvite() : room.state.invite;
  if (await writeClipboard(text)) {
    toast.success(
      room.state.appInvite
        ? "房间已创建，QQ 音乐邀请已复制"
        : "房间已创建，SPlayer 邀请已复制；选歌后可复制官方 App 邀请",
    );
    open.value = false;
  } else {
    toast.warning("房间已创建，请手动复制邀请");
  }
};
/** 加入房间后自动收起弹窗，恢复播放器操作 */
const startJoin = async (): Promise<void> => {
  await room.join(invite.value);
  invite.value = "";
  toast.success("已加入一起听");
  open.value = false;
};
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
/**
 * 复制房间邀请码并弹出结果提示
 * @param text - 待复制的邀请码或分享文案
 */
const copy = async (text = room.state.invite): Promise<void> => {
  if (await writeClipboard(text)) {
    toast.success("邀请码已复制");
  } else {
    toast.warning("请手动复制邀请码");
  }
};
/** 复制完整官方分享文案，QQ 音乐页面需要分享者与歌曲资料 */
const copyQQ = (): Promise<void> => copy(formatQQInvite());
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
        <SButton variant="secondary" @click="copy()">
          <template #icon><IconLucideLink /></template>
          {{ room.state.mode === "qqmusic" ? "复制 SPlayer 邀请" : "邀请听友" }}
        </SButton>
        <SButton
          v-if="room.state.mode === 'qqmusic'"
          variant="secondary"
          :disabled="!room.state.appInvite"
          @click="copyQQ"
        >
          复制 QQ 音乐邀请
        </SButton>
        <SButton v-if="!official" variant="secondary" @click="chat">
          <template #icon><IconLucideMessageCircle /></template>
          聊聊天
          <span
            v-if="room.unreadChat"
            aria-label="有未读消息"
            class="size-2 rounded-full bg-red-500"
          />
        </SButton>
      </div>
      <p
        v-if="room.state.mode === 'qqmusic'"
        class="w-full text-xs text-on-surface-variant leading-relaxed"
      >
        {{
          room.state.appInvite
            ? "电脑版：在安装了官方 QQ 音乐的电脑上打开邀请网页，点击「立即加入」，并允许浏览器唤起 QQ 音乐。仅复制到剪贴板不会自动入房"
            : "QQ 音乐 App 邀请需先在房间中选择一首 QQ 歌曲；SPlayer 间可以直接复制邀请加入"
        }}
      </p>
      <a
        v-if="room.state.mode === 'qqmusic' && room.state.appInvite"
        :href="room.state.appInvite"
        class="text-xs text-primary underline underline-offset-4"
        @click.prevent="openExternal(room.state.appInvite)"
      >
        在浏览器打开 QQ 音乐邀请
      </a>
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
      <SButton :disabled="!invite.trim() || busy" @click="run(startJoin)">加入一起听</SButton>
      <SButton variant="secondary" :disabled="busy" @click="run(startNetease)">
        创建网易云官方一起听
      </SButton>
      <p class="text-xs text-on-surface-variant">
        官方房间可与网易云 App 一起听，使用已登录的网易云账号和歌曲
      </p>
      <SButton variant="secondary" :disabled="busy" @click="run(startQQMusic)">
        创建 QQ 音乐官方一起听
      </SButton>
      <p class="text-xs text-on-surface-variant">
        可以先邀请听友，连接后再选择 QQ 音乐歌曲或歌单播放
      </p>
      <SDivider />
      <SInput v-model="address" placeholder="可选：这台电脑的 Tailscale / 局域网 IP" />
      <p class="text-xs text-on-surface-variant">
        留空会优先使用 Tailscale 地址；手动填写只需本机 IPv4，不含协议或端口。异地双方需通过 VPN
        或房间服务互相连接。
      </p>
      <SButton variant="secondary" :disabled="busy" @click="run(startSelfHost)">创建一起听</SButton>
    </div>
    <p v-if="room.state.error || room.playbackError" class="mt-3 text-sm text-red-500">
      {{ room.playbackError || room.state.error }}
    </p>
  </SDialog>
</template>
