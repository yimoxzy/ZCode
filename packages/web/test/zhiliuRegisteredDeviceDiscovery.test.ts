import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebRemoteControlEntry,
  type WebRemoteControlAuthPort,
  type WebRemoteControlRegisteredDevice,
} from "#src/web-remote-control/index.js";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";

const entries: WebRemoteControlEntry[] = [];
afterEach(() => {
  for (const entry of entries.splice(0)) entry.dispose();
  vi.unstubAllGlobals();
});

const registered: WebRemoteControlRegisteredDevice = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "新登记电脑",
  platform: "win32",
};
const relay: WebRemoteControlRelayV2Device = {
  device_mid: registered.id,
  device_sid: "real-relay-sid",
  online: true,
  created_at: 1,
  meta: { name: "在线电脑", platform: "win32" },
};

function setup(managed = true) {
  let identity = "user:space-one";
  const listRegisteredDevices = vi.fn(
    async (): Promise<WebRemoteControlRegisteredDevice[]> => [registered],
  );
  const auth: WebRemoteControlAuthPort = {
    getZCodeJwtToken: () => identity,
    getSessionIdentity: () => identity,
    getActiveAccount: () => null,
    startLogin: vi.fn(),
    logout: vi.fn(async () => {}),
    ...(managed ? { listRegisteredDevices } : {}),
  };
  const devices = vi.fn(async (): Promise<WebRemoteControlRelayV2Device[]> => []);
  const connect = vi.fn();
  const token = vi.fn(async () => "one-use-token");
  const onView = vi.fn();
  const storage = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => {
    storage.set(key, value);
  });
  const entry = new WebRemoteControlEntry({
    auth,
    devices,
    connect,
    token,
    onView,
    getHref: () => "https://zhiliu.example/remote/v4",
    replaceHref: vi.fn(),
    locale: "zh-CN",
    subscribeVisible: () => () => {},
    storage: { getItem: (key) => storage.get(key) ?? null, setItem },
  });
  entries.push(entry);
  return {
    entry,
    listRegisteredDevices,
    devices,
    connect,
    token,
    onView,
    storage,
    setItem,
    changeIdentity: () => {
      identity = "user:space-two";
    },
  };
}

describe("织流已登记设备发现", () => {
  it("没有浏览器缓存或relay注册时显示登记电脑，但无SID可连接或自动连接", async () => {
    const h = setup();
    h.storage.set("zcode-web-remote-last-device-mid", registered.id);
    await h.entry.start();
    expect(h.onView).toHaveBeenLastCalledWith({
      kind: "devices",
      loading: false,
      error: false,
      devices: [
        {
          deviceMid: registered.id,
          name: registered.name,
          platform: "win32",
          registered: true,
          onlineConnections: [],
        },
      ],
    });
    h.entry.selectDevice(registered.id);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.token).not.toHaveBeenCalled();
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it("在线登记电脑合并成一行，仅保留真实SID；不持久化登记metadata", async () => {
    const h = setup();
    h.devices.mockResolvedValue([relay, { ...relay, device_sid: "old", online: false, meta: {} }]);
    await h.entry.start();
    expect(h.onView.mock.lastCall![0].devices).toEqual([
      {
        deviceMid: registered.id,
        name: "在线电脑",
        platform: "win32",
        registered: true,
        onlineConnections: [relay],
      },
    ]);
    expect(h.setItem).not.toHaveBeenCalled();
    h.entry.selectDevice("old");
    expect(h.connect).not.toHaveBeenCalled();
    h.entry.selectDevice(relay.device_sid);
    expect(h.connect.mock.lastCall![0].params.deviceSid).toBe(relay.device_sid);
  });

  it("刷新替换登记目录，撤销设备消失，旧账号缓存不能重新补行或名称", async () => {
    const h = setup();
    h.storage.set(
      "zcode-web-remote-device-names",
      JSON.stringify([[registered.id, "旧账号私有名称"]]),
    );
    await h.entry.start();
    h.listRegisteredDevices.mockResolvedValue([]);
    await h.entry.refreshDevices();
    expect(h.onView.mock.lastCall![0].devices).toEqual([]);
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it("relay离线记录用当前登记名称，不能读取旧账号缓存", async () => {
    const h = setup();
    h.storage.set(
      "zcode-web-remote-device-names",
      JSON.stringify([[registered.id, "旧账号私有名称"]]),
    );
    h.devices.mockResolvedValue([{ ...relay, online: false, meta: {} }]);
    await h.entry.start();
    expect(h.onView.mock.lastCall![0].devices[0]).toMatchObject({
      name: registered.name,
      onlineConnections: [],
    });
  });

  it("登记与relay均完成后才发布投影，500失败不提供可连接设备", async () => {
    const h = setup();
    let reject!: (error: Error) => void;
    h.devices.mockResolvedValue([relay]);
    h.listRegisteredDevices.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const pending = h.entry.start();
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    expect(h.onView.mock.lastCall![0]).toMatchObject({ loading: true, devices: [] });
    reject(new Error("unavailable"));
    await pending;
    expect(h.onView.mock.lastCall![0]).toMatchObject({ loading: false, error: true });
    h.entry.selectDevice(relay.device_sid);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it.each(["identity", "dispose"])("%s变化丢弃旧导航登记响应", async (kind) => {
    const h = setup();
    let resolve!: (devices: WebRemoteControlRegisteredDevice[]) => void;
    h.listRegisteredDevices.mockImplementationOnce(
      () =>
        new Promise((finish) => {
          resolve = finish;
        }),
    );
    const pending = h.entry.start();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    if (kind === "identity") {
      h.changeIdentity();
      h.listRegisteredDevices.mockResolvedValue([]);
      await h.entry.start();
    } else h.entry.dispose();
    const count = h.onView.mock.calls.length;
    resolve([registered]);
    await pending;
    expect(h.onView).toHaveBeenCalledTimes(count);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("原上游auth无登记端口时仅用原relay目录，不发SaaS请求", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const h = setup(false);
    h.devices.mockResolvedValue([relay]);
    await h.entry.start();
    expect(h.listRegisteredDevices).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.onView.mock.lastCall![0].devices[0]).not.toHaveProperty("registered");
  });
});
