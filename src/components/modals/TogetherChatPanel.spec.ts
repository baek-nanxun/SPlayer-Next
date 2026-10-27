import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";

const mocks = vi.hoisted(() => ({ send: vi.fn(), error: vi.fn() }));
vi.mock("@/stores/together", () => ({
  useTogetherStore: () =>
    reactive({
      chatOpen: true,
      durationLabel: "00:00:00",
      state: { connection: "connected", snapshot: { chat: [], members: [] } },
    }),
}));
vi.mock("@/composables/useToast", () => ({ toast: { error: mocks.error } }));
import TogetherChatPanel from "./TogetherChatPanel.vue";

const wrappers: ReturnType<typeof mount>[] = [];
/** 使用原生按钮的表单行为验证鼠标点击和回车提交 */
const setup = () => {
  const wrapper = mount(TogetherChatPanel, {
    attachTo: document.body,
    global: {
      stubs: {
        Teleport: true,
        TogetherAvatars: true,
        SInput: {
          props: ["modelValue"],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        SButton: {
          props: ["disabled", "loading"],
          template: '<button :disabled="disabled || loading"><slot /></button>',
        },
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
};
beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue(undefined);
  mocks.error.mockClear();
  Object.assign(window, { api: { together: { send: mocks.send } } });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

it("点击发送按钮只发一次，避免点击与表单提交重复", async () => {
  const wrapper = setup();
  await wrapper.get("input").setValue("一起听");
  (wrapper.get('button[title="发送"]').element as HTMLButtonElement).click();
  await flushPromises();
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ type: "chat", text: "一起听" });
  expect((wrapper.get("input").element as HTMLInputElement).value).toBe("");
});

it("发送未完成时再次回车不会重发，新输入也不会被清空", async () => {
  let finish!: () => void;
  mocks.send.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const wrapper = setup();
  await wrapper.get("input").setValue("第一条");
  await wrapper.get("form").trigger("submit");
  await wrapper.get("input").setValue("第二条");
  await wrapper.get("form").trigger("submit");
  expect(mocks.send).toHaveBeenCalledOnce();
  finish();
  await flushPromises();
  expect((wrapper.get("input").element as HTMLInputElement).value).toBe("第二条");
  await wrapper.get("form").trigger("submit");
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

it("发送失败保留待发送内容，不自动重复发消息", async () => {
  mocks.send.mockRejectedValueOnce(new Error("断线"));
  const wrapper = setup();
  await wrapper.get("input").setValue("保留这条");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect((wrapper.get("input").element as HTMLInputElement).value).toBe("保留这条");
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.error).toHaveBeenCalledOnce();
});
