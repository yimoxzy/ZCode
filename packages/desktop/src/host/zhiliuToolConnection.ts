import { createHash, createPrivateKey, sign } from "node:crypto";
import { join } from "node:path";
import { ZhiliuExecutionJournal, type Outcome } from "./zhiliuExecutionJournal.js";
import {
  zhiliuToolRequestSchema,
  type ZhiliuHostCredential,
  type ZhiliuToolRequest,
} from "@zcode/shared";
import { WorkspaceTools, WorkspaceToolError } from "./zhiliuWorkspaceTools.js";

export interface ZhiliuToolConnectionOptions {
  origin: string;
  credential: ZhiliuHostCredential;
  privateKey: string;
  stateDirectory: string;
  workspacePath: string;
  review: (kind: "operation" | "result", title: string, detail: string) => Promise<string>;
  status: (connected: boolean, message: string) => void;
  fetch?: typeof fetch;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function zhiliuRequestDigest(row: ZhiliuToolRequest): string {
  return hash(
    canonical([
      row.id,
      row.device_id,
      row.user_id,
      row.space_id,
      row.nonce,
      row.tool,
      row.arguments,
      row.expires_at,
    ]),
  );
}
function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gu,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
      "[REDACTED TOKEN]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    );
}

/** 云 Run 拥有 Agent loop；此 adapter 只执行白名单本机文件请求，不启动第二个 Agent。 */
export class ZhiliuToolConnection {
  private stopped = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private heartbeating = false;
  private lastTimestamp = 0;
  private controller = new AbortController();
  private workspace?: WorkspaceTools;
  private journal: ZhiliuExecutionJournal;
  private key;
  private http: typeof fetch;
  constructor(private options: ZhiliuToolConnectionOptions) {
    this.key = createPrivateKey(options.privateKey);
    if (this.key.asymmetricKeyType !== "ed25519") throw new Error("Invalid device key");
    this.http = options.fetch ?? fetch;
    this.journal = new ZhiliuExecutionJournal(
      join(options.stateDirectory, options.credential.device_id),
      createHash("sha256")
        .update(`zhiliu-outbox\n${options.origin}\n${options.privateKey}`)
        .digest(),
    );
  }
  private sign(text: string) {
    return sign(null, Buffer.from(text), this.key).toString("base64");
  }
  private async api(path: string, body?: unknown) {
    if (this.stopped || Date.parse(this.options.credential.expires_at) <= Date.now())
      throw new Error("Connection expired");
    const response = await this.http(
      `${this.options.origin}/api/desktop-host/devices/${this.options.credential.device_id}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.options.credential.host_token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(12000)]),
      },
    );
    if ([401, 403, 410].includes(response.status)) {
      await this.stop();
      throw new Error("Connection authorization ended");
    }
    if (!response.ok) throw new Error(`Host API ${response.status}`);
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("Host response too large");
    return JSON.parse(raw);
  }
  async start() {
    this.workspace = await WorkspaceTools.open(this.options.workspacePath);
    if (this.stopped) {
      await this.workspace.close();
      return;
    }
    await this.journal.open();
    if (this.stopped) {
      await this.workspace.close();
      return;
    }
    await this.heartbeat();
    if (this.stopped) return;
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat().catch(() => this.options.status(false, "网络断开，暂停本机执行")),
      15000,
    );
    this.pollTimer = setInterval(
      () => void this.poll().catch(() => this.options.status(false, "等待重新连接；不会离线执行")),
      3000,
    );
    void this.poll().catch(() => this.options.status(false, "等待重新连接；不会离线执行"));
  }
  private async heartbeat() {
    if (this.heartbeating || this.stopped) return;
    this.heartbeating = true;
    try {
      await this.workspace?.assertRoot();
      const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = timestamp;
      await this.api("/heartbeat", {
        timestamp_ms: timestamp,
        workspace_ready: true,
        signature: this.sign(
          `zhiliu-host-heartbeat\n${this.options.credential.device_id}\n${timestamp}\ntrue`,
        ),
      });
      this.options.status(true, `已连接织流 · ${this.workspace?.info.name ?? "授权目录"}`);
    } finally {
      this.heartbeating = false;
    }
  }
  private validate(row: ZhiliuToolRequest, statuses: string[]) {
    const c = this.options.credential;
    if (
      this.stopped ||
      row.device_id !== c.device_id ||
      row.user_id !== c.user_id ||
      row.space_id !== c.space_id ||
      !statuses.includes(row.status) ||
      Date.parse(row.expires_at) <= Date.now()
    )
      throw new Error("Stale tool request");
    if (
      !["file_read", "file_write"].includes(row.tool) ||
      Object.keys(row.arguments).some(
        (k) => !["path", ...(row.tool === "file_write" ? ["content"] : [])].includes(k),
      ) ||
      typeof row.arguments.path !== "string" ||
      (row.tool === "file_write" && typeof row.arguments.content !== "string")
    )
      throw new Error("Unsupported file request");
  }
  private async fresh(row: ZhiliuToolRequest, statuses: string[]) {
    await this.workspace?.assertRoot();
    const value = zhiliuToolRequestSchema.parse(await this.api(`/tools/${row.id}`));
    this.validate(value, statuses);
    if (zhiliuRequestDigest(value) !== zhiliuRequestDigest(row))
      throw new Error("Tool request changed");
    return value;
  }
  private async decision(row: ZhiliuToolRequest, decision: "approved" | "rejected") {
    return this.api(`/tools/${row.id}/decision`, {
      decision,
      signature: this.sign(`${row.id}\n${row.nonce}\n${decision}`),
    });
  }
  private outcome(row: ZhiliuToolRequest, status: Outcome["status"], output: string): Outcome {
    return {
      status,
      output,
      signature: this.sign(`${row.id}\n${row.nonce}\n${status}\n${hash(output)}`),
    };
  }
  private async upload(row: ZhiliuToolRequest, digest: string, result: Outcome) {
    await this.fresh(row, ["approved"]);
    await this.api(`/tools/${row.id}/result`, result);
    await this.journal.write(row.id, { digest, stage: "done" });
  }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      // /tools 只列活跃请求；ACK 丢失后的终态必须按本地 outbox id 单独对账。
      for (const [id, entry] of this.journal.pendingResults()) {
        const row = zhiliuToolRequestSchema.parse(await this.api(`/tools/${id}`));
        if (zhiliuRequestDigest(row) !== entry.digest) throw new Error("Outbox request mismatch");
        if (
          !["pending", "approved"].includes(row.status) ||
          Date.parse(row.expires_at) <= Date.now()
        )
          await this.journal.write(id, { digest: entry.digest, stage: "done" });
        else if (entry.result) await this.upload(row, entry.digest, entry.result);
      }
      const rows: unknown = await this.api("/tools");
      if (!Array.isArray(rows)) throw new Error("Invalid tool list");
      for (const raw of rows) {
        if (this.stopped) break;
        const row = zhiliuToolRequestSchema.parse(raw);
        const digest = zhiliuRequestDigest(row),
          prior = await this.journal.read(row.id);
        if (!["pending", "approved"].includes(row.status)) {
          if (prior?.stage === "outbox")
            await this.journal.write(row.id, { digest, stage: "done" });
          continue;
        }
        this.validate(row, ["pending", "approved"]);
        if (prior) {
          if (prior.digest !== digest) throw new Error("Journal request mismatch");
          if (prior.stage === "done") continue;
          if (prior.stage === "outbox" && prior.result)
            await this.upload(row, digest, prior.result);
          else if (row.status === "pending") {
            await this.decision(row, "rejected");
            await this.journal.write(row.id, { digest, stage: "done" });
          } else
            await this.upload(
              row,
              digest,
              this.outcome(
                row,
                "failed",
                "本机执行记录不明确，为防重复操作已停止。文件可能已变更，请检查本机后重新发起任务。",
              ),
            );
          continue;
        }
        // 已批准而本机无 claim，无法证明是本实例审批，不执行。
        if (row.status !== "pending") continue;
        try {
          await this.process(row, digest);
        } catch (error) {
          if (!(error instanceof WorkspaceToolError) || (await this.journal.read(row.id)))
            throw error;
          // 不可执行路径必须终结单个请求，不能让它反复阻塞后续合法请求。
          await this.fresh(row, ["pending"]);
          await this.journal.write(row.id, { digest, stage: "claimed" }, true);
          await this.decision(row, "rejected");
          await this.journal.write(row.id, { digest, stage: "done" });
        }
      }
    } finally {
      this.polling = false;
    }
  }
  private async process(row: ZhiliuToolRequest, digest: string) {
    const workspace = this.workspace!;
    const expected = await workspace.fingerprint(row.arguments.path as string);
    const detail = `当前授权目录：${workspace.info.name}\n操作：${row.tool === "file_read" ? "读取文件" : "写入文件"}\n相对路径：${row.arguments.path}\n请求：${row.id}\n\n${row.tool === "file_write" ? `完整写入内容：\n${row.arguments.content}` : "文件内容将在本机读取，发送到云端前会再次征求确认。"}\n\n仅允许这一次。不会执行终端或鼠标键盘操作。`;
    const approved = await this.options.review("operation", "织流请求访问本机文件", detail);
    await this.fresh(row, ["pending"]);
    await this.journal.write(row.id, { digest, stage: "claimed" }, true);
    await this.decision(row, approved === "approve" ? "approved" : "rejected");
    if (approved !== "approve") {
      await this.journal.write(row.id, { digest, stage: "done" });
      return;
    }
    await this.fresh(row, ["approved"]);
    await this.journal.write(row.id, { digest, stage: "executing" });
    let output: string,
      status: Outcome["status"] = "completed";
    try {
      output =
        row.tool === "file_read"
          ? (await workspace.read(row.arguments.path as string)).content
          : JSON.stringify(
              await workspace.write(
                row.arguments.path as string,
                row.arguments.content as string,
                expected,
              ),
            );
    } catch {
      status = "failed";
      output = "本机文件操作未通过路径、内容或变更检查，已停止。请在电脑上检查文件后重试。";
    }
    const safeOutput = redact(output);
    if (Buffer.byteLength(safeOutput) > 65536) throw new Error("Result too large");
    const choice = await this.options.review(
      "result",
      "发送本机执行结果到织流",
      `状态：${status}\n相对路径：${row.arguments.path}\n\n以下是将发送到当前账号空间的完整内容（按常见凭据格式脱敏，请核对）：\n\n${safeOutput}\n\n选择只发摘要会隐藏文件内容；取消不会回滚已经发生的本机文件修改。`,
    );
    const finalOutput =
      choice === "content"
        ? safeOutput
        : `本机操作状态：${status}。用户未授权发送文件内容。${row.tool === "file_write" ? "文件可能已写入，请勿重复写入。" : "请不要假设已获取文件内容。"}`;
    const result = this.outcome(row, status, finalOutput);
    await this.fresh(row, ["approved"]);
    await this.journal.write(row.id, { digest, stage: "outbox", result });
    await this.upload(row, digest, result);
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.pollTimer);
    this.controller.abort();
    const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;
    // 先停止所有新操作，再用递增签名心跳撤掉目录就绪，迟到的旧心跳不能重新开放。
    await this.http(
      `${this.options.origin}/api/desktop-host/devices/${this.options.credential.device_id}/heartbeat`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.options.credential.host_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timestamp_ms: timestamp,
          workspace_ready: false,
          signature: this.sign(
            `zhiliu-host-heartbeat\n${this.options.credential.device_id}\n${timestamp}\nfalse`,
          ),
        }),
        signal: AbortSignal.timeout(2000),
      },
    ).catch(() => {});
    await this.workspace?.close();
    this.options.status(false, "电脑连接已停止");
  }
}
