// The model is pluggable. Pick one with MODEL:
//   MODEL=anthropic  an Anthropic-Messages-compatible endpoint (the default)
//   MODEL=openai     an OpenAI-chat-compatible endpoint
//   MODEL=stub       no network, the same output every time; for tests and for trying the agent out
// MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME say where it is, how to get in, and which model.
import Anthropic from "@anthropic-ai/sdk";
import type { DigestContext, ItemContext, Lang, Related } from "./contract.ts";

export interface Attachment {
  mediaType: string;
  base64: string;
}

/** One request to the model. `task` and `input` are what the stub works from; real models read the texts. */
export type ModelRequest = {
  system: string;
  prompt: string;
  attachments?: Attachment[];
  lang: Lang;
} & (
  | { task: "analysis"; input: ItemContext }
  | { task: "digest"; input: DigestContext }
  | { task: "deep_read"; input: { context: ItemContext; found: Related[] } }
);

export interface ModelReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Model {
  /** Reported to the core as usage. */
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelReply>;
}

type Env = Record<string, string | undefined>;

export function modelFromEnv(env: Env = process.env): Model {
  const kind = env.MODEL ?? "anthropic";
  if (kind === "stub") return stubModel(Number(env.STUB_DELAY_MS ?? 0));
  const name = env.MODEL_NAME;
  const apiKey = env.MODEL_API_KEY;
  if (!name || !apiKey) throw new Error("Set MODEL_NAME and MODEL_API_KEY (and MODEL_BASE_URL), or MODEL=stub.");
  if (kind === "anthropic") return anthropicModel(name, apiKey, env.MODEL_BASE_URL);
  if (kind === "openai") return openAiModel(name, apiKey, env.MODEL_BASE_URL ?? "https://api.openai.com/v1");
  throw new Error(`MODEL must be anthropic, openai or stub, not ${kind}.`);
}

/** Anthropic Messages, through the official SDK. `baseUrl` is the host root, without `/v1`. */
export function anthropicModel(name: string, apiKey: string, baseUrl?: string): Model {
  const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  return {
    name,
    async complete({ system, prompt, attachments = [] }) {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const file of attachments) {
        if (file.mediaType === "application/pdf") {
          content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } });
        } else {
          const media_type = file.mediaType as Anthropic.Base64ImageSource["media_type"];
          content.push({ type: "image", source: { type: "base64", media_type, data: file.base64 } });
        }
      }
      content.push({ type: "text", text: prompt });
      const message = await client.messages.create({
        model: name,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content }],
      });
      if (message.stop_reason === "refusal") throw new Error("The model declined this content.");
      if (message.stop_reason === "max_tokens") throw new Error("The model's answer was cut off.");
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      return { text, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
    },
  };
}

/** OpenAI chat completions, as a plain request, so any compatible server works. `baseUrl` ends in `/v1`. */
export function openAiModel(name: string, apiKey: string, baseUrl: string): Model {
  return {
    name,
    async complete({ system, prompt, attachments = [] }) {
      const images = attachments.filter((file) => file.mediaType.startsWith("image/"));
      const user = images.length
        ? [
            ...images.map((file) => ({ type: "image_url", image_url: { url: `data:${file.mediaType};base64,${file.base64}` } })),
            { type: "text", text: prompt },
          ]
        : prompt;
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: name, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_SECONDS ?? 600) * 1000),
      });
      if (!response.ok) throw new Error(`The model endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = (await response.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("The model's answer was cut off.");
      return {
        text: choice?.message?.content ?? "",
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      };
    },
  };
}

/** No model at all: the answer is worked out from the input, the same every time. */
export function stubModel(delayMs = 0): Model {
  const count = (text: string) => Array.from(text).length;
  return {
    name: "stub",
    async complete(request) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const zh = request.lang === "zh";
      let answer: unknown;
      if (request.task === "analysis") {
        const { item, related = [] } = request.input;
        const text = item.body ?? item.opening ?? "";
        const length = count(text);
        const keyFact: Record<typeof item.kind, string> = {
          link: zh ? `${item.site ?? "网页"} · 约 ${length} 字` : `${item.site ?? "Web page"} · about ${length} characters`,
          text: zh ? `${length} 字` : `${length} characters`,
          image: zh ? "一张图片" : "One image",
          file: zh ? "一个文件" : "One file",
        };
        answer = {
          // Deliberately over the limits here and there, so the checks before handing back are exercised.
          summary: zh ? `这一条讲的是「${item.title}」。${"（桩）".repeat(20)}` : `This item is about “${item.title}”. ${"(stub) ".repeat(12)}`,
          key_fact: keyFact[item.kind],
          points: [1, 2, 3, 4].map((n) => (zh ? `要点 ${n}：${text.slice(0, 20)}` : `Point ${n}: ${text.slice(0, 40)}`)),
          verdict: length > 200 ? "worth_deep_dive" : length > 20 ? "good_to_know" : "skippable",
          related_hint: related[0] ? (zh ? `和「${related[0].title}」有关联。` : `Related to “${related[0].title}”.`) : "",
        };
      } else if (request.task === "digest") {
        const { analyses } = request.input;
        answer = {
          summary: zh ? `今天存入了 ${analyses.length} 条。` : `${analyses.length} items were saved today.`,
          worth: analyses.map((a) => ({ item_id: a.item_id, line: zh ? `「${a.title}」：${a.summary ?? ""}` : `“${a.title}”: ${a.summary ?? ""}` })),
          question: zh ? "今天存入的东西里，哪一条明天还想再看一眼？" : "Which of today's items would you look at again tomorrow?",
        };
      } else {
        const { context, found } = request.input;
        const text = context.item.body ?? context.item.opening ?? "";
        answer = {
          read: zh ? `「${context.item.title}」读完了。它说的是：${text.slice(0, 200)}` : `Read “${context.item.title}” in full. It says: ${text.slice(0, 200)}`,
          found: found.length
            ? found.map((f) => (zh ? `相关：「${f.title}」` : `Related: “${f.title}”`)).join("\n")
            : zh
              ? "没有查到相关的内容。"
              : "Nothing related was found.",
          questions: zh ? ["它的结论在什么条件下不成立？", "和我现在做的事有什么关系？"] : ["When does its conclusion not hold?", "How does it bear on what I am doing now?"],
        };
      }
      const text = JSON.stringify(answer);
      return { text, inputTokens: count(request.system) + count(request.prompt), outputTokens: count(text) };
    },
  };
}
