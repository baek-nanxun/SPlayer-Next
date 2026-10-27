import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import QrLoginPanel from "./QrLoginPanel.vue";
const globals = { stubs: { SLoading: true, SButton: { template: "<button><slot /></button>" } } };
afterEach(() => {
  vi.useRealTimers();
});

it("关闭登录面板后忽略进行中的扫码成功结果", async () => {
  vi.useFakeTimers();
  let done!: (result: { state: "success" }) => void;
  const check = vi.fn(
    () =>
      new Promise<{ state: "success" }>((resolve) => {
        done = resolve;
      }),
  );
  const wrapper = mount(QrLoginPanel, {
    props: {
      active: true,
      adapter: { create: async () => ({ key: "key", content: "https://example.com/qr" }), check },
    },
    global: globals,
  });
  await flushPromises();
  await vi.advanceTimersByTimeAsync(1500);
  expect(check).toHaveBeenCalledTimes(1);
  await wrapper.setProps({ active: false });
  done({ state: "success" });
  await flushPromises();
  expect(wrapper.emitted("success")).toBeUndefined();
  wrapper.unmount();
});

it("二维码创建失败提供可用的重试按钮", async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ key: "key", content: "https://example.com/qr" });
  const wrapper = mount(QrLoginPanel, {
    props: { active: true, adapter: { create, check: vi.fn() } },
    global: globals,
  });
  await flushPromises();
  expect(wrapper.find("button").text()).toBe("common.retry");
  await wrapper.find("button").trigger("click");
  await flushPromises();
  expect(create).toHaveBeenCalledTimes(2);
  expect(wrapper.find("img").exists()).toBe(true);
  wrapper.unmount();
});
