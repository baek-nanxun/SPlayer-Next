<script setup lang="ts">
import { useTogetherStore } from "@/stores/together";
import { toast } from "@/composables/useToast";
const room = useTogetherStore();
const text = ref("");
const sending = ref(false);
const messages = useTemplateRef("messages");
watch(
  () => room.state.snapshot?.chat.length,
  async () => {
    await nextTick();
    messages.value?.scrollTo({ top: messages.value.scrollHeight, behavior: "smooth" });
  },
);
/** 发送一条房间消息 */
const send = async (): Promise<void> => {
  if (!text.value.trim() || sending.value || room.state.connection !== "connected") return;
  const message = text.value;
  sending.value = true;
  text.value = "";
  try {
    await window.api.together.send({ type: "chat", text: message });
  } catch (e) {
    if (!text.value) text.value = message;
    toast.error(String(e));
  } finally {
    sending.value = false;
  }
};
</script>
<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 translate-x-3"
      leave-active-class="transition duration-150"
      leave-to-class="opacity-0 translate-x-3"
    >
      <aside
        v-if="room.chatOpen"
        aria-label="一起听聊天"
        class="fixed right-4 top-20 bottom-28 z-80 w-80 max-w-[calc(100vw-32px)] rounded-2xl bg-surface border border-solid border-on-surface/10 shadow-xl flex flex-col overflow-hidden"
      >
        <header
          class="flex items-center justify-between gap-3 p-4 border-b border-b-solid border-b-on-surface/8"
        >
          <div class="flex items-center gap-2.5">
            <TogetherAvatars :members="room.state.snapshot?.members || []" compact />
            <div>
              <p class="text-sm font-semibold">一起聊聊</p>
              <p class="text-[11px] text-on-surface-variant tabular-nums">
                一起听 {{ room.durationLabel }}
              </p>
            </div>
          </div>
          <SButton
            variant="ghost"
            size="small"
            circle
            title="收起聊天"
            @click="room.chatOpen = false"
          >
            <template #icon><IconLucideX /></template>
          </SButton>
        </header>
        <div ref="messages" class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4" aria-live="polite">
          <div
            v-if="!room.state.snapshot?.chat.length"
            class="h-full flex flex-col items-center justify-center gap-3 text-on-surface-variant/60"
          >
            <IconLucideMessageCircle class="size-7" />
            <p class="text-xs">这首歌，让你想到了什么？</p>
          </div>
          <div v-for="item in room.state.snapshot?.chat" :key="item.id" class="text-sm">
            <p class="mb-1.5 text-[11px] text-on-surface-variant">{{ item.name }}</p>
            <p
              class="inline-block max-w-full whitespace-pre-wrap break-words rounded-xl rounded-tl-sm bg-primary/7 px-3 py-2 text-on-surface"
            >
              {{ item.text }}
            </p>
          </div>
        </div>
        <form
          class="flex gap-2 p-3 border-t border-t-solid border-t-on-surface/8"
          @submit.prevent="send"
        >
          <SInput v-model="text" placeholder="说点什么…" :maxlength="500" />
          <SButton
            circle
            :disabled="room.state.connection !== 'connected' || !text.trim() || sending"
            :loading="sending"
            title="发送"
          >
            <template #icon><IconLucideSend class="size-4" /></template>
          </SButton>
        </form>
      </aside>
    </Transition>
  </Teleport>
</template>
