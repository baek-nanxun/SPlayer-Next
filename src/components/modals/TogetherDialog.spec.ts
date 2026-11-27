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
        members: [] as Array<{ id: string; name: string; online: boolean; ready: boolean }>,
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
  mocks.room.state.mode = "qqmusic";
  mocks.room.state.connection = "connected";
  mocks.room.state.snapshot.members = [];
  mocks.room.state.snapshot.desiredPlaying = false;
  mocks.room.state.snapshot.counting = false;
  mocks.room.playbackError = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.write },
  });
});
it("播放失败在计时卡内显示具体原因，不再误标为缓冲", () => {
  mocks.room.state.snapshot.members = [
    { id: "a", name: "甲", online: true, ready: false },
    { id: "b", name: "乙", online: true, ready: true },
  ];
  mocks.room.state.snapshot.desiredPlaying = true;
  mocks.room.playbackError = "该歌曲仅提供试听，请在设置中允许试听播放";
  const wrapper = mount(TogetherDialog, { props: { open: true }, global: globals });
  expect(wrapper.text()).toContain("本机无法播放，暂不计时");
  expect(wrapper.get('[role="alert"]').text()).toBe(mocks.room.playbackError);
  expect(wrapper.text()).not.toContain("正在缓冲");
  wrapper.unmount();
});
it("等待准备时显示对应听友，已就绪的一方不列入等待名单", () => {
  mocks.room.state.snapshot.members = [
    { id: "a", name: "甲", online: true, ready: false },
    { id: "b", name: "乙", online: true, ready: true },
  ];
  mocks.room.state.snapshot.desiredPlaying = true;
  const wrapper = mount(TogetherDialog, { props: { open: true }, global: globals });
  expect(wrapper.text()).toContain("等待 甲 准备播放，暂不计时");
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  wrapper.unmount();
});
it("暂停与共同播放分别显示实际状态，不误报等待准备", () => {
  mocks.room.state.snapshot.members = [
    { id: "a", name: "甲", online: true, ready: true },
    { id: "b", name: "乙", online: true, ready: true },
  ];
  let wrapper = mount(TogetherDialog, { props: { open: true }, global: globals });
  expect(wrapper.text()).toContain("播放已暂停，暂不计时");
  wrapper.unmount();
  mocks.room.state.snapshot.counting = true;
  mocks.room.state.snapshot.desiredPlaying = true;
  wrapper = mount(TogetherDialog, { props: { open: true }, global: globals });
  expect(wrapper.text()).toContain("音乐正在你们之间流动");
  wrapper.unmount();
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
it("创建自建房间后自动复制邀请码并关闭模态框，避免遮挡播放器操作", async () => {
  const prevConnection = mocks.room.state.connection;
  const prevMode = mocks.room.state.mode;
  const host = vi.fn(async () => {
    mocks.room.state.mode = "self" as never;
    mocks.room.state.connection = "connected";
    mocks.room.state.invite = "splayer-together:auto-copied";
    return "splayer-together:auto-copied";
  });
  Object.assign(mocks.room, { host });
  mocks.room.state.connection = "idle";
  try {
    const wrapper = mount(TogetherDialog, {
      props: { open: true },
      global: {
        stubs: {
          ...globals.stubs,
          SInput: {
            props: ["modelValue"],
            template: '<input :value="modelValue" />',
          },
          SDivider: true,
        },
      },
    });
    await wrapper
      .findAll("button")
      .find((b) => b.text().trim() === "创建一起听")!
      .trigger("click");
    await flushPromises();
    expect(host).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledWith("splayer-together:auto-copied");
    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
    wrapper.unmount();
  } finally {
    mocks.room.state.connection = prevConnection;
    mocks.room.state.mode = prevMode;
  }
});
