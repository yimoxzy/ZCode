import { createRelayIntrospector, createZhiliuRelay } from "./index.js";

const port = Number(process.env.ZHILIU_RELAY_PORT ?? "8091");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("relay port invalid");
void createZhiliuRelay({
  host: process.env.ZHILIU_RELAY_HOST ?? "127.0.0.1",
  port,
  publicOrigin: process.env.ZHILIU_RELAY_PUBLIC_ORIGIN ?? "",
  introspect: createRelayIntrospector({
    url: process.env.ZHILIU_RELAY_AUTH_URL ?? "",
    serviceToken: process.env.ZHILIU_RELAY_SERVICE_TOKEN ?? "",
  }),
}).then(
  (relay) => {
    process.stdout.write("Zhiliu relay ready\n");
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void relay.close().then(() => process.exit(0));
      });
  },
  () => {
    process.stderr.write("Zhiliu relay startup failed\n");
    process.exitCode = 1;
  },
);
