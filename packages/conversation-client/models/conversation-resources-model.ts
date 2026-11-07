import { action, makeObservable, observable } from "mobx";
import type { ConversationChangeDetail, ConversationResources } from "@multica/core/local-conversation/resources";

/** Resource data is owned alongside its conversation, independently of transcript paging. */
export class ConversationResourcesModel {
  data: ConversationResources | null = null;
  details = new Map<string, ConversationChangeDetail>();
  loading = false;
  error = "";
  supported: boolean | null = null;
  constructor() {
    makeObservable(this, { data: observable.ref, details: observable.shallow, loading: observable, error: observable, supported: observable,
      start: action, receive: action, fail: action, setSupported: action, receiveDetail: action, reset: action });
  }
  start() { this.loading = true; this.error = ""; }
  setSupported(supported: boolean) { this.supported = supported; }
  receive(data: ConversationResources) {
    if (this.data && data.revision < this.data.revision) return;
    if (data.revision !== this.data?.revision) this.details.clear();
    this.data = data; this.loading = false; this.error = "";
  }
  receiveDetail(detail: ConversationChangeDetail) { if (detail.revision === this.data?.revision) this.details.set(detail.file.id, detail); }
  fail(error: unknown) { this.loading = false; this.error = error instanceof Error ? error.message : String(error); }
  reset() { this.data = null; this.details.clear(); this.error = ""; this.loading = false; this.supported = null; }
}
