import { CONVERSATION_RESOURCES_CAPABILITY, conversationChangeDetailSchema, conversationResourcesSchema, type ConversationResources } from "@multica/core/local-conversation/resources";
import { parseWithFallback } from "@multica/core/api/schema";
import { ConversationResourcesModel } from "../models/conversation-resources-model";

export interface ConversationResourceSource {
  request(path: string): Promise<unknown>;
  capabilities(): Promise<string[]>;
  hold?(): () => void;
}

export class ConversationResourcesService {
  readonly model = new ConversationResourcesModel();
  private users = 0;
  private followed = new Set<string>();
  follow(id: string): () => void { this.followed.add(id); void this.detail(id).catch(() => {}); return () => {this.followed.delete(id);}; }
  private epoch = 0;
  private dirty = true;
  private reading?: Promise<void>;
  private detailReads = new Map<string, Promise<void>>();
  constructor(private source: ConversationResourceSource, readonly id: string) {}
  hold(): () => void {
    this.users++;
    const release = this.source.hold?.();
    if (this.dirty || !this.model.data) void this.refresh();
    return () => { this.users--; release?.(); };
  }
  dispose() { this.users = 0; this.epoch++; this.followed.clear(); this.detailReads.clear(); this.model.reset(); }
  invalidate(reset = false) {
    if (reset) { this.epoch++; this.detailReads.clear(); this.model.reset(); }
    this.dirty = true;
    if (this.users) void this.refresh();
  }
  refresh(): Promise<void> {
    if (this.reading) { this.dirty = true; return this.reading; }
    const epoch = this.epoch;
    this.reading = (async () => {
      do {
        this.dirty = false; this.model.start();
        try {
          const supported = (await this.source.capabilities()).includes(CONVERSATION_RESOURCES_CAPABILITY);
          if (epoch !== this.epoch) return;
          this.model.setSupported(supported);
          if (!supported) { this.model.fail(new Error("conversation_resources_unsupported")); return; }
          let combined: ConversationResources | undefined;
          let cursor: string | null = null;
          const seen = new Set<string>();
          do {
            const path = `/sessions/${encodeURIComponent(this.id)}/resources${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
            const raw = await this.source.request(path);
            const page = parseWithFallback<ConversationResources | null>(raw, conversationResourcesSchema.nullable(), null, { endpoint: "local-v2.resources" });
            if (!page) throw new Error("invalid_resources_response");
            if (combined && combined.revision !== page.revision) throw new Error("resources_changed");
            combined = combined ? { ...page, files: [...combined.files, ...page.files], attachments: [...combined.attachments, ...page.attachments] } : page;
            cursor = page.next_cursor;
            if (cursor && seen.has(cursor)) throw new Error("invalid_resources_cursor");
            if (cursor) seen.add(cursor);
          } while (cursor && seen.size < 100);
          if (cursor) throw new Error("resources_page_limit");
          if (epoch === this.epoch && !this.dirty && combined) { this.model.receive(combined); for (const id of this.followed) void this.detail(id).catch(() => {}); }
        } catch (error) { if (epoch === this.epoch) this.model.fail(error); }
      } while (this.dirty && this.users && epoch === this.epoch);
    })().finally(() => { this.reading = undefined; if (this.dirty && this.users) void this.refresh(); });
    return this.reading;
  }
  detail(fileId: string): Promise<void> {
    const revision = this.model.data?.revision;
    if (revision === undefined) return Promise.resolve();
    const key = `${this.epoch}:${revision}:${fileId}`;
    if (this.model.details.get(fileId)?.revision === revision) return Promise.resolve();
    const pending = this.detailReads.get(key); if (pending) return pending;
    const epoch = this.epoch;
    const read = (async () => {
      const raw = await this.source.request(`/sessions/${encodeURIComponent(this.id)}/changes/${encodeURIComponent(fileId)}?revision=${revision}`);
      const detail = parseWithFallback(raw, conversationChangeDetailSchema.nullable(), null, { endpoint: "local-v2.changes" });
      if (!detail) throw new Error("invalid_change_response");
      if (epoch === this.epoch) this.model.receiveDetail(detail);
    })().catch(error => { if (epoch === this.epoch && revision === this.model.data?.revision) this.model.fail(error); throw error; }).finally(() => this.detailReads.delete(key));
    this.detailReads.set(key, read); return read;
  }
}
