import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
const mocks = vi.hoisted(() => ({
  room: {
    state: {
      mode: "qqmusic",
      connection: "connected",
      invite: "https://i.y.qq.com/n2/m/share/listen_together/index.html?showid=LUGC123",
      appInvite: undefined as string | undefined,
      snapshot: {
        index: 0,
        tracks: [{ title: "测试歌曲" }],
        members: [],
        desiredPlaying: false,
        counting: false,
      },
      error: "",
    },
    durationLabel: "00:00:00",
    playbackError: "",
    unreadChat: 0,
    chatOpen: false,
  },
  write: vi.fn(),
}));
vi.mock("@/stores/together", () => ({ useTogetherStore: () => mocks.room }));
vi.mock("@/composables/useToast", () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));
import TogetherDialog from "./TogetherDialog.vue";
const globals = {
  stubs: {
    SDialog: { template: "<div><slot /></div>" },
    SButton: { props: ["disabled"], template: '<button :disabled="disabled"><slot /></button>' },
    TogetherAvatars: true,
  },
};
beforeEach(() => {
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.room.state.appInvite = undefined;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.write },
  });
});
afterEach(() => vi.restoreAllMocks());
it("空房可分享给SPlayer，官方邀请未就绪时禁用按钮并解释先选歌", async () => {
  const wrapper = mount(TogetherDialog, { props: { open: true }, global: globals });
  const buttons = wrapper.findAll("button");
  expect(
    buttons.find((b) => b.text().includes("复制 QQ 音乐邀请"))!.attributes("disabled"),
  ).toBeDefined();
  expect(wrapper.text()).toContain("选择一首 QQ 歌曲");
  await buttons.find((b) => b.text().includes("复制 SPlayer 邀请"))!.trigger("click");
  await flushPromises();
  expect(mocks.write).toHaveBeenCalledWith(mocks.room.state.invite);
  wrapper.unmount();
});
it("官方邀请复制完整文案和完整链接，页面提供电脑版打开入口", async () => {
  const url = new URL(mocks.room.state.invite);
  url.searchParams.set("share_encrypt_uin", "encrypted-test");
  url.searchParams.set("songid", "11");
  mocks.room.state.appInvite = url.href;
  const wrapper = mount(TogetherDialog, { props: { open: true }, global: globals });
  await wrapper
    .findAll("button")
    .find((b) => b.text().includes("复制 QQ 音乐邀请"))!
    .trigger("click");
  await flushPromises();
  expect(mocks.write).toHaveBeenCalledWith(
    `#QQ音乐# 快来跟我一起听《测试歌曲》 ${url.href} @QQ音乐`,
  );
  expect(wrapper.text()).toContain("电脑版");
  expect(wrapper.find("a").attributes("href")).toBe(url.href);
  wrapper.unmount();
});
