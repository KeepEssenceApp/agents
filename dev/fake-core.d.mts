// Types for the fake, for the tests.
export interface FakeItem {
  id: string;
  kind: "link" | "text" | "image" | "file";
  title: string;
  site: string | null;
  url: string | null;
  body: string | null;
  content_unavailable: boolean;
  day: string;
  assistant: string | null;
  analysis: (Record<string, unknown> & { assistant: { id: string; name: string } }) | null;
  signal: string | null;
}
export interface FakeEvent {
  at: number;
  type: string;
  [key: string]: unknown;
}
export interface FakeCore {
  state: {
    settings: { rules: string; lang: "zh" | "en"; timezone: string; preference: string | null };
    items: Map<string, FakeItem>;
    queue: Map<
      string,
      {
        state: string;
        report: { read: string; found: string; questions: string[]; assistant: { name: string } } | null;
        entry: string | null;
        fetched_at: string | null;
      }
    >;
    digestDue: Set<string>;
    digests: Map<string, { day: string; summary: string; worth: { item_id: string; line: string }[]; question: string; assistant: { name: string } }>;
    notes: { id: string; title: string; body: string; assistant: { name: string }; origin: { item_id: string } | null }[];
    deepDives: { item_id: string }[];
    assistants: Map<string, { id: string; name: string; kind: "scheduled" | "chat"; steps: string[]; revoked: boolean }>;
    usage: { assistant: string; claim: string; model: string; input_tokens: number; output_tokens: number; calls: number }[];
    events: FakeEvent[];
  };
  addItem(item: Partial<FakeItem>): FakeItem;
  addToQueue(itemId: string): void;
  seedSample(): void;
  expireAccess(): void;
  expireClaims(): void;
  revokeAssistants(): void;
  eventsOf(type: string): FakeEvent[];
  start(port?: number): Promise<string>;
  readonly origin: string;
  stop(): Promise<void>;
}
export function createFakeCore(options?: { claimSeconds?: number; accessSeconds?: number; log?: boolean }): FakeCore;
