import type { WebRemoteControlEntryView } from "#src/web-remote-control/contract.js";
export const emptyDeviceList: WebRemoteControlEntryView = {
  kind: "devices",
  devices: [],
  loading: false,
  error: false,
};

export const registeredDeviceList: WebRemoteControlEntryView = {
  kind: "devices",
  devices: [
    {
      deviceMid: "44444444-4444-4444-8444-444444444444",
      name: "My computer",
      platform: "win32",
      registered: true,
      onlineConnections: [],
    },
  ],
  loading: false,
  error: false,
};
