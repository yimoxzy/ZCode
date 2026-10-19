interface Attachment {
  dispose(): Promise<void>;
}

/** 文件端口的唯一所有者：替换串行，关闭立即使所有等待代次失效。 */
export function createZhiliuToolsAttachmentOwner<Port extends { close(): void }>(
  attach: (port: Port) => Attachment,
) {
  let active: Attachment | undefined;
  let generation = 0;
  let closed = false;
  let chain = Promise.resolve();
  let disposing: Promise<void> | undefined;
  const pending = new Set<Port>();
  const closePending = (port: Port) => {
    if (pending.delete(port)) port.close();
  };
  const invalidate = () => {
    closed = true;
    generation++;
    for (const port of pending) closePending(port);
  };
  const enqueue = (operation: () => Promise<void>) => {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  };
  const stopActive = async () => {
    const previous = active;
    active = undefined;
    await previous?.dispose();
  };
  return {
    replace(port: Port): Promise<void> {
      if (closed) {
        port.close();
        return Promise.resolve();
      }
      const epoch = ++generation;
      pending.add(port);
      return enqueue(async () => {
        try {
          await stopActive();
          // 旧连接停止期间可能又收到替换或关闭，禁止迟到接入重启心跳。
          if (closed || epoch !== generation) {
            closePending(port);
            return;
          }
          active = attach(port);
          pending.delete(port);
        } catch (error) {
          invalidate();
          throw error;
        }
      });
    },
    dispose(): Promise<void> {
      if (disposing) return disposing;
      // 必须在排队等待前关闭准入；旧清理挂起也不能接受新的文件端口。
      invalidate();
      disposing = enqueue(stopActive);
      return disposing;
    },
  };
}
