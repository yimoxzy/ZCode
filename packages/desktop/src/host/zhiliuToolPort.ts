import { randomUUID } from "node:crypto";
import { zhiliuToolPortCommandSchema, type ZhiliuToolPortEvent } from "@zcode/shared";
import { ZhiliuToolConnection } from "./zhiliuToolConnection.js";

interface ToolPort {
  postMessage(value: ZhiliuToolPortEvent): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}
/** 只有 Main 持有此端口；不挂进通用 Renderer/remote RPC。 */
export function attachZhiliuToolPort(port: ToolPort) {
  let connection: ZhiliuToolConnection | undefined,
    closed = false,
    started = false;
  let disposal: Promise<void> | undefined;
  const reviews = new Map<string, (answer: string) => void>();
  const send = (value: ZhiliuToolPortEvent) => {
    if (!closed) port.postMessage(value);
  };
  const dispose = () => {
    if (disposal) return disposal;
    closed = true;
    disposal = (async () => {
      try {
        for (const resolve of reviews.values()) resolve("reject");
        reviews.clear();
        await connection?.stop();
      } finally {
        port.close();
      }
    })();
    return disposal;
  };
  // 事件回调不制造未处理拒绝；显式 dispose 调用仍可观察同一个停止结果。
  const halt = () => void dispose().catch(() => {});
  port.on("message", (event) => {
    // 停止先于异步收尾生效，不能让已排队的 start 在旧端口复活连接。
    if (closed) return;
    const parsed = zhiliuToolPortCommandSchema.safeParse(event.data);
    if (!parsed.success) {
      halt();
      return;
    }
    const message = parsed.data;
    if (message.type === "answer") {
      reviews.get(message.id)?.(message.answer);
      return;
    }
    if (message.type === "stop") {
      halt();
      return;
    }
    if (started) {
      halt();
      return;
    }
    started = true;
    try {
      connection = new ZhiliuToolConnection({
        ...message,
        status: (connected, text) => send({ type: "status", connected, message: text }),
        review: (kind, title, detail) =>
          closed
            ? Promise.resolve("reject")
            : new Promise((resolve) => {
                const id = randomUUID();
                const timer = setTimeout(() => {
                  reviews.delete(id);
                  resolve("reject");
                }, 180000);
                reviews.set(id, (answer) => {
                  clearTimeout(timer);
                  reviews.delete(id);
                  resolve(answer);
                });
                send({ type: "review", kind, title, detail, id });
              }),
      });
    } catch {
      send({ type: "status", connected: false, message: "设备凭据无效，请重新授权电脑" });
      halt();
      return;
    }
    void connection.start().catch(() => {
      send({
        type: "status",
        connected: false,
        message: "电脑连接失败，请重新授权或选择安全的工作目录",
      });
      halt();
    });
  });
  port.on("close", halt);
  port.start();
  return { dispose };
}
